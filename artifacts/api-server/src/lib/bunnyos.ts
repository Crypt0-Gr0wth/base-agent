import { getAddress } from "viem";
import { logger } from "./logger";
import { callTool, listTools, type McpTool } from "./base-mcp";
import { extractApprovalUrls } from "./bunny-agent";
import { getActiveUserId } from "./request-context";
import { getCurrentUserWallet } from "./user";
import { getBunnyOsJwt, setBunnyOsJwt, clearBunnyOsJwt } from "./settings";

// bunnyOS REST API integration. The on-chain bunny exchange only knows numeric
// id/creator/supply/price; the human name + description live behind bunnyOS's
// SIWE-gated REST API (api.bunnyos.ai). We mint a per-user JWT by reusing the
// user's existing Base MCP session to sign a SIWE challenge via the Base MCP
// `sign` approval tool — no new browser-side wallet connection. The JWT is
// stored encrypted at rest (see settings.ts) and used READ-ONLY to enrich the
// list with name/description. Per-bunny actions (feed / profile create+edit)
// are deliberately out of scope.

const BUNNYOS_API = "https://api.bunnyos.ai";
// Empirically confirmed against the live verify endpoint: chainId 1 is
// rejected ("Unexpected chain"); the Base wallet lives on Base mainnet, so the
// SIWE message must declare chain 8453 to pass the chain check.
const SIWE_CHAIN_ID = 8453;
const SIWE_DOMAIN = "bunnyos.ai";
const SIWE_URI = "https://bunnyos.ai";
const SIWE_STATEMENT = "Sign in to bunnyOS.";

// Transient, in-process scratch for an in-flight SIWE sign. Keyed by userId so
// finalize can rebuild the verify request from the exact message that was
// signed. Single-process only, matching the rest of the app's in-memory state
// (rate limits, per-user MCP clients). Short-lived: cleared on finalize.
interface PendingSign {
  requestId: string;
  message: string;
  at: number;
}
const pending = new Map<string, PendingSign>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function prunePending(): void {
  const now = Date.now();
  for (const [uid, p] of pending) {
    if (now - p.at > PENDING_TTL_MS) pending.delete(uid);
  }
}

// EIP-4361 message. Built by hand (a deterministic string) rather than pulling
// in a SIWE dep — the format was validated against the live verify endpoint.
function buildSiweMessage(address: string, nonce: string): string {
  const issuedAt = new Date().toISOString();
  return (
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:\n` +
    `${address}\n\n` +
    `${SIWE_STATEMENT}\n\n` +
    `URI: ${SIWE_URI}\n` +
    `Version: 1\n` +
    `Chain ID: ${SIWE_CHAIN_ID}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

async function fetchNonce(): Promise<string> {
  const res = await fetch(`${BUNNYOS_API}/auth/nonce`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`bunnyOS nonce request failed (${res.status})`);
  }
  const json = (await res.json()) as { nonce?: unknown };
  const nonce = typeof json.nonce === "string" ? json.nonce : "";
  if (!nonce) throw new Error("bunnyOS nonce response missing nonce");
  return nonce;
}

// Find the Base MCP message-signing tool. The exact name varies by server
// version, so resolve it from the live tool list rather than hardcoding. The
// canonical Base MCP tool is `sign` (see Base docs "Sign Messages"). Returns the
// full tool so callers can read its live inputSchema (e.g. to detect a chain
// hint param we should pass).
export async function resolveSignTool(): Promise<McpTool> {
  const tools = await listTools();
  const names = new Set(tools.map((t) => t.name.toLowerCase()));
  // Prefer the documented `sign` tool, then known aliases that share the same
  // { type, data } contract. No broad /sign/i fallback: a loose match could
  // grab an incompatible tool (e.g. signTypedData) and get the wrong arg shape.
  const candidates = ["sign", "sign_message", "personal_sign"];
  const match = candidates.find((c) => names.has(c));
  const tool = match ? tools.find((t) => t.name.toLowerCase() === match) : null;
  if (!tool) {
    throw new Error(
      "your Base wallet session doesn't expose a message-signing tool — reconnect Base and try again",
    );
  }
  return tool;
}

// ERC-6492 wrapper magic suffix. A counterfactual (not-yet-deployed) smart
// wallet signs by wrapping the inner signature with its factory + deploy
// calldata and appending this 32-byte magic value. bunnyOS's verifier handles
// EOA + ERC-1271 (deployed) signatures but NOT the ERC-6492 undeployed path.
const ERC6492_MAGIC =
  "6492649264926492649264926492649264926492649264926492649264926492";

type SigKind = "eoa" | "erc1271" | "erc6492" | "unknown";

// Classify a signature by shape so we can give an accurate diagnosis on a
// verify failure. EOA secp256k1 sigs are exactly 65 bytes (130 hex chars);
// Coinbase Smart Wallet returns a longer ERC-1271 SignatureWrapper when
// deployed, or an ERC-6492 wrapper (with the magic suffix) when counterfactual.
function classifySignature(sig: string): SigKind {
  const hex = (sig.startsWith("0x") ? sig.slice(2) : sig).toLowerCase();
  if (hex.length === 0 || !/^[0-9a-f]+$/.test(hex)) return "unknown";
  if (hex.endsWith(ERC6492_MAGIC)) return "erc6492";
  if (hex.length === 130) return "eoa";
  return "erc1271";
}

function schemaProps(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const p = (schema as Record<string, unknown>)["properties"];
  return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
}

function schemaType(propSchema: unknown): string | null {
  if (propSchema && typeof propSchema === "object") {
    const t = (propSchema as Record<string, unknown>)["type"];
    if (typeof t === "string") return t;
  }
  return null;
}

// If a schema declares a chain/network property, set it to Base (8453) on the
// target object. Returns true if any hint was applied. We respect the declared
// type: numeric chainId → 8453, string chain/network → "base".
function applyChainHints(
  schema: unknown,
  target: Record<string, unknown>,
): boolean {
  const props = schemaProps(schema);
  if (!props) return false;
  let applied = false;
  for (const [key, propSchema] of Object.entries(props)) {
    const t = schemaType(propSchema);
    if (/^chain_?id$/i.test(key)) {
      target[key] = t === "string" ? "8453" : 8453;
      applied = true;
    } else if (/^chain$/i.test(key) || /network/i.test(key)) {
      target[key] = t === "number" || t === "integer" ? 8453 : "base";
      applied = true;
    }
  }
  return applied;
}

// Build the Base MCP sign tool args. The documented contract is
// { type: "personal_sign", data: { message } } with NO chain parameter, so a
// Coinbase Smart Wallet signature isn't explicitly bound to Base by us today.
// If a server version exposes a chain/chainId/network field (at the top level or
// inside `data`), pass Base (8453) so the wallet binds the signature to Base.
// The hint is only added when the live schema actually declares the field, so it
// can't break the current strict { type, data } contract.
export function buildSignArgs(
  inputSchema: Record<string, unknown>,
  message: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = { message };
  const args: Record<string, unknown> = { type: "personal_sign", data };
  const topApplied = applyChainHints(inputSchema, args);
  const dataApplied = applyChainHints(schemaProps(inputSchema)?.["data"], data);
  if (topApplied || dataApplied) {
    logger.info(
      { chainHint: 8453 },
      "bunnyOS sign: passing Base chain hint to sign tool",
    );
  }
  return args;
}

// Pull a signature (0x hex) out of the get_request_status result content. The
// shape varies, so try JSON fields first, then any sufficiently long 0x hex.
export function extractSignature(content: string): string | null {
  try {
    const json = JSON.parse(content) as unknown;
    const found = findSignatureInJson(json);
    if (found) return found;
  } catch {
    // not JSON — fall through to regex
  }
  // A signature is a long 0x hex string. EOA sigs are 65 bytes (132 chars);
  // smart-wallet (ERC-1271/6492) sigs are longer. Require >= 130 chars to
  // avoid matching an address (42) or a tx hash (66).
  const m = content.match(/0x[0-9a-fA-F]{130,}/);
  return m ? m[0] : null;
}

function findSignatureInJson(node: unknown): string | null {
  if (typeof node === "string") {
    return /^0x[0-9a-fA-F]{130,}$/.test(node) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = findSignatureInJson(v);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["signature", "sig", "signedMessage", "result", "data"]) {
      const v = obj[key];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{130,}$/.test(v)) return v;
    }
    for (const v of Object.values(obj)) {
      const found = findSignatureInJson(v);
      if (found) return found;
    }
  }
  return null;
}

