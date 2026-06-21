import { Router, type IRouter } from "express";
import { callBankrTool } from "../lib/bankr";
import { parseToolContent } from "../lib/toon";
import {
  getCoinGeckoPoolData,
  getCoinGeckoTokenOhlcv,
  getCoinGeckoTokenOnchain,
  getCoinGeckoTrendingTokens,
  searchCoinGeckoOnchainTokens,
  coinGeckoStatus,
  type CoinGeckoMarketData,
  type CoinGeckoOhlcvPoint,
} from "../lib/coingecko";
import {
  getTokenSecurity,
  getTokenSecuritySafe,
  summarizeSecurity,
} from "../lib/token-security";
import { getTokenDistributionSafe, summarizeDistribution } from "../lib/gmgn";
import { streamBunny, normalizeAgentLang, type AgentLang } from "../lib/bunny-agent";
import { take } from "../lib/rate-limit";
import { getCurrentUserId } from "../lib/user";
import { isProtocolEnabled } from "../lib/settings";

const router: IRouter = Router();

// Normalized, frontend-facing shape for a single trending token. Trimmed
// server-side so the client only receives the columns the explorer table
// renders — the raw Moralis payload carries far more (4 price-change and 4
// volume windows, security fields, etc.).
interface TrendingToken {
  tokenAddress: string;
  symbol: string;
  name: string;
  logo: string | null;
  usdPrice: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  createdAt: number | null; // unix seconds
  pricePercentChange1h: number | null;
  pricePercentChange24h: number | null;
  totalVolume24h: number | null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Bankr's recent token launches carry no price/liquidity/volume/holder
// metrics — only identity (name, symbol, address, chain), the Uniswap v4 pool
// id the token launched into, plus a launch timestamp (ms). We map identity
// into the shared TrendingToken shape (metrics left null) and keep the pool id
// alongside so CoinGecko (onchain pools endpoint) can fill the market columns
// afterward.
interface BankrLaunch {
  token: TrendingToken;
  poolId: string | null;
}

function normalizeBankrLaunch(raw: unknown): BankrLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const tokenAddress = str(o["tokenAddress"] ?? o["address"] ?? o["token_address"]);
  if (!tokenAddress) return null;
  // Tokens hunt is base-focused (the buy flow trades base USDC). Drop any
  // non-base launches Bankr might surface.
  const chain = str(o["chain"]).toLowerCase();
  if (chain && chain !== "base") return null;
  const tsMs = num(o["timestamp"] ?? o["launchedAt"] ?? o["createdAt"]);
  const poolId = str(o["poolId"] ?? o["pool_id"] ?? o["poolAddress"]);
  return {
    token: {
      tokenAddress,
      symbol: str(o["tokenSymbol"] ?? o["symbol"]),
      name: str(o["tokenName"] ?? o["name"]),
      logo: null,
      usdPrice: null,
      marketCap: null,
      liquidityUsd: null,
      holders: null,
      createdAt: tsMs !== null ? Math.round(tsMs / 1000) : null,
      pricePercentChange1h: null,
      pricePercentChange24h: null,
      totalVolume24h: null,
    },
    poolId: poolId || null,
  };
}

function normalizeBankrLaunches(parsed: unknown): BankrLaunch[] {
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    arr = o["launches"] ?? o["data"] ?? o["results"] ?? o["items"];
  }
  if (!Array.isArray(arr)) return [];
  const out: BankrLaunch[] = [];
  for (const item of arr) {
    const t = normalizeBankrLaunch(item);
    if (t) out.push(t);
  }
  return out;
}

// --- CoinGecko onchain enrichment for Bankr launches ---------------------
// Bankr launches arrive with no market data, just the Uniswap v4 pool id each
// token launched into. We batch those pool ids to CoinGecko's onchain pools
// endpoint (30 per call; requires the demo key — no keyless fallback) and fill
// price, liquidity, market cap, 1h/24h change, and volume.
// We key on the pool id rather than the token address on purpose: a token-
// address lookup reports `liquidity: null` for these v4 "doppler" pools and
// silently caps how many pairs it returns per call (dropping launches near the
// end of a batch). The pool lookup returns real liquidity for every pool id we
// ask about. Best-effort: any pool it hasn't indexed yet keeps its nulls.

// Public on-chain data is identical across users, so a process-wide short-TTL
// cache dedupes lookups across users and back-to-back refreshes without leaking
// anything user-scoped.
const ENRICH_TTL_MS = 70_000;
const marketCache = new Map<string, { at: number; value: CoinGeckoMarketData }>();

