import {
  db,
  userSettingsTable,
  userProtocolsTable,
  type UserSettings,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { getCurrentUserId } from "./user";
import { encrypt, tryDecrypt } from "./crypto";
import type { AgentLang } from "./bunny-agent";

// Local copy of normalizeAgentLang to avoid a runtime import cycle with
// bunny-agent.ts (which imports from this module). Unknown/missing → "en".
function normLang(v: unknown): AgentLang {
  return v === "zh" || v === "ko" ? v : "en";
}

// Product default UI language (mirrors interface DEFAULT_LANG in
// artifacts/interface/src/i18n/config.ts). Used when a user has no persisted
// `lang` yet, so background scanner output (recommendations/alerts) matches the
// zh-default UI they see rather than silently falling back to English.
const DEFAULT_USER_LANG: AgentLang = "zh";

// Per-user in-memory settings cache. Hydrated on-demand by the session
// middleware (and by the workflow scheduler before iterating a user). Reads
// are sync so the agent's tool-dispatch loop doesn't await per call; writes
// go to DB first, then update the cache.

interface CachedSettings {
  openrouterApiKey: string | null;
  surplusApiKey: string | null;
  veniceApiKey: string | null;
  economyosApiKey: string | null;
  moralisApiKey: string | null;
  coingeckoApiKey: string | null;
  gmgnApiKey: string | null;
  zerionApiKey: string | null;
  coinstatsApiKey: string | null;
  bunnyosJwt: string | null;
  bunnydsSessionToken: string | null;
  bunnydsSessionWallet: string | null;
  llmProvider: string;
  model: string | null;
  lang: AgentLang;
  memoryMd: string;
  baseMcpSession: unknown;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramEnabled: boolean;
  bunnyDsEnabled: boolean;
}

const DEFAULT_CACHE: CachedSettings = {
  openrouterApiKey: null,
  surplusApiKey: null,
  veniceApiKey: null,
  economyosApiKey: null,
  moralisApiKey: null,
  coingeckoApiKey: null,
  gmgnApiKey: null,
  zerionApiKey: null,
  coinstatsApiKey: null,
  bunnyosJwt: null,
  bunnydsSessionToken: null,
  bunnydsSessionWallet: null,
  llmProvider: "bunnyos",
  model: null,
  lang: DEFAULT_USER_LANG,
  memoryMd: "",
  baseMcpSession: null,
  telegramBotToken: null,
  telegramChatId: null,
  telegramEnabled: false,
  bunnyDsEnabled: true,
};

const userCache = new Map<string, CachedSettings>();
const userProtocols = new Map<string, Map<string, boolean>>();

// API keys pasted from docs sites often pick up curly quotes, NBSPs, or
// trailing whitespace. fetch() then crashes with a cryptic "ByteString"
// error because HTTP headers must be ASCII. Strip anything outside the
// printable-ASCII range and trim, at save-time, so the cache never
// contains a key that can't be sent.
function sanitizeApiKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

interface EncEnvelope {
  enc: string;
}
function isEncEnvelope(v: unknown): v is EncEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    "enc" in v &&
    typeof (v as Record<string, unknown>)["enc"] === "string" &&
    ((v as Record<string, unknown>)["enc"] as string).startsWith("enc:v1:")
  );
}
function decryptJsonbSession(raw: unknown): unknown {
  if (raw == null) return null;
  if (isEncEnvelope(raw)) {
    try {
      return JSON.parse(tryDecrypt(raw.enc) ?? "null");
    } catch (err) {
      logger.error({ err }, "failed to decrypt base_mcp_session");
      return null;
    }
  }
  return raw;
}
function encryptJsonbSession(value: unknown): EncEnvelope | null {
  if (value == null) return null;
  return { enc: encrypt(JSON.stringify(value)) };
}

function sanitizeStoredKey(v: string | null): string | null {
  if (v == null) return null;
  const clean = sanitizeApiKey(v);
  return clean === "" ? null : clean;
}