export interface BunnyOsConnectResult {
  approvalUrl: string | null;
  requestId: string | null;
  content: string;
}

// Step 1 of connect: fetch a nonce, build the SIWE message, and hand it to the
// Base MCP sign tool. Returns the wallet approval URL for the UI to surface
// (same pattern as buy/sell). The user approves the signature in their Base
// wallet, then the UI calls finalizeBunnyOs.
export async function startBunnyOsConnect(): Promise<BunnyOsConnectResult> {
  const userId = getActiveUserId();
  if (!userId) throw new Error("no active user");
  const rawWallet = await getCurrentUserWallet();
  if (!rawWallet) {
    throw new Error("no connected wallet — sign in with your Base wallet first");
  }
  const address = getAddress(rawWallet);
  const nonce = await fetchNonce();
  const message = buildSiweMessage(address, nonce);

  const signTool = await resolveSignTool();
  // Base MCP `sign` contract: { type: "personal_sign", data: { message } }.
  // The signer is the connected Base account; no address arg is passed. If the
  // live tool schema exposes a chain hint, buildSignArgs adds Base (8453) so a
  // smart-wallet signature binds to Base.
  const signArgs = buildSignArgs(signTool.inputSchema, message);
  const result = await callTool(signTool.name, signArgs);
  if (result.isError) {
    throw new Error(result.content || "sign request failed");
  }
  const approvalUrls = extractApprovalUrls(result.content);
  const approvalUrl = approvalUrls[0] ?? null;
  const requestId = approvalUrl ? extractRequestId(approvalUrl) : null;

  prunePending();
  if (requestId) {
    pending.set(userId, { requestId, message, at: Date.now() });
  } else {
    // No approval URL came back — stash the message anyway so a follow-up
    // finalize (with a client-extracted requestId) can still complete.
    pending.set(userId, { requestId: "", message, at: Date.now() });
  }
  return { approvalUrl, requestId, content: result.content };
}

export function extractRequestId(url: string): string | null {
  const m = url.match(
    /\/(?:wallet-requests|wallet-request|requests|request|calls|approve)\/([a-zA-Z0-9_-]+)/,
  );
  return m ? m[1]! : null;
}

export interface BunnyOsFinalizeResult {
  connected: boolean;
  pending: boolean;
}

// Step 2 of connect: poll the signing request. Once the signature is ready,
// POST message+signature to bunnyOS verify and store the returned JWT. If the
// signature isn't ready yet, return { pending: true } and let the UI re-poll.
export async function finalizeBunnyOsConnect(
  requestIdFromClient?: string,
): Promise<BunnyOsFinalizeResult> {
  const userId = getActiveUserId();
  if (!userId) throw new Error("no active user");
  const entry = pending.get(userId);
  if (!entry) {
    throw new Error("no pending bunnyOS sign-in — start the connect flow first");
  }
  const requestId = entry.requestId || requestIdFromClient || "";
  if (!requestId) {
    throw new Error("missing request id for the pending sign-in");
  }

  const status = await callTool("get_request_status", { requestId });
  if (status.isError) {
    throw new Error(status.content || "failed to read request status");
  }
  const signature = extractSignature(status.content);
  if (!signature) {
    return { connected: false, pending: true };
  }

  const sigKind = classifySignature(signature);
  logger.info(
    { userId, sigKind, sigLen: signature.length },
    "bunnyOS sign: signature ready, verifying",
  );
  const jwt = await verifySiwe(entry.message, signature, sigKind);
  await setBunnyOsJwt(jwt);
  pending.delete(userId);
  logger.info({ userId }, "bunnyOS connected via SIWE");
  return { connected: true, pending: false };
}

