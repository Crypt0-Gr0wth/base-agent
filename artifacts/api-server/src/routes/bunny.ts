import { Router, type IRouter, type Response } from "express";
import { z } from "zod/v4";
import { formatUnits } from "viem";
import { eq } from "drizzle-orm";
import { db, bunnyRecommendationExecutionsTable } from "@workspace/db";
import { take } from "../lib/rate-limit";
import {
  getCurrentUserId,
  getCurrentUserWallet,
  getUserIdByWallet,
  isAdminWallet,
} from "../lib/user";
import { listPushedActionsForUser } from "../lib/actions";
import { screenAction } from "../lib/action-security";
import { ObjectStorageService } from "../lib/objectStorage";
import { getActiveRequestOrigin } from "../lib/request-context";
import { resolvePublicBaseUrl } from "../lib/app-meta";
import { callTool } from "../lib/base-mcp";
import { extractApprovalUrls } from "../lib/bunny-agent";
import {
  getExchangeConfig,
  listBunnies,
  quoteBuy,
  quoteSell,
  quoteCreate,
  buildBuyCalls,
  buildSellCalls,
  buildCreateCalls,
  buildActivateCalls,
  isWalletDeployed,
  getBondingCurve,
  getBunnyCreator,
  getKeyBalance,
  getBuyFunds,
} from "../lib/bunny-exchange";
import {
  startBunnyOsConnect,
  finalizeBunnyOsConnect,
  fetchBunnyProfile,
  fetchBunnyProfiles,
  saveBunnyProfile,
  bunnyOsStatus,
  disconnectBunnyOs,
  fetchBunnyCandles,
  fetchBunnyTransactions,
  fetchBunnyPnl,
  fetchPortfolioPnl,
  listBunnyActions,
  createBunnyAction,
  updateBunnyActionArchive,
  listApiKeys,
  createApiKey,
  updateApiKey,
  revokeApiKey,
  regenerateApiKey,
  fetchPermissions,
  fetchBunnyPermissions,
  listThreadPosts,
  getThreadPost,
  createThreadPost,
  deleteThreadPost,
  listPostComments,
  createPostComment,
  deletePostComment,
  setPostVote,
  clearPostVote,
  setCommentVote,
  clearCommentVote,
  listThreadModerators,
  promoteThreadModerator,
  demoteThreadModerator,
  listThreadBans,
  banThreadUser,
  unbanThreadUser,
  BunnyOsNotConnectedError,
  BunnyOsForbiddenError,
  BunnyOsSignInError,
  BUNNYOS_METHODOLOGIES,
  type BunnyOsMethodology,
  type BunnyOsAction,
  type BunnyOsActionInput,
  type BunnyPermissions,
  type ThreadComment,
  type ThreadSort,
  type ThreadVoteDirection,
  type CandleInterval,
} from "../lib/bunnyos";
import { getCoinGeckoTokenPriceUsd } from "../lib/coingecko";

// Native read + execute surface for the bunny exchange (friend.tech-style keys
// market settled in the bunnyOS OS token). Reads come from a viem public client
// over Base RPC; the buy is built as unsigned calldata and forwarded into Base
// MCP `send_calls` — bunny never holds a key or broadcasts. This is a core app
// feature, not a gated protocol, so there's no isProtocolEnabled guard.
const router: IRouter = Router();