function rowToCache(row: UserSettings): CachedSettings {
  return {
    openrouterApiKey: sanitizeStoredKey(tryDecrypt(row.openrouterApiKey)),
    surplusApiKey: sanitizeStoredKey(tryDecrypt(row.surplusApiKey)),
    veniceApiKey: sanitizeStoredKey(tryDecrypt(row.veniceApiKey)),
    economyosApiKey: sanitizeStoredKey(tryDecrypt(row.economyosApiKey)),
    moralisApiKey: sanitizeStoredKey(tryDecrypt(row.moralisApiKey)),
    coingeckoApiKey: sanitizeStoredKey(tryDecrypt(row.coingeckoApiKey)),
    gmgnApiKey: sanitizeStoredKey(tryDecrypt(row.gmgnApiKey)),
    zerionApiKey: sanitizeStoredKey(tryDecrypt(row.zerionApiKey)),
    coinstatsApiKey: sanitizeStoredKey(tryDecrypt(row.coinstatsApiKey)),
    bunnyosJwt: sanitizeStoredKey(tryDecrypt(row.bunnyosJwt)),
    bunnydsSessionToken: sanitizeStoredKey(tryDecrypt(row.bunnydsSessionToken)),
    bunnydsSessionWallet: row.bunnydsSessionWallet,
    llmProvider: row.llmProvider ?? "bunnyos",
    model: row.model,
    lang: row.lang == null ? DEFAULT_USER_LANG : normLang(row.lang),
    memoryMd: row.memoryMd,
    baseMcpSession: decryptJsonbSession(row.baseMcpSession),
    telegramBotToken: sanitizeStoredKey(tryDecrypt(row.telegramBotToken)),
    telegramChatId: row.telegramChatId,
    telegramEnabled: row.telegramEnabled,
    bunnyDsEnabled: row.bunnyDsEnabled,
  };
}

const hydrating = new Map<string, Promise<void>>();
export async function hydrateUserSettings(userId: string): Promise<void> {
  if (userCache.has(userId)) return;
  const pending = hydrating.get(userId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const [row] = await db
        .select()
        .from(userSettingsTable)
        .where(eq(userSettingsTable.userId, userId))
        .limit(1);
      const protocolMap = new Map<string, boolean>();
      const rows = await db
        .select()
        .from(userProtocolsTable)
        .where(eq(userProtocolsTable.userId, userId));
      for (const r of rows) protocolMap.set(r.protocolId, r.enabled);
      userCache.set(userId, row ? rowToCache(row) : { ...DEFAULT_CACHE });
      userProtocols.set(userId, protocolMap);
      logger.info(
        {
          userId,
          hasKey: Boolean(userCache.get(userId)?.openrouterApiKey),
          protocolCount: protocolMap.size,
        },
        "settings cache hydrated",
      );
    } finally {
      hydrating.delete(userId);
    }
  })();
  hydrating.set(userId, p);
  return p;
}

function getCache(): CachedSettings {
  const userId = getCurrentUserId();
  const c = userCache.get(userId);
  if (!c) {
    throw new Error(
      `settings cache not hydrated for user ${userId} — call hydrateUserSettings() first`,
    );
  }
  return c;
}

function getProtoCache(): Map<string, boolean> {
  const userId = getCurrentUserId();
  const m = userProtocols.get(userId);
  if (!m) {
    throw new Error(`protocols cache not hydrated for user ${userId}`);
  }
  return m;
}

async function patch(values: Partial<UserSettings>): Promise<void> {
  const userId = getCurrentUserId();
  const toWrite = { ...values, updatedAt: new Date() };
  await db
    .update(userSettingsTable)
    .set(toWrite)
    .where(eq(userSettingsTable.userId, userId));
}

// ---------- OpenRouter API key ----------

export function getApiKey(): string | undefined {
  return getCache().openrouterApiKey ?? undefined;
}

export async function setApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ openrouterApiKey: encrypt(clean) });
  getCache().openrouterApiKey = clean;
}

export async function clearApiKey(): Promise<void> {
  await patch({ openrouterApiKey: null });
  getCache().openrouterApiKey = null;
}

export function isUserKey(): boolean {
  return Boolean(getCache().openrouterApiKey);
}