const EMPTY_MARKET: CoinGeckoMarketData = {
  usdPrice: null,
  liquidityUsd: null,
  marketCap: null,
  pricePercentChange1h: null,
  pricePercentChange24h: null,
  totalVolume24h: null,
};

async function enrichWithCoinGeckoOnchain(launches: BankrLaunch[]): Promise<TrendingToken[]> {
  if (launches.length === 0) return [];

  const now = Date.now();
  const byPool = new Map<string, CoinGeckoMarketData>();
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const { poolId } of launches) {
    if (!poolId) continue;
    const key = poolId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = marketCache.get(key);
    if (hit && now - hit.at < ENRICH_TTL_MS) {
      byPool.set(key, hit.value);
    } else {
      missing.push(poolId);
    }
  }

  if (missing.length > 0) {
    try {
      const { data, queried } = await getCoinGeckoPoolData(missing, "base");
      for (const [pool, value] of data) {
        marketCache.set(pool, { at: now, value });
        byPool.set(pool, value);
      }
      // Negative cache only pool ids whose lookup actually succeeded but
      // returned no pool. Ids dropped by a transient failure are left uncached
      // so the next refresh retries them.
      for (const pool of queried) {
        if (!byPool.has(pool)) {
          marketCache.set(pool, { at: now, value: EMPTY_MARKET });
          byPool.set(pool, EMPTY_MARKET);
        }
      }
    } catch {
      // best-effort: leave whatever the cache already had
    }
  }

  return launches.map(({ token, poolId }) => {
    const m = poolId ? byPool.get(poolId.toLowerCase()) : undefined;
    if (!m) return token;
    return {
      ...token,
      usdPrice: m.usdPrice ?? token.usdPrice,
      marketCap: m.marketCap ?? token.marketCap,
      liquidityUsd: m.liquidityUsd ?? token.liquidityUsd,
      pricePercentChange1h: m.pricePercentChange1h ?? token.pricePercentChange1h,
      pricePercentChange24h: m.pricePercentChange24h ?? token.pricePercentChange24h,
      totalVolume24h: m.totalVolume24h ?? token.totalVolume24h,
    };
  });
}

// Scam guard: impersonator tokens borrow the bunnyOS name to look legit in the
// research lists. Hide any token that mentions "bunnyos" in its name, symbol or
// (where the source provides it) description. We strip non-alphanumerics before
// matching so "Bunny OS", "bunny-os" and "BunnyOS" are all caught.
function mentionsBunnyOs(...values: (string | null | undefined)[]): boolean {
  for (const v of values) {
    if (!v) continue;
    if (v.toLowerCase().replace(/[^a-z0-9]/g, "").includes("bunnyos")) return true;
  }
  return false;
}

function dropBunnyOsScams(tokens: TrendingToken[]): TrendingToken[] {
  return tokens.filter((t) => !mentionsBunnyOs(t.name, t.symbol));
}

async function loadBankrTokens(limit: number): Promise<TrendingToken[]> {
  const result = await callBankrTool("bankr_recent_token_launches", {});
  if (result.isError) {
    throw new Error(result.content.slice(0, 300));
  }
  let parsed: unknown;
  try {
    parsed = parseToolContent(result.content);
  } catch {
    throw new Error("failed to parse bankr response");
  }
  const launches = normalizeBankrLaunches(parsed).slice(0, limit);
  // Pull token-level aggregate onchain volume (sum across all pools) alongside
  // the per-pool enrichment, then override volume with the aggregate — a single
  // pool's volume undercounts the token's true onchain volume.
  const tokenInfo = await getCoinGeckoTokenOnchain(
    launches.map((l) => l.token.tokenAddress),
    "base",
  );
  const enriched = (await enrichWithCoinGeckoOnchain(launches)).map((t) => {
    const aggVol = tokenInfo.get(t.tokenAddress.toLowerCase())?.volume24h;
    return aggVol != null ? { ...t, totalVolume24h: aggVol } : t;
  });
  // Auto-hide dead launches: only surface pairs with at least $10 of 24h
  // volume. This drops both pools we couldn't resolve (null volume) and ones
  // with effectively no trading activity, so the list stays to real, tradeable
  // launches instead of empty "—" rows.
  return dropBunnyOsScams(enriched.filter((t) => (t.totalVolume24h ?? 0) >= 10));
}