async function verifySiwe(
  message: string,
  signature: string,
  sigKind: SigKind,
): Promise<string> {
  const res = await fetch(`${BUNNYOS_API}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = "";
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof j.error === "string") detail = j.error;
      else if (typeof j.message === "string") detail = j.message;
    } catch {
      // not JSON — surface the raw body so the failure isn't opaque.
      detail = text.slice(0, 200);
    }
    // Diagnostic: sigKind + length (never the full signature) so we can tell
    // the EOA / deployed-ERC-1271 / undeployed-ERC-6492 cases apart in logs.
    logger.warn(
      {
        status: res.status,
        sigKind,
        sigLen: signature.length,
        bodyPreview: text.slice(0, 300),
        msgPreview: message.slice(0, 120),
      },
      "bunnyOS verify rejected",
    );
    // Undeployed (counterfactual) Coinbase Smart Wallet: it returns an ERC-6492
    // wrapper bunnyOS's verifier can't validate (it does EOA + deployed ERC-1271
    // only). We can't fix this from our side — the wallet has to exist on-chain
    // first. Give an accurate, actionable message instead of the raw 401.
    // Deployed smart-wallet (ERC-1271) sigs ARE verifiable; see
    // .agents/memory/bunnyos-siwe.md.
    if (res.status === 401 && sigKind === "erc6492") {
      throw new BunnyOsSignInError(
        "Your Coinbase Smart Wallet isn't active on Base yet. Make one on-chain transaction (a small swap or send) to activate it, then connect bunnyOS again.",
        "smart_wallet_undeployed",
      );
    }
    throw new BunnyOsSignInError(
      `bunnyOS sign-in failed (${res.status})${detail ? `: ${detail}` : ""}`,
      "verify_failed",
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const jwt = extractJwt(json);
  if (!jwt) throw new Error("bunnyOS verify response missing a token");
  return jwt;
}

function extractJwt(json: Record<string, unknown>): string | null {
  for (const key of ["token", "jwt", "accessToken", "access_token"]) {
    const v = json[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Some APIs nest under data/auth.
  for (const key of ["data", "auth", "result"]) {
    const v = json[key];
    if (v && typeof v === "object") {
      const nested = extractJwt(v as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

// The closed set of bunnyOS methodology classifications (see openapi.json
// `Methodology`). Exported so routes can validate the single-select value.
export const BUNNYOS_METHODOLOGIES = [
  "Human",
  "AI Agent",
  "Algorithm",
  "Robot Machine",
  "Team",
] as const;
export type BunnyOsMethodology = (typeof BUNNYOS_METHODOLOGIES)[number];

export interface BunnyOsSocials {
  x: string | null;
  discord: string | null;
  telegram: string | null;
}

// A bunny's editable profile, as owned by bunnyOS (api.bunnyos.ai). This is the
// single source of truth — the app no longer stores profiles locally. The old
// `canEdit` flag has been removed from this object by bunnyOS; edit/ownership
// capability now comes from the dedicated `/exchange/permissions` endpoint
// (see fetchPermissions / BunnyPermissions below).
export interface BunnyOsProfile {
  bunnyId: number;
  name: string | null;
  description: string | null;
  photoUrl: string | null;
  website: string | null;
  socials: BunnyOsSocials;
  methodology: BunnyOsMethodology[];
}

// Fields accepted by bunnyOS create/update. `name` is required on create; the
// rest are nullable. `socials` replaces the stored object wholesale.
export interface BunnyOsProfileInput {
  name: string;
  description: string | null;
  website: string | null;
  // Avatar URL stored on bunnyOS. The bytes live in our object storage; we send
  // bunnyOS the absolute serving URL so the photo is owned by bunnyOS (no local
  // override table). null clears the photo; undefined leaves it unchanged.
  photoUrl?: string | null;
  socials: BunnyOsSocials;
  methodology: BunnyOsMethodology[];
}

function parseMethodology(v: unknown): BunnyOsMethodology[] {
  if (!Array.isArray(v)) return [];
  const out: BunnyOsMethodology[] = [];
  for (const item of v) {
    if (
      typeof item === "string" &&
      (BUNNYOS_METHODOLOGIES as readonly string[]).includes(item)
    ) {
      out.push(item as BunnyOsMethodology);
    }
  }
  return out;
}

function parseBunnyProfile(raw: unknown): BunnyOsProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = toId(o["bunnyId"] ?? o["id"] ?? o["bunny_id"] ?? o["tokenId"]);
  if (id === null) return null;
  const socialsRaw =
    o["socials"] && typeof o["socials"] === "object"
      ? (o["socials"] as Record<string, unknown>)
      : {};
  return {
    bunnyId: id,
    name: toStr(o["name"] ?? o["displayName"] ?? o["title"]) ?? null,
    description: toStr(o["description"] ?? o["bio"] ?? o["about"]) ?? null,
    photoUrl: toStr(o["photoUrl"] ?? o["photo_url"] ?? o["avatarUrl"]) ?? null,
    website: toStr(o["website"]) ?? null,
    socials: {
      x: toStr(socialsRaw["x"] ?? socialsRaw["twitter"]) ?? null,
      discord: toStr(socialsRaw["discord"]) ?? null,
      telegram: toStr(socialsRaw["telegram"]) ?? null,
    },
    methodology: parseMethodology(o["methodology"]),
  };
}

// Fetch a single bunny's full profile from bunnyOS. Optional auth: the JWT is
// attached when present (so `canEdit` reflects ownership), but the read works
// anonymously for signed-out visitors. A 404 (bunny unknown to bunnyOS) returns
// null so callers can fall back to on-chain data.
export async function fetchBunnyProfile(
  bunnyId: number | string,
): Promise<BunnyOsProfile | null> {
  const res = await bunnyOsFetch(bunnyPath(bunnyId), false);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS request failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
    );
  }
  return parseBunnyProfile(await res.json());
}

// Fetch all bunny profiles keyed by numeric on-chain id, for list enrichment.
// Read-only, optional auth, purely additive: any failure returns an empty map so
// the on-chain list renders exactly as before for signed-out / disconnected users.
export async function fetchBunnyProfiles(): Promise<Map<number, BunnyOsProfile>> {
  const map = new Map<number, BunnyOsProfile>();
  try {
    const res = await bunnyOsFetch(`/exchange/bunnies`, false);
    if (!res.ok) {
      logger.warn({ status: res.status }, "bunnyOS profile list non-OK");
      return map;
    }
    const json = (await res.json()) as unknown;
    const arr = Array.isArray(json)
      ? json
      : json && typeof json === "object"
        ? ((json as Record<string, unknown>)["bunnies"] ??
          (json as Record<string, unknown>)["data"] ??
          (json as Record<string, unknown>)["items"])
        : null;
    if (!Array.isArray(arr)) return map;
    for (const raw of arr) {
      const p = parseBunnyProfile(raw);
      if (p) map.set(p.bunnyId, p);
    }
  } catch (err) {
    logger.warn({ err }, "bunnyOS profile list fetch failed");
  }
  return map;
}

// Create or update a bunny's profile on bunnyOS. Requires the bearer JWT;
// bunnyOS itself enforces that only the owner (or an admin) may write. Whether to
// POST (create) or PATCH (update) is decided by probing the current profile —
// bunnyOS returns a Bunny with a null name when no profile has been created yet.
export async function saveBunnyProfile(
  bunnyId: number | string,
  input: BunnyOsProfileInput,
): Promise<BunnyOsProfile> {
  if (!getBunnyOsJwt()) throw new BunnyOsNotConnectedError();
  const existing = await fetchBunnyProfile(bunnyId).catch(() => null);
  const create = !existing || !existing.name;
  return writeBunnyProfile(bunnyId, input, create);
}

async function writeBunnyProfile(
  bunnyId: number | string,
  input: BunnyOsProfileInput,
  create: boolean,
): Promise<BunnyOsProfile> {
  const jwt = getBunnyOsJwt();
  if (!jwt) throw new BunnyOsNotConnectedError();
  const body: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    website: input.website,
    socials: input.socials,
    methodology: input.methodology,
  };
  // Only forward photoUrl when the caller set it (null clears, string sets);
  // leaving it off entirely keeps bunnyOS's existing value untouched.
  if (input.photoUrl !== undefined) body.photoUrl = input.photoUrl;
  const res = await fetch(`${BUNNYOS_API}${bunnyPath(bunnyId)}`, {
    method: create ? "POST" : "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    await clearBunnyOsJwt();
    throw new BunnyOsNotConnectedError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS profile save failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = parseBunnyProfile(await res.json());
  if (!parsed) {
    throw new Error("bunnyOS profile save returned an unexpected response");
  }
  return parsed;
}

function toId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

// ---- read-only exchange data (new bunnyOS Exchange API) ------------------
// These mirror the api.bunnyos.ai/openapi.json contract. Candles / transactions
// / bunny-detail accept an optional JWT (work anonymously); pnl / portfolio-pnl
// are caller-scoped and require the JWT. All money fields come back as wei
// decimal strings — callers convert to token units with the OS token decimals.

export interface BunnyOsCandle {
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeKeys: string;
  volumeValue: string;
  tradeCount: number;
}
export interface BunnyOsCandlesResponse {
  bunnyId: string;
  interval: string;
  candles: BunnyOsCandle[];
}
export interface BunnyOsTransaction {
  pricePerKey: string;
  amount: string;
  total: string;
  timestamp: string;
  trader: string;
  side: string;
}
export interface BunnyOsTransactionsResponse {
  bunnyId: string;
  transactions: BunnyOsTransaction[];
  nextCursor: string | null;
  hasMore: boolean;
}
export interface BunnyOsPnl {
  bunnyId: string;
  balance: string;
  costBasis: string;
  realizedPnl: string;
  unrealizedPnl: string;
  totalPnl: string;
}
export interface BunnyOsPortfolioPnl {
  bunnies: BunnyOsPnl[];
  totals: {
    costBasis: string;
    realizedPnl: string;
    unrealizedPnl: string;
    totalPnl: string;
  };
}

export type CandleInterval =
  | "1m"
  | "5m"
  | "15m"
  | "1h"
  | "4h"
  | "1d"
  | "1w";

// Thrown when a JWT-required endpoint is hit without (or with an expired) JWT.
// Routes map this to a { connected: false } response rather than a hard error.
export class BunnyOsNotConnectedError extends Error {
  constructor() {
    super("not connected to bunnyOS");
    this.name = "BunnyOsNotConnectedError";
  }
}

// Thrown when the SIWE connect flow can't mint a JWT. `code` lets the route
// pass a stable, translatable reason to the client (e.g. an undeployed smart
// wallet) instead of only a raw English string.
export type BunnyOsSignInCode = "smart_wallet_undeployed" | "verify_failed";
export class BunnyOsSignInError extends Error {
  code: BunnyOsSignInCode;
  constructor(message: string, code: BunnyOsSignInCode) {
    super(message);
    this.name = "BunnyOsSignInError";
    this.code = code;
  }
}

// Shared fetch against the bunnyOS Exchange API. `requireAuth` calls throw
// BunnyOsNotConnectedError when there's no JWT; for optional-auth calls the JWT
// is attached when present but its absence is fine. A 401/403 clears the stored
// JWT (it expired) and, for required-auth calls, surfaces as not-connected; for
// optional-auth calls it retries once anonymously so reads degrade cleanly.
// Returns the raw Response so callers can inspect the status (e.g. 404 → null).
async function bunnyOsFetch(
  path: string,
  requireAuth: boolean,
): Promise<Response> {
  const jwt = getBunnyOsJwt();
  if (requireAuth && !jwt) throw new BunnyOsNotConnectedError();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  let res = await fetch(`${BUNNYOS_API}${path}`, { headers });
  if (res.status === 401 || res.status === 403) {
    await clearBunnyOsJwt();
    if (requireAuth) throw new BunnyOsNotConnectedError();
    if (jwt) {
      res = await fetch(`${BUNNYOS_API}${path}`, {
        headers: { Accept: "application/json" },
      });
    }
  }
  return res;
}

// Shared GET helper that JSON-decodes a successful bunnyOS response.
async function bunnyOsGet<T>(
  path: string,
  opts: { requireAuth: boolean } = { requireAuth: false },
): Promise<T> {
  const res = await bunnyOsFetch(path, opts.requireAuth);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS request failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

function bunnyPath(bunnyId: number | string): string {
  return `/exchange/bunnies/${encodeURIComponent(String(bunnyId))}`;
}

export async function fetchBunnyCandles(
  bunnyId: number | string,
  opts: { interval: CandleInterval; limit?: number; from?: string; to?: string; fill?: boolean },
): Promise<BunnyOsCandlesResponse> {
  const q = new URLSearchParams({ interval: opts.interval });
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.fill) q.set("fill", "true");
  return bunnyOsGet<BunnyOsCandlesResponse>(`${bunnyPath(bunnyId)}/candles?${q}`);
}

export async function fetchBunnyTransactions(
  bunnyId: number | string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<BunnyOsTransactionsResponse> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.cursor) q.set("cursor", opts.cursor);
  const qs = q.toString();
  return bunnyOsGet<BunnyOsTransactionsResponse>(
    `${bunnyPath(bunnyId)}/transactions${qs ? `?${qs}` : ""}`,
  );
}

export async function fetchBunnyPnl(bunnyId: number | string): Promise<BunnyOsPnl> {
  return bunnyOsGet<BunnyOsPnl>(`${bunnyPath(bunnyId)}/pnl`, { requireAuth: true });
}

export async function fetchPortfolioPnl(): Promise<BunnyOsPortfolioPnl> {
  return bunnyOsGet<BunnyOsPortfolioPnl>(`/exchange/portfolio/pnl`, {
    requireAuth: true,
  });
}

// ---- bunny actions (bunnyOS Exchange API) -------------------------------
// An action is either a natural-language note (`type: "body"`) or a recorded
// smart-contract call (`type: "contract_call"`, not executed on-chain by
// bunnyOS). Reads are owner/key-holder gated; writes are owner-only. All three
// require the bearer JWT.

export interface BunnyOsContractCall {
  chainId: number;
  to: string;
  function: string;
  args: unknown[];
  value: string | null;
}

export interface BunnyOsAction {
  id: string;
  bunnyId: string;
  type: "body" | "contract_call";
  body: string | null;
  contractCall: BunnyOsContractCall | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

// Discriminated input for createBunnyAction — exactly one of body /
// contractCall, matching `type`.
export type BunnyOsActionInput =
  | { type: "body"; body: string }
  | { type: "contract_call"; contractCall: BunnyOsContractCall };

// Thrown when bunnyOS returns 403 (authenticated, but the caller is not the
// owner / not a key holder). Distinct from BunnyOsNotConnectedError: the JWT is
// still valid, so it must NOT be cleared — the caller simply lacks access.
export class BunnyOsForbiddenError extends Error {
  constructor() {
    super("forbidden by bunnyOS");
    this.name = "BunnyOsForbiddenError";
  }
}

function parseContractCall(raw: unknown): BunnyOsContractCall | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const to = toStr(o["to"]);
  const fn = toStr(o["function"]);
  const chainId =
    typeof o["chainId"] === "number" ? o["chainId"] : Number(o["chainId"]);
  if (!to || !fn || !Number.isFinite(chainId)) return null;
  return {
    chainId,
    to,
    function: fn,
    args: Array.isArray(o["args"]) ? o["args"] : [],
    value: toStr(o["value"]) ?? null,
  };
}

function parseAction(raw: unknown): BunnyOsAction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = toStr(o["id"]);
  if (!id) return null;
  const type = o["type"] === "contract_call" ? "contract_call" : "body";
  return {
    id,
    bunnyId: toStr(o["bunnyId"]) ?? "",
    type,
    body: toStr(o["body"]) ?? null,
    contractCall: parseContractCall(o["contractCall"]),
    createdBy: toStr(o["createdBy"]) ?? "",
    createdAt: toStr(o["createdAt"]) ?? "",
    archivedAt: toStr(o["archivedAt"]) ?? null,
  };
}

// Shared authed fetch for the action endpoints. Unlike bunnyOsFetch it keeps
// 401 and 403 distinct: 401 clears the (expired) JWT and surfaces as
// not-connected, while 403 (valid session, no access) throws BunnyOsForbidden
// WITHOUT clearing the JWT so a non-holder isn't silently logged out.
async function bunnyOsActionFetch(
  path: string,
  init: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    body?: unknown;
  },
): Promise<Response> {
  const jwt = getBunnyOsJwt();
  if (!jwt) throw new BunnyOsNotConnectedError();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${jwt}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BUNNYOS_API}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) {
    await clearBunnyOsJwt();
    throw new BunnyOsNotConnectedError();
  }
  if (res.status === 403) throw new BunnyOsForbiddenError();
  return res;
}

// List a bunny's actions (including archived), newest first. bunnyOS restricts
// this to the owner and key holders; a 404 (bunny unknown to bunnyOS) yields an
// empty list so the on-chain detail page still renders.
export async function listBunnyActions(
  bunnyId: number | string,
): Promise<BunnyOsAction[]> {
  const res = await bunnyOsActionFetch(`${bunnyPath(bunnyId)}/actions`, {
    method: "GET",
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS actions list failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
    );
  }
  const json = (await res.json()) as unknown;
  // bunnyOS has returned the list under a few shapes over time (bare array, or
  // wrapped in actions/data/items/results), so probe each rather than assume.
  const pick = (o: Record<string, unknown>, k: string): unknown[] | null =>
    Array.isArray(o[k]) ? (o[k] as unknown[]) : null;
  let arr: unknown[] = [];
  if (Array.isArray(json)) {
    arr = json;
  } else if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    const found =
      pick(o, "actions") ??
      pick(o, "data") ??
      pick(o, "items") ??
      pick(o, "results");
    if (found) {
      // A recognized array key was present (it may legitimately be empty).
      arr = found;
    } else {
      // No recognized array shape at all — log the keys so an unexpected
      // envelope is visible instead of silently rendering "no actions yet".
      logger.warn(
        { bunnyId, keys: Object.keys(o) },
        "bunnyOS actions list: no recognized array in response",
      );
    }
  }
  const actions = arr
    .map(parseAction)
    .filter((a): a is BunnyOsAction => a !== null);
  if (arr.length > 0 && actions.length === 0) {
    // The list had entries but every one failed parseAction — almost always a
    // field-name mismatch (e.g. bunnyOS renamed `id`). Log a sample item's keys
    // so the drift is visible instead of silently rendering "no actions yet".
    const sample =
      arr[0] && typeof arr[0] === "object"
        ? Object.keys(arr[0] as Record<string, unknown>)
        : typeof arr[0];
    logger.warn(
      { bunnyId, rawCount: arr.length, sampleKeys: sample },
      "bunnyOS actions list: entries present but none parsed",
    );
  }
  actions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return actions;
}

// Post a new action. Owner-only (bunnyOS enforces); a non-owner authed caller
// gets BunnyOsForbiddenError.
export async function createBunnyAction(
  bunnyId: number | string,
  input: BunnyOsActionInput,
): Promise<BunnyOsAction> {
  const res = await bunnyOsActionFetch(`${bunnyPath(bunnyId)}/actions`, {
    method: "POST",
    body: input,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS action create failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = parseAction(await res.json());
  if (!parsed) {
    throw new Error("bunnyOS action create returned an unexpected response");
  }
  return parsed;
}

// Set (archive) or clear (reactivate) an action's archive timestamp. Owner-only;
// the action's content is immutable — only `archivedAt` may change. Pass a
// timestamp to archive, or `null` to reactivate.
export async function updateBunnyActionArchive(
  bunnyId: number | string,
  actionId: string,
  archivedAt: string | null,
): Promise<BunnyOsAction> {
  const res = await bunnyOsActionFetch(
    `${bunnyPath(bunnyId)}/actions/${encodeURIComponent(actionId)}`,
    { method: "PATCH", body: { archivedAt } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS action update failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = parseAction(await res.json());
  if (!parsed) {
    throw new Error("bunnyOS action update returned an unexpected response");
  }
  return parsed;
}

// ---- programmatic API keys -----------------------------------------------
// bunnyOS Exchange lets a connected user mint and manage their own `x-api-key`
// credentials for calling the Exchange API directly. Everything is JWT-authed
// (the SIWE session we already hold); we never persist the minted secret — it
// is returned by create/regenerate exactly once and shown client-side only.

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  revokedAt: string | null;
  revoked: boolean;
}

// The one-time create/regenerate response: an ApiKey plus the full secret.
export interface ApiKeyWithSecret extends ApiKey {
  key: string;
}

export interface CreateApiKeyInput {
  name: string;
  expiresAt?: string | null;
}

export interface UpdateApiKeyInput {
  name?: string;
  expiresAt?: string | null;
}

function parseApiKey(raw: unknown): ApiKey | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = toStr(o["id"]);
  if (!id) return null;
  return {
    id,
    name: toStr(o["name"]) ?? "",
    prefix: toStr(o["prefix"]) ?? "",
    createdAt: toStr(o["createdAt"]) ?? "",
    lastUsedAt: toStr(o["lastUsedAt"]) ?? null,
    expiresAt: toStr(o["expiresAt"]) ?? null,
    expired: o["expired"] === true,
    revokedAt: toStr(o["revokedAt"]) ?? null,
    revoked: o["revoked"] === true,
  };
}

function parseApiKeyWithSecret(raw: unknown): ApiKeyWithSecret | null {
  const base = parseApiKey(raw);
  if (!base) return null;
  const key = toStr((raw as Record<string, unknown>)["key"]);
  if (!key) return null;
  return { ...base, key };
}

// List the caller's API keys (metadata only — the secret is never returned by
// this endpoint). bunnyOS has returned arrays under a few wrapper keys over
// time, so probe each rather than assume a bare array.
export async function listApiKeys(): Promise<ApiKey[]> {
  const res = await bunnyOsActionFetch("/auth/api-keys", { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS api-keys list failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ""}`,
    );
  }
  const json = (await res.json()) as unknown;
  let arr: unknown[] = [];
  if (Array.isArray(json)) {
    arr = json;
  } else if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    const found = ["keys", "apiKeys", "data", "items", "results"]
      .map((k) => (Array.isArray(o[k]) ? (o[k] as unknown[]) : null))
      .find((v): v is unknown[] => v !== null);
    if (found) arr = found;
  }
  return arr
    .map(parseApiKey)
    .filter((k): k is ApiKey => k !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Create a key. Returns the full secret EXACTLY ONCE — callers must surface it
// to the user immediately and never persist it.
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<ApiKeyWithSecret> {
  const res = await bunnyOsActionFetch("/auth/api-keys", {
    method: "POST",
    body: input,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS api-key create failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = parseApiKeyWithSecret(await res.json());
  if (!parsed) {
    throw new Error("bunnyOS api-key create returned an unexpected response");
  }
  return parsed;
}

// Update a key's name and/or expiry. `expiresAt` future = new expiry, null =
// never expires. Returns the updated metadata (no secret).
export async function updateApiKey(
  keyId: string,
  input: UpdateApiKeyInput,
): Promise<ApiKey> {
  const res = await bunnyOsActionFetch(
    `/auth/api-keys/${encodeURIComponent(keyId)}`,
    { method: "PATCH", body: input },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS api-key update failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = parseApiKey(await res.json());
  if (!parsed) {
    throw new Error("bunnyOS api-key update returned an unexpected response");
  }
  return parsed;
}

// Revoke a key — it stops working immediately. bunnyOS may return the updated
// metadata or an empty body; either way the caller refetches the list, so a
// missing/unparseable body is tolerated (returns null).
export async function revokeApiKey(keyId: string): Promise<ApiKey | null> {
  const res = await bunnyOsActionFetch(
    `/auth/api-keys/${encodeURIComponent(keyId)}/revoke`,
    { method: "POST" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS api-key revoke failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  return parseApiKey(await res.json().catch(() => null));
}

// Regenerate a key: a new secret is issued under the same name, the old secret
// dies, and the new secret is returned EXACTLY ONCE (same handling as create).
export async function regenerateApiKey(
  keyId: string,
): Promise<ApiKeyWithSecret> {
  const res = await bunnyOsActionFetch(
    `/auth/api-keys/${encodeURIComponent(keyId)}/regenerate`,
    { method: "POST" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bunnyOS api-key regenerate failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = parseApiKeyWithSecret(await res.json());
  if (!parsed) {
    throw new Error(
      "bunnyOS api-key regenerate returned an unexpected response",
    );
  }
  return parsed;
}

// ---- permissions (advisory capability map) -------------------------------
// bunnyOS computes the caller's effective roles + capabilities per bunny and
// exposes them at GET /exchange/permissions. ADVISORY only — the server still
// enforces access on every mutating route, so these flags drive UI gating but
// are never the security boundary. Optional auth: an anonymous caller gets every
// flag false. Replaces the removed per-profile `canEdit` flag.

export interface BunnyThreadPermissions {
  isModerator: boolean;
  isBanned: boolean;
  canView: boolean;
  canPost: boolean;
  canModerate: boolean;
  moderators: { canView: boolean; canManage: boolean };
  bans: { canView: boolean; canManage: boolean };
}
export interface BunnyPermissions {
  id: string;
  roles: { isOwner: boolean; isKeyHolder: boolean };
  profile: { canEdit: boolean };
  thread: BunnyThreadPermissions;
  recommendation: { canView: boolean; canCreate: boolean; canManage: boolean };
}
export interface PermissionsResult {
  address: string | null;
  isAdmin: boolean;
  bunnies: BunnyPermissions[];
}

function asBool(v: unknown): boolean {
  return v === true;
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseBunnyPermissions(raw: unknown): BunnyPermissions | null {
  const o = asObj(raw);
  const id = toStr(o["id"]);
  if (!id) return null;
  const roles = asObj(o["roles"]);
  const profile = asObj(o["profile"]);
  const thread = asObj(o["thread"]);
  const mods = asObj(thread["moderators"]);
  const bans = asObj(thread["bans"]);
  const rec = asObj(o["recommendation"]);
  return {
    id,
    roles: {
      isOwner: asBool(roles["isOwner"]),
      isKeyHolder: asBool(roles["isKeyHolder"]),
    },
    profile: { canEdit: asBool(profile["canEdit"]) },
    thread: {
      isModerator: asBool(thread["isModerator"]),
      isBanned: asBool(thread["isBanned"]),
      canView: asBool(thread["canView"]),
      canPost: asBool(thread["canPost"]),
      canModerate: asBool(thread["canModerate"]),
      moderators: {
        canView: asBool(mods["canView"]),
        canManage: asBool(mods["canManage"]),
      },
      bans: {
        canView: asBool(bans["canView"]),
        canManage: asBool(bans["canManage"]),
      },
    },
    recommendation: {
      canView: asBool(rec["canView"]),
      canCreate: asBool(rec["canCreate"]),
      canManage: asBool(rec["canManage"]),
    },
  };
}

// Fetch the caller's capability map for the given bunny ids (max 50 per call).
// Optional auth — works anonymously (all flags false). Unknown ids are omitted
// from `bunnies`, so the result array may be shorter than the request.
export async function fetchPermissions(
  bunnyIds: (number | string)[],
): Promise<PermissionsResult> {
  const ids = bunnyIds
    .map((id) => String(id))
    .filter((s) => s.length > 0)
    .slice(0, 50);
  const q = new URLSearchParams();
  for (const id of ids) q.append("bunnyId", id);
  const raw = await bunnyOsGet<unknown>(
    `/exchange/permissions?${q.toString()}`,
    { requireAuth: false },
  );
  const o = asObj(raw);
  const bunnies = Array.isArray(o["bunnies"])
    ? (o["bunnies"] as unknown[])
        .map(parseBunnyPermissions)
        .filter((b): b is BunnyPermissions => b !== null)
    : [];
  return {
    address: toStr(o["address"]) ?? null,
    isAdmin: asBool(o["isAdmin"]),
    bunnies,
  };
}

type BunnyPermissionsResult = {
  isAdmin: boolean;
  address: string | null;
  perms: BunnyPermissions | null;
};

// True when a live bunnyOS call succeeds (HTTP 200). Any failure — no session,
// 401, 403 (BunnyOsForbiddenError), 404, or a transport error — counts as "no
// access". Used to read authorization off the authoritative endpoints.
async function probeAccess(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

// Best-effort capability map derived from the AUTHORITATIVE live thread
// endpoints, for when the advisory /exchange/permissions endpoint is
// unavailable (it currently isn't deployed on api.bunnyos.ai — the path falls
// through to the web SPA and returns HTML, which fails JSON parsing). Each
// endpoint's HTTP status is the real authorization boundary, so a bunnyOS-
// recognized viewer / key holder / owner / admin is correctly let through
// instead of being failed closed to "no access".
async function deriveBunnyPermissions(
  bunnyId: number | string,
): Promise<BunnyPermissionsResult> {
  // No session at all — nothing is viewable; mirror the anonymous all-false map.
  if (!getBunnyOsJwt()) {
    return { isAdmin: false, address: null, perms: null };
  }
  // Probe in parallel. Listing posts requires view (holder/owner/admin), listing
  // moderators is owner/admin-only, listing bans is moderator/owner/admin.
  const [canView, canManageMods, canManageBans] = await Promise.all([
    probeAccess(() => listThreadPosts(bunnyId, { limit: 1 })),
    probeAccess(() => listThreadModerators(bunnyId)),
    probeAccess(() => listThreadBans(bunnyId)),
  ]);
  const canModerate = canManageMods || canManageBans;
  if (!canView && !canModerate) {
    // Connected but no access anywhere — locked, same as the all-false map.
    return { isAdmin: false, address: null, perms: null };
  }
  const address = await getCurrentUserWallet().catch(() => null);
  const perms: BunnyPermissions = {
    id: String(bunnyId),
    roles: { isOwner: false, isKeyHolder: canView },
    // Listing moderators is owner/admin-only, so it doubles as "can edit profile".
    profile: { canEdit: canManageMods },
    thread: {
      isModerator: canModerate,
      isBanned: false,
      canView,
      canPost: canView,
      canModerate,
      moderators: { canView: canManageMods, canManage: canManageMods },
      bans: { canView: canManageBans, canManage: canManageBans },
    },
    recommendation: {
      canView,
      canCreate: canModerate,
      canManage: canModerate,
    },
  };
  return { isAdmin: false, address, perms };
}

// Convenience: the capability map for a single bunny plus the global admin flag.
// Prefers the advisory /exchange/permissions endpoint; when that is unavailable
// (not deployed / non-JSON / transport error) it derives a best-effort map from
// the live thread endpoints so gating doesn't fail closed for legitimate
// viewers, holders, owners and admins. Self-healing: once bunnyOS ships the
// advisory endpoint, the first branch succeeds and the derive path never runs.
// Returns perms=null when the caller genuinely has no access (locked) rather
// than throwing.
export async function fetchBunnyPermissions(
  bunnyId: number | string,
): Promise<BunnyPermissionsResult> {
  try {
    const res = await fetchPermissions([bunnyId]);
    const perms = res.bunnies.find((b) => b.id === String(bunnyId)) ?? null;
    return { isAdmin: res.isAdmin, address: res.address, perms };
  } catch {
    return deriveBunnyPermissions(bunnyId).catch(() => ({
      isAdmin: false,
      address: null,
      perms: null,
    }));
  }
}

// ---- threads (bunnyOS-hosted community forum) ----------------------------
// bunnyOS owns the whole forum: posts, nested comments, up/down votes, plus
// per-bunny moderators and bans. All endpoints require the bearer JWT and are
// key-holder gated (the owner + admins always pass); a non-holder gets a 403
// (BunnyOsForbiddenError). Deleted posts/comments come back as tombstones
// (title/body blanked, deleted=true) so reply chains keep their shape.

export type ThreadSort = "new" | "top";
export type ViewerVote = "up" | "down" | null;
export type ThreadVoteDirection = "up" | "down";

export interface ThreadPost {
  id: string;
  bunnyId: string;
  title: string;
  body: string;
  createdBy: string;
  createdAt: string;
  deleted: boolean;
  deletedAt: string | null;
  score: number;
  commentCount: number;
  viewerVote: ViewerVote;
}
export interface ThreadComment {
  id: string;
  bunnyId: string;
  postId: string;
  parentCommentId: string | null;
  body: string;
  createdBy: string;
  createdAt: string;
  deleted: boolean;
  deletedAt: string | null;
  score: number;
  viewerVote: ViewerVote;
}
export interface ThreadModerator {
  bunnyId: string;
  address: string;
  createdBy: string;
  createdAt: string;
}
export interface ThreadBan {
  bunnyId: string;
  address: string;
  createdBy: string;
  createdAt: string;
}

function asViewerVote(v: unknown): ViewerVote {
  return v === "up" || v === "down" ? v : null;
}
function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function parseThreadPost(raw: unknown): ThreadPost | null {
  const o = asObj(raw);
  const id = toStr(o["id"]);
  if (!id) return null;
  return {
    id,
    bunnyId: toStr(o["bunnyId"]) ?? "",
    title: asText(o["title"]),
    body: asText(o["body"]),
    createdBy: toStr(o["createdBy"]) ?? "",
    createdAt: toStr(o["createdAt"]) ?? "",
    deleted: asBool(o["deleted"]),
    deletedAt: toStr(o["deletedAt"]) ?? null,
    score: asNum(o["score"]),
    commentCount: asNum(o["commentCount"]),
    viewerVote: asViewerVote(o["viewerVote"]),
  };
}
function parseThreadComment(raw: unknown): ThreadComment | null {
  const o = asObj(raw);
  const id = toStr(o["id"]);
  if (!id) return null;
  return {
    id,
    bunnyId: toStr(o["bunnyId"]) ?? "",
    postId: toStr(o["postId"]) ?? "",
    parentCommentId: toStr(o["parentCommentId"]) ?? null,
    body: asText(o["body"]),
    createdBy: toStr(o["createdBy"]) ?? "",
    createdAt: toStr(o["createdAt"]) ?? "",
    deleted: asBool(o["deleted"]),
    deletedAt: toStr(o["deletedAt"]) ?? null,
    score: asNum(o["score"]),
    viewerVote: asViewerVote(o["viewerVote"]),
  };
}
function parseModerator(raw: unknown): ThreadModerator | null {
  const o = asObj(raw);
  const address = toStr(o["address"]);
  if (!address) return null;
  return {
    bunnyId: toStr(o["bunnyId"]) ?? "",
    address,
    createdBy: toStr(o["createdBy"]) ?? "",
    createdAt: toStr(o["createdAt"]) ?? "",
  };
}
function parseBan(raw: unknown): ThreadBan | null {
  const o = asObj(raw);
  const address = toStr(o["address"]);
  if (!address) return null;
  return {
    bunnyId: toStr(o["bunnyId"]) ?? "",
    address,
    createdBy: toStr(o["createdBy"]) ?? "",
    createdAt: toStr(o["createdAt"]) ?? "",
  };
}

// Shared helper: run an authed thread request and JSON-decode it, turning a
// non-OK status into a descriptive error. 401/403 are already mapped to
// BunnyOsNotConnectedError / BunnyOsForbiddenError by bunnyOsActionFetch.
async function threadRequest<T>(
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
  parse: (raw: unknown) => T,
): Promise<T> {
  const res = await bunnyOsActionFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn(
      { path, method: init.method, status: res.status, body: text.slice(0, 300) },
      "bunnyOS thread request non-OK",
    );
    throw new Error(
      `bunnyOS thread request failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const raw = res.status === 204 ? "" : await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  try {
    return parse(json);
  } catch (err) {
    // Surface the actual response shape so a parse mismatch (e.g. an
    // unexpected envelope) is diagnosable from the logs instead of an opaque
    // 502 the client can't see.
    logger.warn(
      {
        path,
        method: init.method,
        status: res.status,
        bodySnippet: raw.slice(0, 500),
        error: err instanceof Error ? err.message : String(err),
      },
      "bunnyOS thread response parse failed",
    );
    throw err;
  }
}

const threadsPath = (bunnyId: number | string): string =>
  `${bunnyPath(bunnyId)}/threads`;

function expectPost(raw: unknown): ThreadPost {
  const p = parseThreadPost(raw);
  if (!p) throw new Error("bunnyOS returned an unexpected post");
  return p;
}
// The single-post GET wraps the post in an envelope (observed shapes over time:
// `{ post }`, `{ data }`, `{ thread }`, `{ result }`) whereas the
// create/delete/vote endpoints return the bare post. Probe the bare object
// first, then each known wrapper key, and only then fail — with the observed
// top-level keys in the message so an unrecognized envelope surfaces in the 502
// body instead of an opaque "unexpected post".
function unwrapPost(raw: unknown): ThreadPost {
  const bare = parseThreadPost(raw);
  if (bare) return bare;
  const o = asObj(raw);
  for (const key of ["post", "data", "thread", "result"]) {
    const nested = parseThreadPost(o[key]);
    if (nested) return nested;
  }
  throw new Error(
    `bunnyOS returned an unexpected post (keys: ${Object.keys(o).join(",") || "none"})`,
  );
}
function expectComment(raw: unknown): ThreadComment {
  const c = parseThreadComment(raw);
  if (!c) throw new Error("bunnyOS returned an unexpected comment");
  return c;
}

export async function listThreadPosts(
  bunnyId: number | string,
  opts: { sort?: ThreadSort; limit?: number; offset?: number } = {},
): Promise<{ posts: ThreadPost[]; total: number }> {
  const q = new URLSearchParams();
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.offset) q.set("offset", String(opts.offset));
  const qs = q.toString();
  return threadRequest(
    `${threadsPath(bunnyId)}/posts${qs ? `?${qs}` : ""}`,
    { method: "GET" },
    (raw) => {
      const o = asObj(raw);
      const posts = Array.isArray(o["posts"])
        ? (o["posts"] as unknown[])
            .map(parseThreadPost)
            .filter((p): p is ThreadPost => p !== null)
        : [];
      return { posts, total: asNum(o["total"]) };
    },
  );
}

export async function getThreadPost(
  bunnyId: number | string,
  postId: string,
): Promise<ThreadPost> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}`,
    { method: "GET" },
    unwrapPost,
  );
}

export async function createThreadPost(
  bunnyId: number | string,
  input: { title: string; body: string },
): Promise<ThreadPost> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts`,
    { method: "POST", body: input },
    expectPost,
  );
}

export async function deleteThreadPost(
  bunnyId: number | string,
  postId: string,
): Promise<ThreadPost> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}`,
    { method: "DELETE" },
    expectPost,
  );
}

export async function listPostComments(
  bunnyId: number | string,
  postId: string,
  opts: { sort?: ThreadSort; limit?: number; offset?: number } = {},
): Promise<{ comments: ThreadComment[]; total: number }> {
  const q = new URLSearchParams();
  if (opts.sort) q.set("sort", opts.sort);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.offset) q.set("offset", String(opts.offset));
  const qs = q.toString();
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/comments${qs ? `?${qs}` : ""}`,
    { method: "GET" },
    (raw) => {
      const o = asObj(raw);
      const comments = Array.isArray(o["comments"])
        ? (o["comments"] as unknown[])
            .map(parseThreadComment)
            .filter((c): c is ThreadComment => c !== null)
        : [];
      return { comments, total: asNum(o["total"]) };
    },
  );
}

export async function createPostComment(
  bunnyId: number | string,
  postId: string,
  input: { body: string; parentCommentId?: string | null },
): Promise<ThreadComment> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/comments`,
    { method: "POST", body: input },
    expectComment,
  );
}

export async function deletePostComment(
  bunnyId: number | string,
  postId: string,
  commentId: string,
): Promise<ThreadComment> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
    expectComment,
  );
}

export async function setPostVote(
  bunnyId: number | string,
  postId: string,
  direction: ThreadVoteDirection,
): Promise<ThreadPost> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/vote`,
    { method: "PUT", body: { direction } },
    expectPost,
  );
}

export async function clearPostVote(
  bunnyId: number | string,
  postId: string,
): Promise<ThreadPost> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/vote`,
    { method: "DELETE" },
    expectPost,
  );
}

export async function setCommentVote(
  bunnyId: number | string,
  postId: string,
  commentId: string,
  direction: ThreadVoteDirection,
): Promise<ThreadComment> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/vote`,
    { method: "PUT", body: { direction } },
    expectComment,
  );
}

export async function clearCommentVote(
  bunnyId: number | string,
  postId: string,
  commentId: string,
): Promise<ThreadComment> {
  return threadRequest(
    `${threadsPath(bunnyId)}/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/vote`,
    { method: "DELETE" },
    expectComment,
  );
}

export async function listThreadModerators(
  bunnyId: number | string,
): Promise<ThreadModerator[]> {
  return threadRequest(
    `${threadsPath(bunnyId)}/moderators`,
    { method: "GET" },
    (raw) => {
      const o = asObj(raw);
      return Array.isArray(o["moderators"])
        ? (o["moderators"] as unknown[])
            .map(parseModerator)
            .filter((m): m is ThreadModerator => m !== null)
        : [];
    },
  );
}

export async function promoteThreadModerator(
  bunnyId: number | string,
  address: string,
): Promise<ThreadModerator | null> {
  return threadRequest(
    `${threadsPath(bunnyId)}/moderators/${encodeURIComponent(address)}`,
    { method: "PUT" },
    parseModerator,
  );
}

export async function demoteThreadModerator(
  bunnyId: number | string,
  address: string,
): Promise<void> {
  await threadRequest(
    `${threadsPath(bunnyId)}/moderators/${encodeURIComponent(address)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

export async function listThreadBans(
  bunnyId: number | string,
): Promise<ThreadBan[]> {
  return threadRequest(
    `${threadsPath(bunnyId)}/bans`,
    { method: "GET" },
    (raw) => {
      const o = asObj(raw);
      return Array.isArray(o["bans"])
        ? (o["bans"] as unknown[])
            .map(parseBan)
            .filter((b): b is ThreadBan => b !== null)
        : [];
    },
  );
}

export async function banThreadUser(
  bunnyId: number | string,
  address: string,
): Promise<ThreadBan | null> {
  return threadRequest(
    `${threadsPath(bunnyId)}/bans/${encodeURIComponent(address)}`,
    { method: "PUT" },
    parseBan,
  );
}

export async function unbanThreadUser(
  bunnyId: number | string,
  address: string,
): Promise<void> {
  await threadRequest(
    `${threadsPath(bunnyId)}/bans/${encodeURIComponent(address)}`,
    { method: "DELETE" },
    () => undefined,
  );
}

export function bunnyOsStatus(): { connected: boolean } {
  return { connected: Boolean(getBunnyOsJwt()) };
}

export async function disconnectBunnyOs(): Promise<void> {
  const userId = getActiveUserId();
  if (userId) pending.delete(userId);
  await clearBunnyOsJwt();
}