// ---------- Surplus Intelligence API key ----------

export function getSurplusApiKey(): string | undefined {
  return getCache().surplusApiKey ?? undefined;
}

export async function setSurplusApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ surplusApiKey: encrypt(clean) });
  getCache().surplusApiKey = clean;
}

export async function clearSurplusApiKey(): Promise<void> {
  await patch({ surplusApiKey: null });
  getCache().surplusApiKey = null;
}

export function isUserSurplusKey(): boolean {
  return Boolean(getCache().surplusApiKey);
}

// ---------- Venice API key ----------

export function getVeniceApiKey(): string | undefined {
  return getCache().veniceApiKey ?? undefined;
}

export async function setVeniceApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ veniceApiKey: encrypt(clean) });
  getCache().veniceApiKey = clean;
}

export async function clearVeniceApiKey(): Promise<void> {
  await patch({ veniceApiKey: null });
  getCache().veniceApiKey = null;
}

export function isUserVeniceKey(): boolean {
  return Boolean(getCache().veniceApiKey);
}

// ---------- EconomyOS (Virtuals compute) API key ----------
// Per-user key, with an operator-wide VIRTUALS_API_KEY env fallback so the
// provider works out-of-the-box when the operator provisions a shared key.
// `isUserEconomyosKey()` is true only for a user-pasted key (not the env one),
// which is what drives the "user-provided" vs "env" status distinction.

export function getEconomyosApiKey(): string | undefined {
  const userKey = getCache().economyosApiKey;
  if (userKey) return userKey;
  const envKey = sanitizeStoredKey(process.env.VIRTUALS_API_KEY ?? null);
  return envKey ?? undefined;
}

export async function setEconomyosApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ economyosApiKey: encrypt(clean) });
  getCache().economyosApiKey = clean;
}

export async function clearEconomyosApiKey(): Promise<void> {
  await patch({ economyosApiKey: null });
  getCache().economyosApiKey = null;
}

export function isUserEconomyosKey(): boolean {
  return Boolean(getCache().economyosApiKey);
}

// ---------- Active LLM provider ----------
// Any provider id in the llm-provider registry (default "openrouter").
// Switching providers resets the stored
// model to null so the agent falls back to the new provider's default model id
// (an OpenRouter model id is meaningless to Surplus and vice-versa).

export function getLlmProvider(): string {
  return getCache().llmProvider;
}

export async function setLlmProvider(provider: string): Promise<void> {
  await patch({ llmProvider: provider, model: null });
  const c = getCache();
  c.llmProvider = provider;
  c.model = null;
}

// ---------- Moralis API key ----------

export function getMoralisApiKey(): string | undefined {
  return getCache().moralisApiKey ?? undefined;
}

export async function setMoralisApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ moralisApiKey: encrypt(clean) });
  getCache().moralisApiKey = clean;
}

export async function clearMoralisApiKey(): Promise<void> {
  await patch({ moralisApiKey: null });
  getCache().moralisApiKey = null;
}

export function isUserMoralisKey(): boolean {
  return Boolean(getCache().moralisApiKey);
}

// ---------- CoinGecko API key ----------

export function getCoingeckoApiKey(): string | undefined {
  return getCache().coingeckoApiKey ?? undefined;
}

export async function setCoingeckoApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ coingeckoApiKey: encrypt(clean) });
  getCache().coingeckoApiKey = clean;
}

export async function clearCoingeckoApiKey(): Promise<void> {
  await patch({ coingeckoApiKey: null });
  getCache().coingeckoApiKey = null;
}

export function isUserCoingeckoKey(): boolean {
  return Boolean(getCache().coingeckoApiKey);
}

// ---------- GMGN API key ----------

export function getGmgnApiKey(): string | undefined {
  return getCache().gmgnApiKey ?? undefined;
}

export async function setGmgnApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ gmgnApiKey: encrypt(clean) });
  getCache().gmgnApiKey = clean;
}

export async function clearGmgnApiKey(): Promise<void> {
  await patch({ gmgnApiKey: null });
  getCache().gmgnApiKey = null;
}