// Trending Base tokens from CoinGecko's onchain trending-pools endpoint
// (`/onchain/networks/base/trending_pools`). Each trending pool is mapped to
// its base token; identity + market columns come straight from the pool, then
// volume is overridden with the token's aggregate 24h onchain volume across all
// pools (consistent with the other loaders and the app's CoinGecko mandate).
async function loadCoinGeckoTokens(limit: number): Promise<TrendingToken[]> {
  const trending = await getCoinGeckoTrendingTokens(limit, "base");
  const tokens: TrendingToken[] = trending.map((t) => ({
    tokenAddress: t.tokenAddress,
    symbol: t.symbol,
    name: t.name,
    logo: t.logo,
    usdPrice: t.usdPrice,
    marketCap: t.marketCap,
    liquidityUsd: t.liquidityUsd,
    holders: null,
    createdAt: t.createdAt,
    pricePercentChange1h: t.pricePercentChange1h,
    pricePercentChange24h: t.pricePercentChange24h,
    totalVolume24h: t.totalVolume24h,
  }));
  const filtered = dropBunnyOsScams(tokens);
  const tokenInfo = await getCoinGeckoTokenOnchain(
    filtered.map((t) => t.tokenAddress),
    "base",
  );
  return filtered.map((t) => {
    const aggVol = tokenInfo.get(t.tokenAddress.toLowerCase())?.volume24h;
    return aggVol != null ? { ...t, totalVolume24h: aggVol } : t;
  });
}

// --- Virtuals Protocol launched agent tokens ----------------------------
// virtuals.io lists AI-agent tokens. status=3 ("AVAILABLE") = graduated /
// trading, so each has a real ERC-20 `tokenAddress`. We keep base-chain tokens
// only. Identity (name, symbol, logo), holder count and launch age come from
// virtuals; every market figure (price, market cap, liquidity, volume, %
// change) is left null here and filled from CoinGecko in
// enrichWithCoinGeckoOnchain — the app sources ALL market data from CoinGecko.
// poolId is virtuals' reported `lpAddress`, used only as a fallback: it's
// sometimes the token address itself (degenerate), so loadVirtualsTokens
// resolves each token's real top pool from CoinGecko first.
function normalizeVirtualsLaunch(raw: unknown): BankrLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const tokenAddress = str(o["tokenAddress"]);
  if (!tokenAddress) return null;
  const chain = str(o["chain"]).toLowerCase();
  if (chain && chain !== "base") return null;
  // Scam guard: drop impersonators that put "bunnyos" in their name, symbol or
  // description. Virtuals is the one source whose raw payload carries a
  // description, so check it here; name/symbol are also re-checked downstream.
  if (mentionsBunnyOs(str(o["name"]), str(o["symbol"]), str(o["description"]))) {
    return null;
  }
  const img = o["image"];
  const logo =
    img && typeof img === "object"
      ? str((img as Record<string, unknown>)["url"]) || null
      : null;
  const poolId = str(o["lpAddress"]);
  return {
    token: {
      tokenAddress,
      symbol: str(o["symbol"]),
      name: str(o["name"]),
      logo,
      usdPrice: null,
      marketCap: null,
      liquidityUsd: null,
      // holderCount is a token stat CoinGecko's onchain pools don't return, so
      // it's the one figure carried over from virtuals.
      holders: num(o["holderCount"]),
      createdAt: toUnixSeconds(o["lpCreatedAt"] ?? o["createdAt"]),
      pricePercentChange1h: null,
      pricePercentChange24h: null,
      totalVolume24h: null,
    },
    poolId: poolId || null,
  };
}

function normalizeVirtualsLaunches(parsed: unknown): BankrLaunch[] {
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    arr = (parsed as Record<string, unknown>)["data"];
  }
  if (!Array.isArray(arr)) return [];
  const out: BankrLaunch[] = [];
  for (const item of arr) {
    const t = normalizeVirtualsLaunch(item);
    if (t) out.push(t);
  }
  return out;
}