function parsePositiveInt(v: unknown): bigint | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  if (!/^\d+$/.test(s)) return null;
  try {
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

// Like parsePositiveInt but allows 0 (used for createBunny's optional
// additionalBuyAmount, where 0 means "registration only, no extra keys").
function parseNonNegInt(v: unknown): bigint | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  if (!/^\d+$/.test(s)) return null;
  try {
    const n = BigInt(s);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

// GET /api/bunny/config — static exchange config (token, fees, floor, caps).
router.get("/bunny/config", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    res.json(await getExchangeConfig());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/os-price — public USD price of the OS payment token. No auth
// (runs under the local-user context the session middleware sets for public
// paths) so the landing page can show "$OS $price" before anyone connects.
// Best-effort with a hard timeout; returns { priceUsd: null } when market data
// is unavailable instead of erroring.
router.get("/bunny/os-price", async (_req, res): Promise<void> => {
  try {
    const config = await getExchangeConfig();
    const priceUsd = await Promise.race([
      getCoinGeckoTokenPriceUsd(config.paymentToken).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    res.json({ priceUsd, symbol: config.tokenSymbol });
  } catch {
    res.json({ priceUsd: null, symbol: null });
  }
});

// GET /api/bunny/list — every existing bunny with current supply + all-in buy
// price for one key, plus the caller's key balance per bunny when connected.
router.get("/bunny/list", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const wallet = await getCurrentUserWallet();
    const result = await listBunnies(wallet);
    // Purely additive bunnyOS profile enrichment (name/bio/photo/socials/
    // methodology/canEdit). Reads work anonymously, so the list still renders
    // for signed-out visitors; any failure returns an empty map and the
    // on-chain list renders exactly as before.
    const profiles = await fetchBunnyProfiles();
    const bunnies = result.bunnies.map((b) => {
      const profile = profiles.get(b.id) ?? null;
      return {
        ...b,
        name: profile?.name ?? undefined,
        description: profile?.description ?? undefined,
        profile,
      };
    });
    // USD price of the OS payment token (best-effort, never blocks the list).
    // Lets the UI show "$OS" and ~USD approximations next to OS amounts. Hard
    // 1.2s timeout + null fallback so a slow/uncached CoinGecko call can never
    // delay the on-chain list; the price is cached so subsequent loads are warm.
    const osPriceUsd = await Promise.race([
      getCoinGeckoTokenPriceUsd(result.config.paymentToken).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
    res.json({
      ...result,
      bunnies,
      bunnyos: bunnyOsStatus(),
      isAdmin: isAdminWallet(wallet),
      osPriceUsd,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/unregistered — bunnies the signed-in user created on-chain
// (creator == their wallet) that have no bunnyOS profile yet. Powers the
// "register existing" branch of the add-bunny flow: a user can attach a bunnyOS
// profile to an on-chain bunny that was launched without one. Requires a
// connected wallet. A bunny counts as "registered" once bunnyOS returns a
// non-empty name for it, so those are filtered out and never offered.
//
// Static single-segment path — defined before the `/bunny/:id/*` routes so it
// can never be captured as an :id.
router.get("/bunny/unregistered", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res
      .status(409)
      .json({ error: "no connected wallet — sign in with your Base wallet first" });
    return;
  }
  try {
    const lower = wallet.toLowerCase();
    const [{ config, bunnies }, profiles] = await Promise.all([
      listBunnies(wallet),
      fetchBunnyProfiles(),
    ]);
    const unregistered = bunnies.filter((b) => {
      if (b.creator.toLowerCase() !== lower) return false;
      const profile = profiles.get(b.id);
      return !profile || !profile.name;
    });
    res.json({ config, bunnies: unregistered });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Recommendations older than this are dropped from the inbox so an un-archived,
// never-executed rec doesn't linger forever.
const RECOMMENDATION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// GET /api/bunny/recommendations — the caller's recommendation feed aggregated
// across every bunny they hold keys in (balance > 0) plus bunnies they created.
// bunnyOS has no cross-bunny feed and per-bunny action reads are owner/holder
// gated, so we resolve the held/owned set from the on-chain list and fan out a
// per-bunny live read. Authenticated only (the global /api/* session middleware
// 401s anonymous callers; the inbox treats any non-OK as an empty list and just
// renders its empty hint). When authed-but-bunnyOS-disconnected or no wallet, we
// return an empty list rather than erroring. These ids live in bunnyOS, not the
// local actions table; body-type recs can be executed (POST .../execute records
// a per-user done flag, filtered out below), contract-call recs are display-only.
//
// Defined before the `/bunny/:id/*` routes so "recommendations" can never be
// captured as an :id.
router.get("/bunny/recommendations", async (req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    // No live bunnyOS session → nothing to read; return empty so the section
    // renders its empty hint rather than an error.
    if (!bunnyOsStatus().connected) {
      res.json({ recommendations: [] });
      return;
    }
    const wallet = await getCurrentUserWallet();
    if (!wallet) {
      res.json({ recommendations: [] });
      return;
    }
    const { bunnies } = await listBunnies(wallet);
    // TEMPORARY: surface recommendations from EVERY bunny, not just the ones the
    // caller holds keys in or created. bunnyOS still gates each per-bunny action
    // read server-side, and the fan-out below degrades (Forbidden/NotConnected →
    // empty) for any bunny the caller can't read — so this only ever shows
    // actions bunnyOS authorizes for this wallet (which includes bunnies the
    // caller manages as a bunnyOS admin/owner without holding keys). Restore the
    // held/owned filter below to revert.
    const mine = bunnies;
    if (mine.length === 0) {
      res.json({ recommendations: [] });
      return;
    }
    const profiles = await fetchBunnyProfiles();

    // Fan out a per-bunny live read. Degrade per-bunny: a single bunny's
    // failure (403 non-holder, bunnyOS hiccup) must not sink the whole feed.
    const perBunny = await Promise.all(
      mine.map(async (b) => {
        try {
          const actions = await listBunnyActions(b.id);
          return { bunny: b, actions };
        } catch (err) {
          // Degrade per-bunny: one bunny's failure (expired session, 403
          // non-holder, transient 5xx, parse drift, network error) must never
          // sink the whole feed. Treat ANY failure as no data for that bunny.
          // NotConnected/Forbidden are expected and logged quietly; anything
          // else is unexpected, so log it at warn for visibility.
          if (
            !(err instanceof BunnyOsNotConnectedError) &&
            !(err instanceof BunnyOsForbiddenError)
          ) {
            req.log.warn(
              { bunnyId: b.id, err },
              "recommendations: per-bunny actions read failed",
            );
          }
          return { bunny: b, actions: [] as BunnyOsAction[] };
        }
      }),
    );

    // Per-user "already executed" set — these were executed from the inbox and
    // must not reappear (the from-bunnies feed has no local row to flip, so we
    // filter against this table). Keyed by the inbox id ("bunnyos:<actionId>").
    const executedRows = await db
      .select({ id: bunnyRecommendationExecutionsTable.recommendationId })
      .from(bunnyRecommendationExecutionsTable)
      .where(eq(bunnyRecommendationExecutionsTable.userId, getCurrentUserId()));
    const executed = new Set(executedRows.map((r) => r.id));

    // Age cap: only surface recs created within the last 3 days. Without this an
    // un-archived, never-executed rec would show in the inbox forever.
    const cutoff = Date.now() - RECOMMENDATION_MAX_AGE_MS;
    const isFresh = (createdAt: string): boolean => {
      const t = Date.parse(createdAt);
      // Unparseable/empty timestamp → keep it rather than silently dropping.
      return Number.isNaN(t) ? true : t >= cutoff;
    };

    const recommendations = perBunny
      .flatMap(({ bunny, actions }) => {
        const profile = profiles.get(bunny.id) ?? null;
        const source = profile?.name?.trim() || `bunny #${bunny.id}`;
        return actions
          .filter((a) => !a.archivedAt && isFresh(a.createdAt))
          .map((a) => recommendationItem(a, source))
          .filter((r) => {
            const screen = screenAction({
              kind: r.kind,
              title: r.title,
              executeInstructions: r.executeInstructions,
            });
            if (!screen.allowed) {
              req.log.warn(
                { id: r.id, source: r.source, reason: screen.reason },
                "bunny recommendation blocked by security filter",
              );
            }
            return screen.allowed;
          });
      })
      .filter((r) => !executed.has(r.id))
      .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));

    res.json({ recommendations });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/bunny/recommendations/:id/execute — mark a from-bunnies
// recommendation as executed for the caller. The from-bunnies feed lives in
// bunnyOS, so there is no local actions row to flip; instead we record the
// inbox id ("bunnyos:<actionId>") per user so the item disappears from the feed
// on the next read. The actual "execution" is purely client-side (the body text
// is pasted into the chat composer) — this endpoint only persists the done flag.
//
// Defined before the `/bunny/:id/*` routes so "recommendations" can never be
// captured as an :id.
router.post("/bunny/recommendations/:id/execute", async (req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  // Only accept inbox ids in the "bunnyos:<actionId>" shape this feed emits;
  // reject anything else so the done-flag table can't be polluted with arbitrary
  // keys. Note "done" is per-user view state (it only hides the row from this
  // caller's own feed), not an authorization boundary.
  const id = (req.params["id"] ?? "").trim();
  if (!id.startsWith("bunnyos:") || id.length <= "bunnyos:".length) {
    res.status(400).json({ error: "invalid recommendation id" });
    return;
  }
  try {
    await db
      .insert(bunnyRecommendationExecutionsTable)
      .values({ userId: getCurrentUserId(), recommendationId: id })
      .onConflictDoNothing({
        target: [
          bunnyRecommendationExecutionsTable.userId,
          bunnyRecommendationExecutionsTable.recommendationId,
        ],
      });
    res.json({ ok: true });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Map a live bunnyOS action to the inbox item shape the frontend ActionsPanel
// expects (kind "recommendation"). The note body is the recommendation text; a
// recorded contract call is summarized by its function name. Body-type recs
// carry their text as `executeInstructions` (executing pastes it into the chat
// composer); contract-call recs leave it empty so they stay display-only.
function recommendationItem(a: BunnyOsAction, source: string) {
  const text = (a.body ?? "").trim();
  const headline =
    a.type === "contract_call" && a.contractCall
      ? `contract call · ${a.contractCall.function}`
      : firstLine(text);
  // Avoid showing the same text twice when the body is a single short line.
  const description = a.type === "contract_call" ? "" : text === headline ? "" : text;
  // Only natural-language ("body") recommendations are executable: executing
  // pastes this text into the chat composer. Contract-call recs carry no
  // executeInstructions and stay display-only.
  const executeInstructions = a.type === "body" ? text : "";
  return {
    id: `bunnyos:${a.id}`,
    kind: "recommendation" as const,
    title: headline || source,
    description,
    source,
    push: false,
    executeInstructions,
    tokens: [],
    createdAt: a.createdAt,
    status: "pending" as const,
  };
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

// ---- bunnyOS connect (SIWE via Base MCP sign) ----------------------------
// Read-only enrichment auth: reuse the user's Base wallet session to sign a
// SIWE challenge and mint a per-user bunnyOS JWT. No new browser-side wallet
// connection; the signature is approved in the user's Base wallet.

// GET /api/bunny/bunnyos/status — whether this user has a stored bunnyOS JWT.
router.get("/bunny/bunnyos/status", (_req, res): void => {
  res.json(bunnyOsStatus());
});

// POST /api/bunny/bunnyos/connect — start the SIWE sign; returns the wallet
// approval URL (and request id) for the UI to surface, same as buy/sell.
router.post("/bunny/bunnyos/connect", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    res.json(await startBunnyOsConnect());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not authorized|no connected wallet/i.test(message) ? 409 : 502;
    res.status(status).json({ error: message });
  }
});

// POST /api/bunny/bunnyos/finalize { requestId? } — poll the sign request;
// once signed, verify with bunnyOS and store the JWT. Returns { pending: true }
// while the user hasn't approved yet so the UI can re-poll.
router.post("/bunny/bunnyos/finalize", async (req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const body = (req.body ?? {}) as { requestId?: unknown };
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  try {
    res.json(await finalizeBunnyOsConnect(requestId));
  } catch (err) {
    if (err instanceof BunnyOsSignInError) {
      // Smart-wallet-undeployed (and other verify failures) carry a stable code
      // so the client can show a translated, actionable message.
      res.status(422).json({ error: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = /not authorized/i.test(message) ? 409 : 502;
    res.status(status).json({ error: message });
  }
});

// GET /api/bunny/bunnyos/wallet-status — whether the connected Base wallet is
// already deployed on-chain. A counterfactual Coinbase Smart Wallet (no first
// transaction yet) produces an ERC-6492 signature bunnyOS can't verify, so the
// UI offers an "activate wallet" step before connect. `hasWallet: false` means
// the user isn't signed in with a Base wallet yet (UI falls back to connect).
router.get("/bunny/bunnyos/wallet-status", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const wallet = await getCurrentUserWallet();
    if (!wallet) {
      res.json({ hasWallet: false, deployed: false, address: null });
      return;
    }
    const deployed = await isWalletDeployed(wallet as `0x${string}`);
    res.json({ hasWallet: true, deployed, address: wallet });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/bunny/bunnyos/activate — deploy a counterfactual smart wallet by
// sending a 0-value self-call through Base MCP send_calls. Returns the wallet
// approval URL (same pattern as buy/sell); the UI polls wallet-status until the
// wallet shows bytecode, then offers connect. Costs only gas (wallet must hold
// a little ETH on Base). No-op-safe if the wallet is already deployed.
router.post("/bunny/bunnyos/activate", async (_req, res): Promise<void> => {
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.status(409).json({ error: "no connected wallet — sign in with your Base wallet first" });
    return;
  }
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    if (await isWalletDeployed(wallet as `0x${string}`)) {
      res.json({ alreadyDeployed: true, approvalUrl: null, approvalUrls: [], content: "" });
      return;
    }
    const calls = buildActivateCalls(wallet as `0x${string}`);
    const result = await callTool("send_calls", { chain: "base", calls });
    if (result.isError) {
      res.status(502).json({ error: result.content || "send_calls failed" });
      return;
    }
    const approvalUrls = extractApprovalUrls(result.content);
    res.json({
      alreadyDeployed: false,
      approvalUrl: approvalUrls[0] ?? null,
      approvalUrls,
      content: result.content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not authorized/i.test(message) ? 409 : 502;
    res.status(status).json({ error: message });
  }
});

// POST /api/bunny/bunnyos/disconnect — drop the stored JWT.
router.post("/bunny/bunnyos/disconnect", async (_req, res): Promise<void> => {
  try {
    await disconnectBunnyOs();
    res.json({ connected: false });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- bunnyOS programmatic API keys --------------------------------------
// Self-service management of the user's `x-api-key` credentials for calling the
// bunnyOS Exchange API directly. Every operation is authed with the SIWE JWT
// the app already holds; the minted secret is returned by create/regenerate
// exactly once and is NEVER persisted server-side. A missing/expired JWT maps
// to 401 {connected:false} (the same not-connected shape the other bunnyOS
// routes use), so the UI prompts the existing connect flow.

// Validate an optional expiry: undefined/null → null (never expires); a string
// must parse to a valid date-time strictly in the future. Returns the canonical
// ISO string on success.
function parseExpiresAt(
  v: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms <= Date.now()) return { ok: false };
  return { ok: true, value: new Date(ms).toISOString() };
}

// Map a bunnyOS client error onto the shared not-connected/forbidden/502 shape.
function sendApiKeyError(res: Response, err: unknown): void {
  if (err instanceof BunnyOsNotConnectedError) {
    res.status(401).json({ connected: false });
    return;
  }
  if (err instanceof BunnyOsForbiddenError) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
}

// GET /api/bunny/bunnyos/api-keys — list the caller's keys (metadata only).
// Returns { connected: false } (not an error) when no JWT is stored.
router.get("/bunny/bunnyos/api-keys", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const keys = await listApiKeys();
    res.json({ connected: true, keys });
  } catch (err) {
    if (err instanceof BunnyOsNotConnectedError) {
      res.json({ connected: false, keys: [] });
      return;
    }
    sendApiKeyError(res, err);
  }
});

const CreateApiKeyBody = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.union([z.string(), z.null()]).optional(),
});

// POST /api/bunny/bunnyos/api-keys — create a key; the full secret is returned
// exactly once in the response and never stored by us.
router.post("/bunny/bunnyos/api-keys", async (req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  const parsed = CreateApiKeyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const expiry = parseExpiresAt(parsed.data.expiresAt);
  if (!expiry.ok) {
    res.status(400).json({ error: "expiry must be a future date-time or null" });
    return;
  }
  try {
    const key = await createApiKey({ name: parsed.data.name, expiresAt: expiry.value });
    res.status(201).json({ key });
  } catch (err) {
    sendApiKeyError(res, err);
  }
});

const UpdateApiKeyBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  expiresAt: z.union([z.string(), z.null()]).optional(),
});

// PATCH /api/bunny/bunnyos/api-keys/:keyId — rename and/or re-expire a key.
// At least one field must be present; expiry must be a future date-time or null.
router.patch("/bunny/bunnyos/api-keys/:keyId", async (req, res): Promise<void> => {
  const keyId = String(req.params.keyId ?? "").trim();
  if (keyId.length === 0) {
    res.status(400).json({ error: "invalid key id" });
    return;
  }
  const parsed = UpdateApiKeyBody.safeParse(req.body ?? {});
  if (!parsed.success || (parsed.data.name === undefined && !("expiresAt" in parsed.data))) {
    res.status(400).json({ error: "provide a name and/or expiry to update" });
    return;
  }
  const update: { name?: string; expiresAt?: string | null } = {};
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if ("expiresAt" in parsed.data) {
    const expiry = parseExpiresAt(parsed.data.expiresAt);
    if (!expiry.ok) {
      res.status(400).json({ error: "expiry must be a future date-time or null" });
      return;
    }
    update.expiresAt = expiry.value;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const key = await updateApiKey(keyId, update);
    res.json({ key });
  } catch (err) {
    sendApiKeyError(res, err);
  }
});

// POST /api/bunny/bunnyos/api-keys/:keyId/revoke — revoke a key immediately.
router.post("/bunny/bunnyos/api-keys/:keyId/revoke", async (req, res): Promise<void> => {
  const keyId = String(req.params.keyId ?? "").trim();
  if (keyId.length === 0) {
    res.status(400).json({ error: "invalid key id" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const key = await revokeApiKey(keyId);
    res.json({ revoked: true, key });
  } catch (err) {
    sendApiKeyError(res, err);
  }
});

// POST /api/bunny/bunnyos/api-keys/:keyId/regenerate — issue a new secret under
// the same name; the old secret dies and the new one is returned exactly once.
router.post("/bunny/bunnyos/api-keys/:keyId/regenerate", async (req, res): Promise<void> => {
  const keyId = String(req.params.keyId ?? "").trim();
  if (keyId.length === 0) {
    res.status(400).json({ error: "invalid key id" });
    return;
  }
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    const key = await regenerateApiKey(keyId);
    res.json({ key });
  } catch (err) {
    sendApiKeyError(res, err);
  }
});

// Convert a wei decimal string (possibly negative, e.g. realized PnL) to a
// token-unit string using the OS token decimals. Never throws — a bad value
// degrades to "0" so a single malformed field can't 500 the whole response.
function weiToToken(wei: string | null | undefined, decimals: number): string {
  if (wei == null) return "0";
  try {
    return formatUnits(BigInt(wei), decimals);
  } catch {
    return "0";
  }
}

const CANDLE_INTERVALS: ReadonlySet<string> = new Set([
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
]);

// GET /api/bunny/portfolio/pnl — the caller's aggregate PnL across every bunny
// they hold, from bunnyOS's official ledger. Registered BEFORE the `/bunny/:id`
// routes so "portfolio" isn't swallowed as an id. Requires a bunnyOS JWT;
// returns { connected: false } (not an error) when the user hasn't connected.
router.get("/bunny/portfolio/pnl", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const [config, pnl] = await Promise.all([getExchangeConfig(), fetchPortfolioPnl()]);
    const dec = config.tokenDecimals;
    res.json({
      connected: true,
      tokenSymbol: config.tokenSymbol,
      totals: {
        costBasis: weiToToken(pnl.totals.costBasis, dec),
        realizedPnl: weiToToken(pnl.totals.realizedPnl, dec),
        unrealizedPnl: weiToToken(pnl.totals.unrealizedPnl, dec),
        totalPnl: weiToToken(pnl.totals.totalPnl, dec),
      },
      bunnies: pnl.bunnies.map((b) => ({
        bunnyId: b.bunnyId,
        balance: b.balance,
        costBasis: weiToToken(b.costBasis, dec),
        realizedPnl: weiToToken(b.realizedPnl, dec),
        unrealizedPnl: weiToToken(b.unrealizedPnl, dec),
        totalPnl: weiToToken(b.totalPnl, dec),
      })),
    });
  } catch (err) {
    if (err instanceof BunnyOsNotConnectedError) {
      res.json({ connected: false });
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/:id/candles?interval=&limit= — real OHLC price history from
// bunnyOS (per-key prices, in token units). Works anonymously. `interval` is
// required and from the closed set; `limit` is optional (capped at 1000).
router.get("/bunny/:id/candles", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const interval = String(req.query["interval"] ?? "1h");
  if (!CANDLE_INTERVALS.has(interval)) {
    res.status(400).json({ error: "invalid interval" });
    return;
  }
  let limit: number | undefined;
  const limitRaw = req.query["limit"];
  if (typeof limitRaw === "string" && limitRaw.trim() !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      res.status(400).json({ error: "limit must be 1..1000" });
      return;
    }
    limit = n;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const [config, data] = await Promise.all([
      getExchangeConfig(),
      fetchBunnyCandles(id, { interval: interval as CandleInterval, limit }),
    ]);
    const dec = config.tokenDecimals;
    res.json({
      bunnyId: id,
      interval: data.interval,
      tokenSymbol: config.tokenSymbol,
      candles: data.candles.map((c) => ({
        bucketStart: c.bucketStart,
        open: weiToToken(c.open, dec),
        high: weiToToken(c.high, dec),
        low: weiToToken(c.low, dec),
        close: weiToToken(c.close, dec),
        volumeKeys: c.volumeKeys,
        volumeValue: weiToToken(c.volumeValue, dec),
        tradeCount: c.tradeCount,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/:id/transactions?limit=&cursor= — the bunny's global trade
// tape (all traders), newest first, from bunnyOS. Works anonymously. This is
// market-wide history; the caller's own trades stay in /api/bunny/trades.
router.get("/bunny/:id/transactions", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  let limit: number | undefined;
  const limitRaw = req.query["limit"];
  if (typeof limitRaw === "string" && limitRaw.trim() !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      res.status(400).json({ error: "limit must be 1..1000" });
      return;
    }
    limit = n;
  }
  const cursorRaw = req.query["cursor"];
  const cursor = typeof cursorRaw === "string" && cursorRaw.trim() !== "" ? cursorRaw : undefined;
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const [config, data] = await Promise.all([
      getExchangeConfig(),
      fetchBunnyTransactions(id, { limit, cursor }),
    ]);
    const dec = config.tokenDecimals;
    res.json({
      bunnyId: id,
      tokenSymbol: config.tokenSymbol,
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
      transactions: data.transactions.map((t) => ({
        side: t.side,
        amount: t.amount,
        pricePerKey: weiToToken(t.pricePerKey, dec),
        total: weiToToken(t.total, dec),
        trader: t.trader,
        timestamp: t.timestamp,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/:id/pnl — the caller's official PnL for one bunny from
// bunnyOS's ledger (cost basis + realized/unrealized/total). Requires a JWT;
// returns { connected: false } when the user hasn't connected bunnyOS.
router.get("/bunny/:id/pnl", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const [config, pnl] = await Promise.all([getExchangeConfig(), fetchBunnyPnl(id)]);
    const dec = config.tokenDecimals;
    res.json({
      connected: true,
      bunnyId: id,
      tokenSymbol: config.tokenSymbol,
      balance: pnl.balance,
      costBasis: weiToToken(pnl.costBasis, dec),
      realizedPnl: weiToToken(pnl.realizedPnl, dec),
      unrealizedPnl: weiToToken(pnl.unrealizedPnl, dec),
      totalPnl: weiToToken(pnl.totalPnl, dec),
    });
  } catch (err) {
    if (err instanceof BunnyOsNotConnectedError) {
      res.json({ connected: false });
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/:id/quote?amount=N — cost to buy N keys + slippage-padded
// maxPrice (also the amount to approve).
router.get("/bunny/:id/quote", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const amount = parsePositiveInt(req.query["amount"] ?? "1");
  if (amount === null) {
    res.status(400).json({ error: "amount must be a positive integer" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    res.json(await quoteBuy(id, amount));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/:id/curve — sampled bonding curve (price vs supply) plus the
// bunny's current supply, for the UI chart.
router.get("/bunny/:id/curve", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    res.json(await getBondingCurve(id));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Map a raw wallet/MCP send_calls failure to a human reason. A buy reverts in
// gas estimation almost always because the wallet can't actually pay: not enough
// OS to cover the keys, or not enough ETH on Base for gas (or the price moved
// past slippage). The pre-flight balance check above catches the clear-cut
// cases; this covers whatever still slips through to estimation.
function friendlyBuyError(raw: string): string {
  if (
    /execution reverted|estimate gas|user ?operation reverted|insufficient|out of gas/i.test(
      raw,
    )
  ) {
    return "transaction would fail — not enough OS to pay, or not enough ETH on Base for gas (or the price moved past slippage). check your balances and try again.";
  }
  return raw;
}

// POST /api/bunny/:id/buy { amount } — quote fresh, build approve+buyKeys, run
// through send_calls, return the wallet approval URL for the UI to surface.
router.post("/bunny/:id/buy", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const body = (req.body ?? {}) as { amount?: unknown };
  const amount = parsePositiveInt(body.amount ?? "1");
  if (amount === null) {
    res.status(400).json({ error: "amount must be a positive integer" });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.status(409).json({ error: "no connected wallet — sign in with your Base wallet first" });
    return;
  }
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    const quote = await quoteBuy(id, amount);
    if (quote.soldOut) {
      res.status(409).json({ error: "this bunny is sold out" });
      return;
    }
    // Pre-flight the OS balance so we can return a clear reason instead of a raw
    // "execution reverted" out of the wallet's gas estimation. Keys are paid in
    // the OS token; this is the definite, common failure. We deliberately do NOT
    // pre-block on native ETH — gas can be paymaster-sponsored for smart wallets,
    // so an ETH=0 gate would false-reject valid buys. If gas really is missing,
    // send_calls reverts and `friendlyBuyError` surfaces the ETH reason.
    const funds = await getBuyFunds(wallet);
    if (funds.osWei < BigInt(quote.totalWei)) {
      res.status(409).json({
        error: `not enough ${quote.tokenSymbol} for this buy — need ${quote.total}, wallet holds ${formatUnits(funds.osWei, quote.tokenDecimals)}`,
        quote,
      });
      return;
    }
    const calls = await buildBuyCalls(id, amount, BigInt(quote.maxPriceWei));
    const result = await callTool("send_calls", { chain: "base", calls });
    if (result.isError) {
      const raw = result.content || "send_calls failed";
      res.status(502).json({ error: friendlyBuyError(raw), raw });
      return;
    }
    const approvalUrls = extractApprovalUrls(result.content);
    res.json({
      quote,
      approvalUrl: approvalUrls[0] ?? null,
      approvalUrls,
      content: result.content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "Not authorized" comes from callTool when the Base MCP session isn't
    // connected — surface it as a 409 so the UI can prompt a re-login.
    const status = /not authorized/i.test(message) ? 409 : 502;
    res.status(status).json({ error: message });
  }
});

// GET /api/bunny/create-quote?amount=N — cost to create a bunny with N optional
// initial keys (N may be 0 = registration only). No connected wallet required
// (only a session) so the create form can preview the cost before the user has
// linked their Base wallet.
router.get("/bunny/create-quote", async (req, res): Promise<void> => {
  const amount = parseNonNegInt(req.query["amount"] ?? "0");
  if (amount === null) {
    res.status(400).json({ error: "amount must be a non-negative integer" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    res.json(await quoteCreate(amount));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/bunny/create { additionalBuyAmount? } — quote fresh, build
// approve + createBunny, run through send_calls, return the wallet approval URL.
router.post("/bunny/create", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { additionalBuyAmount?: unknown };
  const amount = parseNonNegInt(body.additionalBuyAmount ?? "0");
  if (amount === null) {
    res.status(400).json({ error: "additionalBuyAmount must be a non-negative integer" });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.status(409).json({ error: "no connected wallet — sign in with your Base wallet first" });
    return;
  }
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    const quote = await quoteCreate(amount);
    if (quote.soldOut) {
      res.status(409).json({ error: "too many initial keys — exceeds the per-bunny cap" });
      return;
    }
    const calls = await buildCreateCalls(
      amount,
      BigInt(quote.maxPriceWei),
      BigInt(quote.approveWei),
    );
    const result = await callTool("send_calls", { chain: "base", calls });
    if (result.isError) {
      res.status(502).json({ error: result.content || "send_calls failed" });
      return;
    }
    const approvalUrls = extractApprovalUrls(result.content);
    res.json({
      quote,
      approvalUrl: approvalUrls[0] ?? null,
      approvalUrls,
      content: result.content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not authorized/i.test(message) ? 409 : 502;
    res.status(status).json({ error: message });
  }
});

// GET /api/bunny/:id/sell-quote?amount=N — proceeds (net of fee) for selling N
// keys + the slippage-padded minPrice floor. Requires a connected wallet since
// the quote validates against the caller's key balance.
router.get("/bunny/:id/sell-quote", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const amount = parsePositiveInt(req.query["amount"] ?? "1");
  if (amount === null) {
    res.status(400).json({ error: "amount must be a positive integer" });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.status(409).json({ error: "no connected wallet — sign in with your Base wallet first" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    res.json(await quoteSell(id, amount, wallet));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/bunny/:id/sell { amount } — quote fresh, build the sellKeys call
// (no approve needed), run through send_calls, return the wallet approval URL.
router.post("/bunny/:id/sell", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const body = (req.body ?? {}) as { amount?: unknown };
  const amount = parsePositiveInt(body.amount ?? "1");
  if (amount === null) {
    res.status(400).json({ error: "amount must be a positive integer" });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.status(409).json({ error: "no connected wallet — sign in with your Base wallet first" });
    return;
  }
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    const quote = await quoteSell(id, amount, wallet);
    const calls = await buildSellCalls(id, amount, BigInt(quote.minPriceWei));
    const result = await callTool("send_calls", { chain: "base", calls });
    if (result.isError) {
      res.status(502).json({ error: result.content || "send_calls failed" });
      return;
    }
    const approvalUrls = extractApprovalUrls(result.content);
    res.json({
      quote,
      approvalUrl: approvalUrls[0] ?? null,
      approvalUrls,
      content: result.content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not authorized/i.test(message) ? 409 : 502;
    res.status(status).json({ error: message });
  }
});

// GET /api/bunny/trades?bunnyId=N — the caller's own buy/sell history for one
// bunny, sourced live from the bunnyOS transactions feed filtered to the
// caller's wallet (newest first). All entries are confirmed on-chain fills.
// Empty when there's no bunny scope, no connected wallet, or no matching trades.
router.get("/bunny/trades", async (req, res): Promise<void> => {
  const bunnyIdRaw = req.query["bunnyId"];
  let bunnyId: number | null = null;
  if (typeof bunnyIdRaw === "string" && bunnyIdRaw.trim() !== "") {
    const n = Number(bunnyIdRaw);
    if (!Number.isInteger(n) || n < 0) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    bunnyId = n;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    const wallet = await getCurrentUserWallet();
    // The transactions feed is per-bunny and keyed by trader address; without a
    // bunny scope or a connected wallet there's nothing to attribute.
    if (bunnyId === null || !wallet) {
      res.json({ trades: [] });
      return;
    }
    const me = wallet.toLowerCase();
    const [config, data] = await Promise.all([
      getExchangeConfig(),
      fetchBunnyTransactions(bunnyId, { limit: 1000 }),
    ]);
    const dec = config.tokenDecimals;
    const trades = data.transactions
      .filter((t) => t.trader.toLowerCase() === me)
      // Newest first, independent of upstream ordering.
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .map((t) => {
        const side = t.side.toLowerCase() === "sell" ? "sell" : "buy";
        return {
          // Deterministic key from the fill's immutable fields — stable across
          // refreshes/pagination (the feed has no tx hash to key on).
          id: `${bunnyId}-${t.timestamp}-${side}-${t.amount}-${t.total}`,
          bunnyId,
          side,
          amount: t.amount,
          priceWei: t.total,
          price: weiToToken(t.total, dec),
          tokenSymbol: config.tokenSymbol,
          tokenDecimals: dec,
          status: "confirmed" as const,
          txHash: null,
          createdAt: t.timestamp,
        };
      });
    res.json({ trades });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- bunny off-chain profiles --------------------------------------------

const trimmedOrNull = z
  .string()
  .trim()
  .max(2048)
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .catch(null);

// Single-select methodology from the client, validated against the closed
// bunnyOS set. Anything else (including empty) clears the tag.
const methodologyOrNull = z
  .string()
  .trim()
  .nullable()
  .catch(null)
  .transform((s): BunnyOsMethodology | null =>
    s && (BUNNYOS_METHODOLOGIES as readonly string[]).includes(s)
      ? (s as BunnyOsMethodology)
      : null,
  );

const ProfileBody = z.object({
  name: z.string().trim().max(80).default(""),
  bio: z.string().trim().max(600).default(""),
  website: trimmedOrNull,
  twitter: trimmedOrNull,
  discord: trimmedOrNull,
  telegram: trimmedOrNull,
  methodology: methodologyOrNull,
  // photoUrl is the bunny avatar. The client sends either a freshly-uploaded
  // object-storage path ("/objects/<id>"), an existing absolute URL to leave
  // unchanged, an empty string/null to clear it, or omits it entirely.
  photoUrl: z.string().trim().max(2048).nullish(),
});

const avatarStorage = new ObjectStorageService();

// Resolve the avatar photoUrl to store on bunnyOS. A freshly-uploaded object
// ("/objects/<id>") is turned into an absolute serving URL on this origin; any
// other value (existing URL, empty -> null, or undefined) passes through.
// Returns the value to send AND the raw object path (if any) to mark public
// after the write is authorized. Returns undefined to leave bunnyOS untouched.
function resolvePhotoUrl(
  raw: string | null | undefined,
): { value: string | null | undefined; freshObject: string | null } {
  if (raw === undefined) return { value: undefined, freshObject: null };
  if (raw === null) return { value: null, freshObject: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null, freshObject: null };
  if (trimmed.startsWith("/objects/")) {
    const origin = getActiveRequestOrigin() ?? resolvePublicBaseUrl();
    return { value: `${origin}/api/storage${trimmed}`, freshObject: trimmed };
  }
  return { value: trimmed, freshObject: null };
}

// GET /api/bunny/:id/profile — read the bunny's profile live from bunnyOS,
// including the server-computed `canEdit` flag. Reads work anonymously, so a
// missing bunnyOS profile (404) or a signed-out viewer just yields a null
// profile and the on-chain list/detail still render.
router.get("/bunny/:id/profile", async (req, res): Promise<void> => {
  const bunnyId = Number(req.params.id);
  if (!Number.isInteger(bunnyId) || bunnyId < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  try {
    const [profile, { perms }] = await Promise.all([
      fetchBunnyProfile(bunnyId),
      fetchBunnyPermissions(bunnyId),
    ]);
    res.json({ profile, canEdit: perms?.profile.canEdit ?? false });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/bunny/:id/action-history — the bunny's action push history. A bunny's
// pushed actions are the actions emitted by its on-chain creator (creator wallet
// → userId). Visibility is gated: only key holders (balanceOf > 0), the creator
// themselves, and admins see action details. Everyone else gets redacted stubs
// (kind + timestamp only) so non-holders can see that a bunny is active without
// reading the alpha they haven't paid for.
router.get("/bunny/:id/action-history", async (req, res): Promise<void> => {
  const bunnyId = Number(req.params.id);
  if (!Number.isInteger(bunnyId) || bunnyId < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  try {
    const [creator, wallet] = await Promise.all([
      getBunnyCreator(bunnyId),
      getCurrentUserWallet(),
    ]);
    if (!creator) {
      res.status(404).json({ error: `bunny ${bunnyId} does not exist` });
      return;
    }

    const isCreator =
      !!wallet && wallet.toLowerCase() === creator.toLowerCase();
    const [creatorUserId, keyBalance] = await Promise.all([
      getUserIdByWallet(creator),
      isCreator ? Promise.resolve(1n) : getKeyBalance(bunnyId, wallet),
    ]);
    const canView = isCreator || isAdminWallet(wallet) || keyBalance > 0n;

    const actions = creatorUserId
      ? await listPushedActionsForUser(creatorUserId)
      : [];

    // Non-viewers only learn that an action was pushed and when — never the
    // title, body, source, tokens, or execute instructions.
    const payload = canView
      ? actions
      : actions.map((a) => ({
          id: a.id,
          kind: a.kind,
          createdAt: a.createdAt,
          status: a.status,
        }));

    res.json({ canView, actions: payload });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PUT /api/bunny/:id/profile — create or update the bunny's profile on bunnyOS.
// Requires a connected bunnyOS session (bearer JWT); bunnyOS itself enforces
// that only the owner (or an admin) may write. A missing/expired JWT returns 401
// {connected:false} so the client can prompt the existing bunnyOS connect flow.
// Avatars are display-only from bunnyOS `photoUrl` and are not editable here.
router.put("/bunny/:id/profile", async (req, res): Promise<void> => {
  const bunnyId = Number(req.params.id);
  if (!Number.isInteger(bunnyId) || bunnyId < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const parsed = ProfileBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid profile" });
    return;
  }
  const name = parsed.data.name.trim();
  if (name.length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const photo = resolvePhotoUrl(parsed.data.photoUrl);
  try {
    const profile = await saveBunnyProfile(bunnyId, {
      name,
      description: parsed.data.bio.length === 0 ? null : parsed.data.bio,
      website: parsed.data.website,
      photoUrl: photo.value,
      socials: {
        x: parsed.data.twitter,
        discord: parsed.data.discord,
        telegram: parsed.data.telegram,
      },
      methodology: parsed.data.methodology ? [parsed.data.methodology] : [],
    });
    // bunnyOS authorised the write, so the freshly-uploaded avatar object can now
    // be marked public (so anyone can render it on cards/detail). Best-effort:
    // the profile already saved, so a failure here just logs. trySet refuses to
    // re-own an object owned by another user, preventing object hijacking.
    if (photo.freshObject) {
      try {
        await avatarStorage.trySetObjectEntityAclPolicy(photo.freshObject, {
          owner: getCurrentUserId(),
          visibility: "public",
        });
      } catch (aclErr) {
        req.log.warn({ err: aclErr }, "failed to mark bunny avatar public");
      }
    }
    // The write only succeeds when bunnyOS authorised it, so the caller can edit.
    res.json({ profile, canEdit: true });
  } catch (err) {
    if (err instanceof BunnyOsNotConnectedError) {
      res.status(401).json({ connected: false });
      return;
    }
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- bunny actions (sourced from bunnyOS, not the local feed) ------------
// These three routes proxy the bunnyOS Exchange action endpoints. Unlike
// /action-history (which reads the local actions feed) the action list, posting
// and archiving here are the bunnyOS owner-authored action surface. `canView`
// is still computed on-chain (creator/admin/key-holder) so non-holders get the
// locked treatment, and `canManage` (creator/admin) drives the owner-only
// compose + archive controls. bunnyOS is the final authority on both.

function actionResponse(a: BunnyOsAction) {
  return {
    id: a.id,
    type: a.type,
    body: a.body,
    contractCall: a.contractCall,
    createdAt: a.createdAt,
    archivedAt: a.archivedAt,
  };
}

// GET /api/bunny/:id/actions — the bunny's action surface. canView/canManage are
// computed on-chain (creator/admin/key-holder) so the gating mirrors the legacy
// /action-history route. Viewers (with a live bunnyOS session) get the full live
// bunnyOS actions; a bunnyOS 403 (authed non-holder) keeps canView without
// leaking data. Non-viewers keep the existing locked treatment: redacted stubs
// (kind + timestamp only) sourced from the local pushed-actions feed, so a
// signed-out / non-holder visitor still sees that a bunny is active.
router.get("/bunny/:id/actions", async (req, res): Promise<void> => {
  const bunnyId = Number(req.params.id);
  if (!Number.isInteger(bunnyId) || bunnyId < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  try {
    const [creator, wallet] = await Promise.all([
      getBunnyCreator(bunnyId),
      getCurrentUserWallet(),
    ]);
    if (!creator) {
      res.status(404).json({ error: `bunny ${bunnyId} does not exist` });
      return;
    }
    const isCreator =
      !!wallet && wallet.toLowerCase() === creator.toLowerCase();
    const [creatorUserId, keyBalance] = await Promise.all([
      getUserIdByWallet(creator),
      isCreator ? Promise.resolve(1n) : getKeyBalance(bunnyId, wallet),
    ]);
    let canManage = isCreator || isAdminWallet(wallet);
    let canView = canManage || keyBalance > 0n;

    let connected = bunnyOsStatus().connected;
    let actions: unknown[] = [];

    // bunnyOS is the ownership authority — its capability map (the same source
    // that drives the edit-profile button) is the truth for who may manage a
    // bunny's actions. The on-chain creator lookup can disagree (e.g. a bunny
    // minted via a proxy/factory), so when connected and the on-chain check
    // hasn't already granted manage, let bunnyOS `recommendation.canManage`
    // grant it. Additive only — any failure falls back to on-chain gating.
    if (connected && (!canManage || !canView)) {
      const { perms } = await fetchBunnyPermissions(bunnyId);
      if (perms?.recommendation.canManage) {
        canManage = true;
        canView = true;
      } else if (perms?.recommendation.canView) {
        canView = true;
      }
    }

    if (canView) {
      // Viewers read the live bunnyOS actions, but only when a session exists.
      if (connected) {
        try {
          // Per-user "completed" set — recs this caller has executed/dismissed
          // (from this tab or the from-bunnies inbox) so the client can bucket
          // them under "completed". Keyed by the inbox id ("bunnyos:<actionId>")
          // the execute endpoint writes; the per-bunny action `id` is that same
          // bunnyOS actionId, so the keys line up.
          const executedRows = await db
            .select({ id: bunnyRecommendationExecutionsTable.recommendationId })
            .from(bunnyRecommendationExecutionsTable)
            .where(
              eq(bunnyRecommendationExecutionsTable.userId, getCurrentUserId()),
            );
          const executed = new Set(executedRows.map((r) => r.id));
          actions = (await listBunnyActions(bunnyId)).map((a) => ({
            ...actionResponse(a),
            executedByMe: executed.has(`bunnyos:${a.id}`),
          }));
        } catch (err) {
          if (err instanceof BunnyOsNotConnectedError) {
            connected = false;
          } else if (!(err instanceof BunnyOsForbiddenError)) {
            throw err;
          }
          // BunnyOsForbiddenError: keep canView, just no data.
        }
      }
    } else {
      // Non-viewers only learn that an action was pushed and when (never the
      // type, body, or contract call) — the redacted stub treatment unchanged
      // from the legacy /action-history route.
      const stubs = creatorUserId
        ? await listPushedActionsForUser(creatorUserId)
        : [];
      actions = stubs.map((a) => ({
        id: a.id,
        kind: a.kind,
        createdAt: a.createdAt,
      }));
    }

    res.json({ canView, canManage, connected, actions });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const ContractCallBody = z.object({
  chainId: z.number().int(),
  to: z.string().min(1),
  function: z.string().min(1),
  args: z.array(z.unknown()).default([]),
  value: z.string().nullable().default(null),
});

const CreateActionBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("body"), body: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("contract_call"), contractCall: ContractCallBody }),
]);

// POST /api/bunny/:id/actions — post a new action. Owner-only; bunnyOS enforces
// ownership and returns 403 → 403 here, while a missing/expired session →
// 401 {connected:false} so the client can prompt the bunnyOS connect flow.
router.post("/bunny/:id/actions", async (req, res): Promise<void> => {
  const bunnyId = Number(req.params.id);
  if (!Number.isInteger(bunnyId) || bunnyId < 0) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const parsed = CreateActionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid action" });
    return;
  }
  try {
    const action = await createBunnyAction(
      bunnyId,
      parsed.data as BunnyOsActionInput,
    );
    res.status(201).json({ action: actionResponse(action) });
  } catch (err) {
    if (err instanceof BunnyOsNotConnectedError) {
      res.status(401).json({ connected: false });
      return;
    }
    if (err instanceof BunnyOsForbiddenError) {
      res.status(403).json({ error: "only the owner can post actions" });
      return;
    }
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const UpdateActionBody = z.object({
  archivedAt: z.string().min(1).nullable(),
});

// PATCH /api/bunny/:id/actions/:actionId — archive (archivedAt = timestamp) or
// reactivate (archivedAt = null) an action. Owner-only; content is immutable.
router.patch(
  "/bunny/:id/actions/:actionId",
  async (req, res): Promise<void> => {
    const bunnyId = Number(req.params.id);
    if (!Number.isInteger(bunnyId) || bunnyId < 0) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const actionId = String(req.params.actionId ?? "").trim();
    if (actionId.length === 0) {
      res.status(400).json({ error: "invalid action id" });
      return;
    }
    const parsed = UpdateActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid update" });
      return;
    }
    try {
      const action = await updateBunnyActionArchive(
        bunnyId,
        actionId,
        parsed.data.archivedAt,
      );
      res.json({ action: actionResponse(action) });
    } catch (err) {
      if (err instanceof BunnyOsNotConnectedError) {
        res.status(401).json({ connected: false });
        return;
      }
      if (err instanceof BunnyOsForbiddenError) {
        res.status(403).json({ error: "only the owner can archive actions" });
        return;
      }
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ---- bunny permissions + forum (Threads) --------------------------------
// The whole forum (posts, threaded comments, up/down votes, moderators and
// bans) is owned by bunnyOS (api.bunnyos.ai) — there is NO local Postgres
// forum any more. These routes are thin proxies onto the bunnyOS Exchange
// thread endpoints; bunnyOS is the security boundary (key-holder gated, with
// the owner/admins always allowed). The caller's capabilities come from the
// `/exchange/permissions` capability map (which replaced the old per-profile
// `canEdit` flag). Threads require a connected bunnyOS session (bearer JWT):
// an anonymous / disconnected caller gets every capability false, so the UI
// renders the locked treatment without ever calling the authed endpoints.

// Translate a bunnyOS client error into an HTTP response. 401 (expired/missing
// JWT) → {connected:false}; 403 (valid session, no access) → forbidden; a 404
// from the upstream → 404; anything else is surfaced as a 502.
function sendForumError(res: Response, err: unknown): void {
  if (err instanceof BunnyOsNotConnectedError) {
    res.status(401).json({ connected: false });
    return;
  }
  if (err instanceof BunnyOsForbiddenError) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/\(404\)/.test(msg)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(502).json({ error: msg });
}

function toBunnyId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normAddress(raw: string): string | null {
  const a = String(raw ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(a) ? a : null;
}

const ForumPostBody = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10000),
});

const ForumCommentBody = z.object({
  body: z.string().trim().min(1).max(10000),
  parentCommentId: z.string().trim().min(1).nullable().optional(),
});

const ForumVoteBody = z.object({
  direction: z.enum(["up", "down"]),
});

function parseSort(raw: unknown): ThreadSort {
  return raw === "top" ? "top" : "new";
}

// A comment plus its nested replies, built server-side from the flat list
// bunnyOS returns (keyed by parentCommentId). The list arrives already sorted
// by the requested order, so encounter order is preserved within each level.
interface CommentNode extends ThreadComment {
  replies: CommentNode[];
}
function buildCommentTree(flat: ThreadComment[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const c of flat) nodes.set(c.id, { ...c, replies: [] });
  const roots: CommentNode[] = [];
  for (const c of flat) {
    const node = nodes.get(c.id);
    if (!node) continue;
    const parent = c.parentCommentId ? nodes.get(c.parentCommentId) : null;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

// GET /api/bunny/:id/permissions — the caller's bunnyOS capability map for a
// single bunny plus the global admin flag. Optional auth: an anonymous caller
// gets every flag false (permissions=null when bunnyOS doesn't know the bunny).
// This is the replacement for the removed per-profile `canEdit` flag and drives
// every edit/forum/moderation affordance in the UI.
router.get("/bunny/:id/permissions", async (req, res): Promise<void> => {
  const bunnyId = toBunnyId(req.params.id);
  if (bunnyId === null) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  try {
    const { isAdmin, address, perms } = await fetchBunnyPermissions(bunnyId);
    res.json({
      isAdmin,
      viewerAddress: address,
      connected: bunnyOsStatus().connected,
      permissions: perms,
    });
  } catch (err) {
    sendForumError(res, err);
  }
});

// GET /api/bunny/:id/forum/posts?sort=new|top&limit&offset — the bunny's thread
// list. Gated on `thread.canView`: a non-holder / disconnected caller gets
// canView:false and an empty list (the locked treatment) without hitting the
// authed bunnyOS endpoint. Viewers get the live bunnyOS posts.
router.get("/bunny/:id/forum/posts", async (req, res): Promise<void> => {
  const bunnyId = toBunnyId(req.params.id);
  if (bunnyId === null) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const sort = parseSort(req.query.sort);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const connected = bunnyOsStatus().connected;
  try {
    const { isAdmin, address, perms } = await fetchBunnyPermissions(bunnyId);
    if (!perms?.thread.canView) {
      res.json({
        canView: false,
        connected,
        isAdmin,
        viewerAddress: address,
        permissions: perms,
        posts: [],
        total: 0,
      });
      return;
    }
    const { posts, total } = await listThreadPosts(bunnyId, {
      sort,
      limit,
      offset,
    });
    res.json({
      canView: true,
      connected,
      isAdmin,
      viewerAddress: address,
      permissions: perms,
      posts,
      total,
    });
  } catch (err) {
    sendForumError(res, err);
  }
});

// POST /api/bunny/:id/forum/posts — create a new thread post. bunnyOS enforces
// that the caller is a key holder (or owner/admin) and not banned.
router.post("/bunny/:id/forum/posts", async (req, res): Promise<void> => {
  const bunnyId = toBunnyId(req.params.id);
  if (bunnyId === null) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  const parsed = ForumPostBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid post" });
    return;
  }
  try {
    const created = await createThreadPost(bunnyId, parsed.data);
    // Authors auto-upvote their own post. Best-effort: if the vote fails we
    // still return the created post so the write isn't lost.
    const post = await setPostVote(bunnyId, created.id, "up").catch(
      () => created,
    );
    res.json({ post });
  } catch (err) {
    sendForumError(res, err);
  }
});

// GET /api/bunny/:id/forum/posts/:postId — a single post plus its nested comment
// tree. Gated on `thread.canView`. Deleted posts/comments come back as
// tombstones (blank title/body, deleted=true) so the thread keeps its shape.
router.get(
  "/bunny/:id/forum/posts/:postId",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const postId = req.params.postId;
    const connected = bunnyOsStatus().connected;
    try {
      const { isAdmin, address, perms } = await fetchBunnyPermissions(bunnyId);
      if (!perms?.thread.canView) {
        res.status(403).json({ error: "holders only" });
        return;
      }
      const [post, comments] = await Promise.all([
        getThreadPost(bunnyId, postId),
        listPostComments(bunnyId, postId, { sort: "new", limit: 200 }),
      ]);
      res.json({
        canView: true,
        connected,
        isAdmin,
        viewerAddress: address,
        permissions: perms,
        post,
        comments: buildCommentTree(comments.comments),
      });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// DELETE /api/bunny/:id/forum/posts/:postId — soft-delete a post. bunnyOS allows
// the author, a moderator, the owner, or an admin; returns the tombstoned post.
router.delete(
  "/bunny/:id/forum/posts/:postId",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    try {
      const post = await deleteThreadPost(bunnyId, req.params.postId);
      res.json({ post });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// POST /api/bunny/:id/forum/posts/:postId/comments — add a comment (or a reply
// when parentCommentId is set). bunnyOS enforces holder/ban gating.
router.post(
  "/bunny/:id/forum/posts/:postId/comments",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const parsed = ForumCommentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid comment" });
      return;
    }
    try {
      const created = await createPostComment(bunnyId, req.params.postId, {
        body: parsed.data.body,
        parentCommentId: parsed.data.parentCommentId ?? null,
      });
      // Authors auto-upvote their own reply. Best-effort: on vote failure we
      // still return the created comment so the write isn't lost.
      const comment = await setCommentVote(
        bunnyId,
        req.params.postId,
        created.id,
        "up",
      ).catch(() => created);
      res.json({ comment });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// DELETE /api/bunny/:id/forum/posts/:postId/comments/:commentId — soft-delete a
// comment (author/moderator/owner/admin). Returns the tombstoned comment.
router.delete(
  "/bunny/:id/forum/posts/:postId/comments/:commentId",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    try {
      const comment = await deletePostComment(
        bunnyId,
        req.params.postId,
        req.params.commentId,
      );
      res.json({ comment });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// PUT /api/bunny/:id/forum/posts/:postId/vote — cast/replace the caller's vote.
router.put(
  "/bunny/:id/forum/posts/:postId/vote",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const parsed = ForumVoteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid vote" });
      return;
    }
    try {
      const post = await setPostVote(
        bunnyId,
        req.params.postId,
        parsed.data.direction as ThreadVoteDirection,
      );
      res.json({ post });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// DELETE /api/bunny/:id/forum/posts/:postId/vote — clear the caller's vote.
router.delete(
  "/bunny/:id/forum/posts/:postId/vote",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    try {
      const post = await clearPostVote(bunnyId, req.params.postId);
      res.json({ post });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// PUT /api/bunny/:id/forum/posts/:postId/comments/:commentId/vote
router.put(
  "/bunny/:id/forum/posts/:postId/comments/:commentId/vote",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const parsed = ForumVoteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid vote" });
      return;
    }
    try {
      const comment = await setCommentVote(
        bunnyId,
        req.params.postId,
        req.params.commentId,
        parsed.data.direction as ThreadVoteDirection,
      );
      res.json({ comment });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// DELETE /api/bunny/:id/forum/posts/:postId/comments/:commentId/vote
router.delete(
  "/bunny/:id/forum/posts/:postId/comments/:commentId/vote",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    try {
      const comment = await clearCommentVote(
        bunnyId,
        req.params.postId,
        req.params.commentId,
      );
      res.json({ comment });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// GET /api/bunny/:id/forum/moderators — list thread moderators (owner/admin).
router.get(
  "/bunny/:id/forum/moderators",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    try {
      const moderators = await listThreadModerators(bunnyId);
      res.json({ moderators });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// PUT /api/bunny/:id/forum/moderators/:address — promote a key holder to mod.
router.put(
  "/bunny/:id/forum/moderators/:address",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const address = normAddress(req.params.address);
    if (!address) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    try {
      const moderator = await promoteThreadModerator(bunnyId, address);
      res.json({ moderator });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// DELETE /api/bunny/:id/forum/moderators/:address — demote a moderator.
router.delete(
  "/bunny/:id/forum/moderators/:address",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const address = normAddress(req.params.address);
    if (!address) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    try {
      await demoteThreadModerator(bunnyId, address);
      res.json({ ok: true });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// GET /api/bunny/:id/forum/bans — list banned addresses (moderator/owner/admin).
router.get("/bunny/:id/forum/bans", async (req, res): Promise<void> => {
  const bunnyId = toBunnyId(req.params.id);
  if (bunnyId === null) {
    res.status(400).json({ error: "invalid bunny id" });
    return;
  }
  try {
    const bans = await listThreadBans(bunnyId);
    res.json({ bans });
  } catch (err) {
    sendForumError(res, err);
  }
});

// PUT /api/bunny/:id/forum/bans/:address — ban an address from the threads.
router.put(
  "/bunny/:id/forum/bans/:address",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const address = normAddress(req.params.address);
    if (!address) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    try {
      const ban = await banThreadUser(bunnyId, address);
      res.json({ ban });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);

// DELETE /api/bunny/:id/forum/bans/:address — lift a ban.
router.delete(
  "/bunny/:id/forum/bans/:address",
  async (req, res): Promise<void> => {
    const bunnyId = toBunnyId(req.params.id);
    if (bunnyId === null) {
      res.status(400).json({ error: "invalid bunny id" });
      return;
    }
    const address = normAddress(req.params.address);
    if (!address) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    try {
      await unbanThreadUser(bunnyId, address);
      res.json({ ok: true });
    } catch (err) {
      sendForumError(res, err);
    }
  },
);
export default router;