export function isUserGmgnKey(): boolean {
  return Boolean(getCache().gmgnApiKey);
}

// ---------- Zerion API key ----------

export function getZerionApiKey(): string | undefined {
  return getCache().zerionApiKey ?? undefined;
}

export async function setZerionApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ zerionApiKey: encrypt(clean) });
  getCache().zerionApiKey = clean;
}

export async function clearZerionApiKey(): Promise<void> {
  await patch({ zerionApiKey: null });
  getCache().zerionApiKey = null;
}

export function isUserZerionKey(): boolean {
  return Boolean(getCache().zerionApiKey);
}

// ---------- CoinStats API key ----------

export function getCoinstatsApiKey(): string | undefined {
  return getCache().coinstatsApiKey ?? undefined;
}

export async function setCoinstatsApiKey(key: string): Promise<void> {
  const clean = sanitizeApiKey(key);
  await patch({ coinstatsApiKey: encrypt(clean) });
  getCache().coinstatsApiKey = clean;
}

export async function clearCoinstatsApiKey(): Promise<void> {
  await patch({ coinstatsApiKey: null });
  getCache().coinstatsApiKey = null;
}

export function isUserCoinstatsKey(): boolean {
  return Boolean(getCache().coinstatsApiKey);
}

// ---------- bunnyOS JWT ----------
// Per-user JWT minted by the bunnyOS REST API (api.bunnyos.ai) after a SIWE
// sign-in. Used read-only to enrich the on-chain bunny list with human
// name/description. Encrypted at rest, never logged.

export function getBunnyOsJwt(): string | undefined {
  return getCache().bunnyosJwt ?? undefined;
}

export async function setBunnyOsJwt(jwt: string): Promise<void> {
  const clean = jwt.trim();
  await patch({ bunnyosJwt: encrypt(clean) });
  getCache().bunnyosJwt = clean;
}

export async function clearBunnyOsJwt(): Promise<void> {
  await patch({ bunnyosJwt: null });
  getCache().bunnyosJwt = null;
}

// ---------- bunnyDS gateway wallet session token ----------
// Per-user token minted by signing a gateway-issued nonce with the user's Base
// wallet (see bunnyds-session.ts). Sent as `Authorization: Wallet <token>` on
// every gateway call. Encrypted at rest, never logged. The bound wallet is kept
// so we can detect a wallet change and force a re-mint.

export function getBunnydsSessionToken(): string | undefined {
  return getCache().bunnydsSessionToken ?? undefined;
}

export function getBunnydsSessionWallet(): string | undefined {
  return getCache().bunnydsSessionWallet ?? undefined;
}

export async function setBunnydsSession(
  token: string,
  wallet: string,
): Promise<void> {
  const cleanToken = token.trim();
  const cleanWallet = wallet.trim();
  await patch({
    bunnydsSessionToken: encrypt(cleanToken),
    bunnydsSessionWallet: cleanWallet,
  });
  getCache().bunnydsSessionToken = cleanToken;
  getCache().bunnydsSessionWallet = cleanWallet;
}

export async function clearBunnydsSession(): Promise<void> {
  await patch({ bunnydsSessionToken: null, bunnydsSessionWallet: null });
  getCache().bunnydsSessionToken = null;
  getCache().bunnydsSessionWallet = null;
}

// ---------- Model ----------

export function getStoredModel(): string | undefined {
  return getCache().model ?? undefined;
}

export async function setStoredModel(model: string): Promise<void> {
  await patch({ model });
  getCache().model = model;
}

// ---------- Protocols ----------

// Protocols the user cannot disable. `base` is the wallet itself (no
// point running bunny without it). `coingecko` is the price oracle every
// other tool implicitly depends on for USD valuation and discovery.
const REQUIRED_PROTOCOLS = new Set(["base", "coingecko"]);

// Protocols that default to OFF until the user explicitly enables them
// (the "bunny optional" group). Everything else api-sourced is "bunny core".
// `definitive` is non-custodial trade execution — off until the user opts in.
// `zerion` and `moralis` are off by default — their token/market data is
// covered by coingecko and their wallet/portfolio data overlaps; enable them
// only if you want their extra tools.
const DEFAULT_OFF_PROTOCOLS = new Set(["definitive", "zerion", "moralis"]);