async function loadVirtualsTokens(limit: number): Promise<TrendingToken[]> {
  // Over-fetch the max page, then keep the most actively-traded tokens.
  const pageSize = 100;
  // sort=volume24h:desc surfaces the most actively-traded graduated agent tokens
  // regardless of age. Sorting by lpCreatedAt:desc instead only showed the
  // newest ~100 graduations — and since graduations are infrequent, that window
  // missed established high-volume tokens (e.g. DEUS, REPPO) while surfacing
  // dead months-old launches. status=3 keeps it to graduated/tradeable tokens.
  const url =
    "https://api.virtuals.io/api/virtuals?filters%5Bstatus%5D=3" +
    "&sort=volume24h%3Adesc" +
    `&pagination%5Bpage%5D=1&pagination%5BpageSize%5D=${pageSize}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    throw new Error(`virtuals http ${r.status}`);
  }
  const parsed = (await r.json()) as unknown;
  const launches = normalizeVirtualsLaunches(parsed);
  // Resolve each token's real top pool from CoinGecko by token address, since
  // virtuals' reported lpAddress is unreliable (sometimes the token address
  // itself). Fall back to the reported lpAddress when CoinGecko has no pool.
  // The same call also returns the token's aggregate onchain 24h volume across
  // all its pools, which is the true volume (a single pool undercounts it).
  const tokenInfo = await getCoinGeckoTokenOnchain(
    launches.map((l) => l.token.tokenAddress),
    "base",
  );
  const withPools = launches.map((l) => ({
    ...l,
    poolId: tokenInfo.get(l.token.tokenAddress.toLowerCase())?.pool ?? l.poolId,
  }));
  // Fill price/liquidity/% change from CoinGecko via the resolved top pool, then
  // override volume with the token-level aggregate (sum across all pools).
  const enriched = (await enrichWithCoinGeckoOnchain(withPools)).map((t) => {
    const aggVol = tokenInfo.get(t.tokenAddress.toLowerCase())?.volume24h;
    return aggVol != null ? { ...t, totalVolume24h: aggVol } : t;
  });
  // Auto-hide dead launches, same as bankr: only surface pairs with at least
  // $10 of 24h volume. This drops both pools we couldn't resolve (null volume)
  // and tokens with no current trading activity, so the list stays to real,
  // currently-tradeable agent tokens instead of "—" rows.
  return dropBunnyOsScams(
    enriched.filter((t) => (t.totalVolume24h ?? 0) >= 10),
  ).slice(0, limit);
}

// The explorer table is expensive to populate — each trending fetch burns a
// chunk of the per-user rate budget per call — so the result list is cached
// process-wide for an hour, keyed by source+limit. Page revisits (which remount
// the query after React Query's gc) serve from cache instead of re-hitting the
// upstream API; the client only forces a fresh fetch via `?fresh=1` when the
// user clicks refresh. The data is identical across users (global trending /
// recent launches), so a shared cache leaks nothing user-scoped.
const LIST_TTL_MS = 60 * 60 * 1000;
const listCache = new Map<string, { at: number; tokens: TrendingToken[] }>();

// Live Base tokens for the explorer table. Three sources, selected via the
// `source` query param: "coingecko" (onchain trending pools, default),
// "virtuals" (graduated AI-agent tokens) and "bankr" (recent launches). All
// reuse the app's CoinGecko onchain data for market columns and respect the
// same auth + per-user settings. All filtering/sorting happens client-side.
router.get("/tokens", async (req, res): Promise<void> => {
  const sourceParam = req.query["source"];
  const source =
    sourceParam === "bankr"
      ? "bankr"
      : sourceParam === "virtuals"
        ? "virtuals"
        : "coingecko";
  const limitRaw = Number(req.query["limit"]);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100)
    : 100;
  const fresh = req.query["fresh"] === "1" || req.query["fresh"] === "true";
  const cacheKey = `${source}:${limit}`;

  // The cache hit is checked only *after* the per-user protocol/key guards
  // below, so a process-wide cache can never let a user past their own feature
  // gating. The token data itself is global (trending / recent launches), so the
  // shared cache leaks nothing user-scoped.
  const cached = (): TrendingToken[] | null => {
    if (fresh) return null;
    const hit = listCache.get(cacheKey);
    return hit && Date.now() - hit.at < LIST_TTL_MS ? hit.tokens : null;
  };

  if (source === "bankr") {
    if (!isProtocolEnabled("bankr")) {
      res.status(403).json({
        error: "bankr is disabled — enable it in configure → services to browse launches.",
      });
      return;
    }
    const hit = cached();
    if (hit) {
      res.json({ tokens: hit });
      return;
    }
    try {
      const tokens = await loadBankrTokens(limit);
      listCache.set(cacheKey, { at: Date.now(), tokens });
      res.json({ tokens });
    } catch (err) {
      req.log.error({ err }, "bankr token list failed");
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ error: message });
    }
    return;
  }

  // Virtuals is a keyless public source (virtuals.io), so no protocol/key
  // guard — it's always available as a research source.
  if (source === "virtuals") {
    const hit = cached();
    if (hit) {
      res.json({ tokens: hit });
      return;
    }
    try {
      const tokens = await loadVirtualsTokens(limit);
      listCache.set(cacheKey, { at: Date.now(), tokens });
      res.json({ tokens });
    } catch (err) {
      req.log.error({ err }, "virtuals token list failed");
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ error: message });
    }
    return;
  }

  if (!isProtocolEnabled("coingecko")) {
    res.status(403).json({
      error: "coingecko is disabled — enable it in configure → services to browse tokens.",
    });
    return;
  }
  if (!coinGeckoStatus().connected) {
    res.status(400).json({
      error: "coingecko api key not configured — add one in configure → llm.",
    });
    return;
  }
  const hit = cached();
  if (hit) {
    res.json({ tokens: hit });
    return;
  }
  try {
    const tokens = await loadCoinGeckoTokens(limit);
    listCache.set(cacheKey, { at: Date.now(), tokens });
    res.json({ tokens });
  } catch (err) {
    req.log.error({ err }, "token list failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// Coerce a value into unix seconds, tolerating numeric seconds, numeric
// milliseconds, and ISO date strings (Moralis metadata returns `created_at`
// as an ISO string).
function toUnixSeconds(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n > 1e12 ? Math.round(n / 1000) : n;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return Math.round(ms / 1000);
  }
  return null;
}

// Look for a token in any cached trending/launches list first — those rows
// carry the full metric set (liquidity, volume, holders), which is richer than
// a fresh onchain lookup, and it avoids burning CoinGecko calls.
function findInListCache(address: string): TrendingToken | null {
  const lower = address.toLowerCase();
  for (const { tokens } of listCache.values()) {
    const hit = tokens.find((t) => t.tokenAddress.toLowerCase() === lower);
    if (hit) return hit;
  }
  return null;
}

// The official bunnyOS token. Pinned to the top of search results when the user
// searches the brand terms, and exempt from the impersonator filter on direct
// lookups (it is itself named "bunnyOS"). Lowercased for comparisons.
const OFFICIAL_BUNNYOS_ADDRESS =
  "0xD34cF0759cb65A0fe508bb1DaE0A16Cb5109bB7B";

// Resolve a single token's market data by contract address via the CoinGecko
// onchain (GeckoTerminal proxy) pool search, which tolerates an address query.
// Picks the matching token's deepest-liquidity pool. Returns null when CoinGecko
// has no pool for the address. The search helper never throws (returns [] on
// error), so callers don't need a try/catch for network failures.
async function resolveTokenViaCoinGecko(
  address: string,
): Promise<TrendingToken | null> {
  const lower = address.toLowerCase();
  const results = await searchCoinGeckoOnchainTokens(address, "base");
  const hit = results.find((r) => r.address.toLowerCase() === lower) ?? null;
  if (!hit) return null;
  return {
    tokenAddress: hit.address,
    symbol: hit.symbol,
    name: hit.name,
    logo: hit.logo,
    usdPrice: hit.usdPrice,
    marketCap: hit.marketCap,
    liquidityUsd: hit.liquidityUsd,
    holders: null,
    createdAt: null,
    pricePercentChange1h: hit.pricePercentChange1h,
    pricePercentChange24h: hit.pricePercentChange24h,
    totalVolume24h: hit.totalVolume24h,
  };
}

// Best-effort, never-throws resolution of a token by address: list cache first,
// then CoinGecko when available. Used to pin the official bunnyOS token in search.
async function resolveTokenSafe(address: string): Promise<TrendingToken | null> {
  const cached = findInListCache(address);
  if (cached) return cached;
  if (!isProtocolEnabled("coingecko") || !coinGeckoStatus().connected) return null;
  try {
    return await resolveTokenViaCoinGecko(address);
  } catch {
    return null;
  }
}

// Single-token lookup by contract address — backs shareable report links
// (/terminal/report/<address>), where the opener only has the address and must
// hydrate the report panel without the trending list. Prefers the shared list
// cache, then falls back to a CoinGecko onchain pool lookup.
router.get("/tokens/by-address", async (req, res): Promise<void> => {
  const address = String(req.query.address ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "valid token address is required" });
    return;
  }
  const rate = take(getCurrentUserId(), "token");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    return;
  }

  const cachedHit = findInListCache(address);
  if (cachedHit) {
    res.json({ token: cachedHit });
    return;
  }

  if (!isProtocolEnabled("coingecko") || !coinGeckoStatus().connected) {
    res.status(400).json({
      error:
        "Token lookup needs CoinGecko. Open Configure → llm → coingecko api key to enable it.",
    });
    return;
  }

  try {
    // No bunnyOS impersonator guard here: a direct contract-address lookup is an
    // explicit, unambiguous request for that exact token (the user pasted the
    // CA), so we hydrate the report regardless of name. The impersonator filter
    // only applies to discovery lists/search, where fake "bunnyOS" tokens sneak
    // in among results the user didn't specifically ask for.
    const token = await resolveTokenViaCoinGecko(address);
    res.json({ token });
  } catch (err) {
    req.log.error({ err }, "token by-address lookup failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// Free-text token search by name, ticker, or contract address. Backs the
// Research page search box: a 0x address is handled by /by-address on the
// client (CoinGecko onchain lookup); this route covers name/ticker (and
// tolerates addresses) via the CoinGecko onchain pool search. Returns a
// ranked list of candidates the client renders as a dropdown.
router.get("/tokens/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.status(400).json({ error: "Enter at least 2 characters to search." });
    return;
  }

  const rate = take(getCurrentUserId(), "token");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    return;
  }

  if (!isProtocolEnabled("coingecko") || !coinGeckoStatus().connected) {
    res.status(400).json({
      error:
        "Token search needs CoinGecko. Open Configure → llm → coingecko api key to enable it.",
    });
    return;
  }

  try {
    const results = await searchCoinGeckoOnchainTokens(q, "base");
    const mapped: TrendingToken[] = results.map((r) => ({
      tokenAddress: r.address,
      symbol: r.symbol,
      name: r.name,
      logo: r.logo,
      usdPrice: r.usdPrice,
      marketCap: r.marketCap,
      liquidityUsd: r.liquidityUsd,
      holders: null,
      createdAt: null,
      pricePercentChange1h: r.pricePercentChange1h,
      pricePercentChange24h: r.pricePercentChange24h,
      totalVolume24h: r.totalVolume24h,
    }));

    // The impersonator filter strips every "bunnyOS"-named token, including the
    // real one. Pull the official token out of the CoinGecko results by its
    // known address first (allowlisted through the filter, no Moralis needed),
    // then drop it + any impersonators from the rest of the list.
    const officialLower = OFFICIAL_BUNNYOS_ADDRESS.toLowerCase();
    const officialFromSearch =
      mapped.find((t) => t.tokenAddress.toLowerCase() === officialLower) ?? null;
    const tokens = mapped.filter(
      (t) =>
        t.tokenAddress.toLowerCase() !== officialLower &&
        !mentionsBunnyOs(t.name, t.symbol),
    );

    // Pin the official bunnyOS token to the top when the user searches the brand
    // terms. Prefer the row already in the search results; only fall back to a
    // direct resolve (list cache → Moralis) if the search didn't surface it.
    const norm = q.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm === "bunnyos" || norm === "bunny" || norm === "os") {
      const official =
        officialFromSearch ?? (await resolveTokenSafe(OFFICIAL_BUNNYOS_ADDRESS));
      if (official) {
        res.json({ tokens: [official, ...tokens] });
        return;
      }
    }

    res.json({ tokens });
  } catch (err) {
    req.log.error({ err }, "token search failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

interface ReportTokenInput {
  tokenAddress: string;
  symbol?: string;
  name?: string;
  usdPrice?: number | null;
  marketCap?: number | null;
  liquidityUsd?: number | null;
  holders?: number | null;
  createdAt?: number | null;
  pricePercentChange1h?: number | null;
  pricePercentChange24h?: number | null;
  totalVolume24h?: number | null;
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "unknown";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 8 : 2 })}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "unknown";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtAge(createdAt: number | null | undefined): string {
  if (createdAt === null || createdAt === undefined || !Number.isFinite(createdAt)) {
    return "unknown";
  }
  const days = (Date.now() / 1000 - createdAt) / 86400;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h old`;
  return `${Math.round(days)}d old`;
}

function buildReportPrompt(
  t: ReportTokenInput,
  securitySummary?: string,
  distributionSummary?: string,
  lang: AgentLang = "en",
): string {
  const lines = [
    `write a professional but plain-spoken research brief for this base token. output github-flavored markdown. keep the prose lowercase (brand voice), tight, and skimmable.`,
    ``,
    `use exactly these four sections, in this order, each as a markdown heading with "## ":`,
    `## summary`,
    `## market`,
    `## risk`,
    `## verdict`,
    ``,
    `token: ${t.name || "(unknown)"} (${t.symbol || "?"})`,
    `contract: ${t.tokenAddress}`,
    `price: ${fmtUsd(t.usdPrice)}`,
    `market cap: ${fmtUsd(t.marketCap)}`,
    `liquidity: ${fmtUsd(t.liquidityUsd)}`,
    `24h onchain volume (aggregated across all dex pools, excludes cex): ${fmtUsd(t.totalVolume24h)}`,
    `1h change: ${fmtPct(t.pricePercentChange1h)}`,
    `24h change: ${fmtPct(t.pricePercentChange24h)}`,
    `holders: ${t.holders ?? "unknown"}`,
    `age: ${fmtAge(t.createdAt)}`,
  ];
  if (securitySummary) {
    lines.push(``, securitySummary);
  }
  if (distributionSummary) {
    lines.push(``, distributionSummary);
  }
  lines.push(
    ``,
    `section guidance:`,
    `- ## summary: 1-2 sentences — what this token is and the headline read.`,
    `- ## market: 3-5 bullet points (use "- ") on traction: volume relative to liquidity, momentum across 1h vs 24h, holder count, and market-cap / liquidity ratio (thin float = dump risk).`,
    `- ## risk: 3-5 bullet points (use "- ") on risk: liquidity depth, token age (newer = riskier), and holder concentration — call moralis_token_holders for this contract on base if it helps assess whether the top holder dominates supply.` +
      (securitySummary
        ? ` also factor in the gmgn contract-security data above — unrenounced ownership and any critical/high severity findings (honeypot, blocked sells, blacklist, high trading taxes, unverified source) are major red flags. mention anything notable.`
        : ` note that automated contract-security data was unavailable.`) +
      (distributionSummary
        ? ` factor in the gmgn holder-distribution data above too — high top-10 concentration, little/no locked liquidity, and a low burn are dump/rug risks.`
        : ``) +
      ` launchpad provenance is a mitigating signal: if this token was launched through a reputable launchpad's standard contract (virtuals, bankr, clanker, etc.), treat contract-level rug/honeypot risk as lower, since those templated launches remove owner mint/blacklist/hidden-fee backdoors — but note that this trusts the launchpad as an honest actor and does not remove market risk (thin liquidity, holder concentration, dumps).`,
    `- ## verdict: end with a bold line exactly like "**relative risk: low | medium | high**" (pick one), followed by a one-clause reason.`,
    `  risk calibration — be measured, not alarmist: reserve "high" for tokens that look probably scammy or shady (honeypot, very high buy/sell taxes, mintable/pausable/reclaimable ownership, a single wallet controlling most of supply, or similar hard red flags). ordinary speculative concerns like thin liquidity, young age, or modest volume are "low" or "medium", not "high". if nothing points to a scam, do not say "high".`,
    ``,
    `use **bold** for emphasis on key numbers or flags. do not give financial advice or price predictions. do not propose or prepare any transaction. keep the whole brief under ~16 short lines.`,
  );
  if (lang === "zh") {
    lines.push(
      ``,
      `重要（语言）：用简体中文撰写整篇简报。四个小标题写作 "## 概要"、"## 市场"、"## 风险"、"## 结论"。忽略上面关于全部小写的要求。代币符号、合约地址、数字、URL、协议名称保留原文。结论以加粗行结尾，写作 "**相对风险：低 | 中 | 高**"（三选一），其后跟一句简短理由。`,
    );
  } else if (lang === "ko") {
    lines.push(
      ``,
      `중요(언어): 전체 브리프를 한국어로 작성하세요. 네 개의 제목은 "## 요약"、"## 시장"、"## 리스크"、"## 결론"으로 작성합니다. 위의 소문자 규칙은 무시하세요. 토큰 티커, 컨트랙트 주소, 숫자, URL, 프로토콜 이름은 원문 그대로 두세요. 결론은 "**상대 리스크: 낮음 | 중간 | 높음**" 형식의 굵은 줄로 끝내고 한 구절의 이유를 덧붙이세요.`,
    );
  } else {
    lines.push(
      ``,
      `important (language): write the entire brief in English, regardless of the language of any tool output or memory. keep token tickers, contract addresses, numbers, URLs, and protocol names in their original form.`,
    );
  }
  return lines.join("\n");
}