export function isProtocolEnabled(id: string): boolean {
  if (REQUIRED_PROTOCOLS.has(id)) return true;
  const v = getProtoCache().get(id);
  if (v === undefined) return !DEFAULT_OFF_PROTOCOLS.has(id);
  return v;
}

// Whether a protocol ships OFF by default (used by the UI to group the
// optional services separately from the always-on bunnyOS implementation).
export function isProtocolDefaultOff(id: string): boolean {
  return DEFAULT_OFF_PROTOCOLS.has(id);
}

export async function setProtocolEnabled(id: string, enabled: boolean): Promise<void> {
  if (REQUIRED_PROTOCOLS.has(id)) {
    getProtoCache().set(id, true);
    return;
  }
  const userId = getCurrentUserId();
  await db
    .insert(userProtocolsTable)
    .values({ userId, protocolId: id, enabled })
    .onConflictDoUpdate({
      target: [userProtocolsTable.userId, userProtocolsTable.protocolId],
      set: { enabled },
    });
  getProtoCache().set(id, enabled);
}

// ---------- Markdown blobs ----------

export function getMemoryMd(): string {
  return getCache().memoryMd;
}
export async function setMemoryMd(text: string): Promise<void> {
  await patch({ memoryMd: text });
  getCache().memoryMd = text;
}

// ---------- User language preference ----------
// Persisted so background-generated output (action recommendations/alerts via
// the workflow scanner) is produced natively in the user's language. The
// browser still sends `lang` per chat/report request; this is the server-side
// source of truth for jobs that run without a request context.

export function getLang(): AgentLang {
  return getCache().lang;
}
export async function setLang(lang: AgentLang): Promise<void> {
  const clean = normLang(lang);
  await patch({ lang: clean });
  getCache().lang = clean;
}

// ---------- Base MCP oauth session blob (encrypted) ----------

export function getBaseMcpSession<T = unknown>(): T | null {
  return (getCache().baseMcpSession as T) ?? null;
}

export async function setBaseMcpSession(value: unknown): Promise<void> {
  const envelope = encryptJsonbSession(value);
  await patch({ baseMcpSession: envelope as never });
  getCache().baseMcpSession = value;
}

// ---------- Telegram notifications ----------
// Each user brings their own bot. The bot token IS a credential so it is
// encrypted at rest (same scheme as the API keys). The chat id just identifies
// the recipient and is stored plaintext. Reads are sync for the action-insert
// push path.

export function getTelegramBotToken(): string | null {
  return getCache().telegramBotToken;
}

export async function setTelegramBotToken(token: string): Promise<void> {
  const clean = sanitizeApiKey(token);
  await patch({ telegramBotToken: encrypt(clean) });
  getCache().telegramBotToken = clean;
}

export async function clearTelegramBotToken(): Promise<void> {
  await patch({ telegramBotToken: null });
  getCache().telegramBotToken = null;
}

export function getTelegramChatId(): string | null {
  return getCache().telegramChatId;
}

export async function setTelegramChatId(chatId: string | null): Promise<void> {
  const clean = chatId?.trim() || null;
  await patch({ telegramChatId: clean });
  getCache().telegramChatId = clean;
}

export function getTelegramEnabled(): boolean {
  return getCache().telegramEnabled;
}

export async function setTelegramEnabled(enabled: boolean): Promise<void> {
  await patch({ telegramEnabled: enabled });
  getCache().telegramEnabled = enabled;
}

// bunnyDS = the bunnyOS managed data + inference gateway. ON (default) routes
// data tool calls + inference through the gateway with our operator key; OFF
// falls back to the user's own keys.
export function getBunnyDsEnabled(): boolean {
  return getCache().bunnyDsEnabled;
}

export async function setBunnyDsEnabled(enabled: boolean): Promise<void> {
  await patch({ bunnyDsEnabled: enabled });
  getCache().bunnyDsEnabled = enabled;
}

// ---------- Misc ----------

export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