// Fresh, single-token AI report streamed over SSE. Reuses the same agent
// (streamBunny) and chat rate limit as /chat/stream — no persistence, each
// click regenerates.
router.post("/tokens/report/stream", async (req, res): Promise<void> => {
  const body = req.body as Partial<ReportTokenInput>;
  if (!body || typeof body.tokenAddress !== "string" || !body.tokenAddress) {
    res.status(400).json({ error: "tokenAddress is required" });
    return;
  }

  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");
  const flush = (res as unknown as { flush?: () => void }).flush;
  if (typeof flush === "function") flush.call(res);

  const write = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof flush === "function") flush.call(res);
  };

  let closed = false;
  const keepAlive = setInterval(() => {
    if (closed) return;
    res.write(": ping\n\n");
    if (typeof flush === "function") flush.call(res);
  }, 15000);
  res.on("close", () => {
    closed = true;
    clearInterval(keepAlive);
  });

  const lang = normalizeAgentLang((body as { lang?: unknown }).lang);
  const [security, distribution] = await Promise.all([
    getTokenSecuritySafe(body.tokenAddress),
    getTokenDistributionSafe(body.tokenAddress),
  ]);
  const prompt = buildReportPrompt(
    body as ReportTokenInput,
    security ? summarizeSecurity(security) : undefined,
    distribution ? summarizeDistribution(distribution) : undefined,
    lang,
  );

  try {
    for await (const ev of streamBunny(prompt, undefined, lang)) {
      if (closed) break;
      write(ev);
    }
  } catch (err) {
    req.log.error({ err }, "token report stream failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    write({ type: "error", message });
  } finally {
    clearInterval(keepAlive);
    if (!closed) {
      res.write("event: end\ndata: {}\n\n");
      res.end();
    }
  }
});

// GMGN token-security data for the report: severity-ranked contract-safety
// findings (honeypot, blocked sells, blacklist, taxes, unverified source) plus
// ownership-renounced. Cached server-side (5 min) so repeated panel renders and
// the report stream share one upstream call. Returns a null payload when GMGN
// has no data for the contract or is not connected / the protocol is disabled.
router.get("/tokens/security", async (req, res): Promise<void> => {
  const address = String(req.query.address ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "valid token address is required" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    const security = await getTokenSecurity(address);
    res.json({ security });
  } catch (err) {
    req.log.error({ err }, "gmgn security lookup failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// Aggregate holder/distribution metrics from GMGN for the report UI. Returns
// `{ distribution: null }` when GMGN is disabled, the user has no key, or no
// useful data comes back — the panel just omits itself. Never errors on
// missing data (only on a thrown bug), mirroring the security panel.
router.get("/tokens/distribution", async (req, res): Promise<void> => {
  const address = String(req.query.address ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "valid token address is required" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    const distribution = await getTokenDistributionSafe(address);
    res.json({ distribution });
  } catch (err) {
    req.log.error({ err }, "gmgn distribution lookup failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

// Daily price/volume OHLCV for a single token, used to draw the static price
// chart embedded in the downloadable PDF report (the on-screen chart is a
// cross-origin GeckoTerminal iframe that can't be rendered into a PDF). Data
// comes from the CoinGecko demo onchain API only. Public on-chain data is
// identical across users, so the result is cached process-wide (5 min). Returns
// an empty array when unavailable so the report omits the chart gracefully.
const CHART_TTL_MS = 5 * 60 * 1000;
const chartCache = new Map<string, { at: number; points: CoinGeckoOhlcvPoint[] }>();

router.get("/tokens/chart", async (req, res): Promise<void> => {
  const address = String(req.query.address ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "valid token address is required" });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    return;
  }
  const key = address.toLowerCase();
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < CHART_TTL_MS) {
    res.json({ chart: hit.points });
    return;
  }
  try {
    const points = await getCoinGeckoTokenOhlcv(address, "base", {
      timeframe: "day",
      limit: 30,
    });
    chartCache.set(key, { at: Date.now(), points });
    res.json({ chart: points });
  } catch (err) {
    req.log.error({ err }, "token chart lookup failed");
    // Best-effort: the chart is optional, so never fail the report over it.
    res.json({ chart: [] });
  }
});

export default router;
