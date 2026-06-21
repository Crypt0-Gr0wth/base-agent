import crypto from "node:crypto";
import { logger } from "./logger";
import { getGmgnApiKey, getBunnyDsEnabled, isProtocolEnabled } from "./settings";
import {
  gatewayAuthHeaders,
  gatewayCloudUrl,
  isGatewayConfigured,
} from "./bunnyos-gateway";
import { withApiCache } from "./api-cache";

// GET reads go through the durable DB cache so repeat lookups stay off bunnyDS.
// 2-min TTL balances freshness against gateway load.
const GMGN_TTL_MS = 2 * 60 * 1000;

// GMGN OpenAPI — native bunnyOS implementation.
//
// READ-ONLY surface only. All tools here use "exist" auth: the GMGN_API_KEY
// in an `X-APIKEY` header plus a `timestamp` (unix seconds) + `client_id`
// (random UUID) query param. No request signing, so NO private key is ever
// needed or stored. The signed endpoints (swap / order / strategy / cooking /
// wallet_holdings / follow_wallet) require a GMGN_PRIVATE_KEY and are
// deliberately excluded — bunny never holds a trading key.
//
// Host: https://openapi.gmgn.ai. Success envelope is `{ code: 0, data }`;
// any other `code` is a logical error (treated as a throw, not "no data").
// Per the GMGN docs the API is IPv4-only (401/403 or ENETUNREACH over IPv6) —
// surfaced as a clear error if the outbound path can't reach it.
//
// Chains: sol / bsc / base / eth. Every tool defaults to `base`.

const HOST = "https://openapi.gmgn.ai";
const DEFAULT_CHAIN = "base";
const VALID_CHAINS = new Set(["sol", "bsc", "base", "eth"]);
const REQUEST_TIMEOUT_MS = 20_000;

export interface GmgnTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface BuiltRequest {
  method: "GET" | "POST";
  subPath: string;
  query: Record<string, string | number | string[]>;
  body?: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build: (args: Record<string, unknown>) => BuiltRequest;
  // Optional server-side trimming/projection so large list payloads don't
  // overflow the model's context window.
  trim?: (parsed: unknown, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`missing required arg: ${key}`);
  }
  return String(v);
}

function chainArg(args: Record<string, unknown>): string {
  const v = args["chain"];
  if (v === undefined || v === null || v === "") return DEFAULT_CHAIN;
  const c = String(v).toLowerCase();
  if (!VALID_CHAINS.has(c)) {
    throw new Error(`invalid chain: ${c} (expected sol / bsc / base / eth)`);
  }
  return c;
}

function clampLimit(
  args: Record<string, unknown>,
  fallback: number,
  max: number,
): number {
  const raw = args["limit"];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// Pull a subset of args into a string/number query map, skipping empties.
function pickQuery(
  args: Record<string, unknown>,
  keys: string[],
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "number" ? v : String(v);
  }
  return out;
}

function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const arr = v.map((x) => String(x)).filter((x) => x !== "");
    return arr.length ? arr : undefined;
  }
  const s = String(v).trim();
  if (s === "") return undefined;
  // Allow comma-separated strings as a convenience.
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// ---------- Trenches body builder (POST /v1/trenches) ----------
// Mirrors the GMGN CLI: a per-section config repeated for each requested
// token-status category. Defaults match the CLI (all categories, chain
// default platforms left to the server when omitted).
const TRENCHES_TYPES = ["new_creation", "near_completion", "completed"];

function buildTrenchesBody(
  chain: string,
  types: string[] | undefined,
  platforms: string[] | undefined,
  limit: number,
): Record<string, unknown> {
  const selectedTypes = types?.length ? types : TRENCHES_TYPES;
  const section: Record<string, unknown> = {
    filters: ["offchain", "onchain"],
    launchpad_platform: platforms?.length ? platforms : [],
    quote_address_type: [],
    launchpad_platform_v2: true,
    limit,
  };
  const body: Record<string, unknown> = { version: "v2", chain };
  for (const type of selectedTypes) body[type] = { ...section };
  return body;
}

// ---------- Generic list trim ----------
// Many GMGN responses are `{ list: [...] }` or a bare array. Cap array length
// so a 100-item holder/trader/rank payload doesn't blow the context window.
function trimList(parsed: unknown, args: Record<string, unknown>, fallback: number, max: number): unknown {
  const cap = clampLimit(args, fallback, max);
  if (Array.isArray(parsed)) return parsed.slice(0, cap);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["list"])) {
      return { ...obj, list: (obj["list"] as unknown[]).slice(0, cap) };
    }
    if (Array.isArray(obj["rank"])) {
      return { ...obj, rank: (obj["rank"] as unknown[]).slice(0, cap) };
    }
  }
  return parsed;
}

const CHAIN_PROP = {
  type: "string",
  enum: ["sol", "bsc", "base", "eth"],
  description: "Blockchain network. Defaults to 'base'.",
};

const TOOLS: ToolDef[] = [
  // ---------------- token research ----------------
  {
    name: "gmgn_token_info",
    description:
      "GMGN token basic info incl. realtime price, symbol, supply, liquidity and socials for a token contract. Market cap = price.price × circulating_supply.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        address: { type: "string", description: "Token contract address (base58 for sol, 0x... for evm)." },
      },
      required: ["address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/token/info",
      query: { chain: chainArg(a), address: str(a, "address") },
    }),
  },
  {
    name: "gmgn_token_security",
    description:
      "GMGN token security audit: honeypot, rug-pull risk, contract flags, renounced/mint authority, dev-wallet behaviour and holder concentration. Use for due diligence before buying.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        address: { type: "string", description: "Token contract address." },
      },
      required: ["address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/token/security",
      query: { chain: chainArg(a), address: str(a, "address") },
    }),
  },
  {
    name: "gmgn_token_pool",
    description:
      "GMGN token liquidity pool info — main trading pool reserves, liquidity (USD) and pool metadata. Low liquidity (<$10k) means high slippage.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        address: { type: "string", description: "Token contract address." },
      },
      required: ["address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/token/pool_info",
      query: { chain: chainArg(a), address: str(a, "address") },
    }),
  },
  {
    name: "gmgn_token_holders",
    description:
      "GMGN top token holders ranked by current balance, with smart-money / KOL tags where known. Use to gauge holder concentration and who is holding.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        address: { type: "string", description: "Token contract address." },
        limit: { type: "number", description: "Number of holders (default 20, max 100)." },
        order_by: { type: "string", description: "Optional sort field." },
        direction: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      },
      required: ["address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/market/token_top_holders",
      query: {
        chain: chainArg(a),
        address: str(a, "address"),
        limit: clampLimit(a, 20, 100),
        ...pickQuery(a, ["order_by", "direction"]),
      },
    }),
    trim: (p, a) => trimList(p, a, 20, 100),
  },
  {
    name: "gmgn_token_traders",
    description:
      "GMGN top token traders (current holders + past traders) ranked by activity/PnL, with smart-money / KOL tags. Use to see who is actively trading a token.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        address: { type: "string", description: "Token contract address." },
        limit: { type: "number", description: "Number of traders (default 20, max 100)." },
        order_by: { type: "string", description: "Optional sort field." },
        direction: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      },
      required: ["address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/market/token_top_traders",
      query: {
        chain: chainArg(a),
        address: str(a, "address"),
        limit: clampLimit(a, 20, 100),
        ...pickQuery(a, ["order_by", "direction"]),
      },
    }),
    trim: (p, a) => trimList(p, a, 20, 100),
  },
  // ---------------- market / discovery ----------------
  {
    name: "gmgn_market_trending",
    description:
      "GMGN trending tokens ranked by swap activity over an interval. Rich sorts (volume / swaps / liquidity / marketcap / holders / change / smart_degen_count …) and safety filters (not_honeypot / renounced / has_social / verified …). The core 'what's pumping / hot coins' discovery tool. EVM chains default to not_honeypot+verified+renounced when filters omitted.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        interval: { type: "string", enum: ["1h", "3h", "6h", "24h"], description: "Time interval." },
        limit: { type: "number", description: "Number of results (default 100, max 100)." },
        order_by: {
          type: "string",
          description:
            "Sort field, e.g. volume / swaps / liquidity / marketcap / holders / price / change / smart_degen_count / rank / creation_timestamp.",
        },
        direction: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default desc)." },
        filters: {
          type: "array",
          items: { type: "string" },
          description:
            "Safety/quality filter tags, e.g. not_honeypot / renounced / has_social / verified / locked / not_risk.",
        },
        platforms: {
          type: "array",
          items: { type: "string" },
          description: "Launchpad/platform filter, e.g. clanker / zora on base. Omit for all platforms.",
        },
      },
      required: ["interval"],
    },
    build: (a) => {
      const query: Record<string, string | number | string[]> = {
        chain: chainArg(a),
        interval: str(a, "interval"),
        limit: clampLimit(a, 100, 100),
        ...pickQuery(a, ["order_by", "direction"]),
      };
      const filters = strArray(a, "filters");
      if (filters) query["filters"] = filters;
      const platforms = strArray(a, "platforms");
      if (platforms) query["platforms"] = platforms;
      return { method: "GET", subPath: "/v1/market/rank", query };
    },
    trim: (p, a) => trimList(p, a, 100, 100),
  },
  {
    name: "gmgn_market_kline",
    description:
      "GMGN OHLCV candlestick data for a token. `volume` is USD value traded; `amount` is token units. Use for price charts and momentum analysis.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        address: { type: "string", description: "Token contract address." },
        resolution: {
          type: "string",
          enum: ["1m", "5m", "15m", "1h", "4h", "1d"],
          description: "Candlestick resolution.",
        },
        from: { type: "number", description: "Start time, unix seconds (optional)." },
        to: { type: "number", description: "End time, unix seconds (optional)." },
      },
      required: ["address", "resolution"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/market/token_kline",
      query: {
        chain: chainArg(a),
        address: str(a, "address"),
        resolution: str(a, "resolution"),
        ...pickQuery(a, ["from", "to"]),
      },
    }),
  },
  {
    name: "gmgn_market_trenches",
    description:
      "GMGN Trenches — brand-new launchpad tokens grouped by lifecycle stage (new_creation / near_completion / completed). The earliest-stage discovery feed across launchpads (clanker etc on base).",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        types: {
          type: "array",
          items: { type: "string", enum: ["new_creation", "near_completion", "completed"] },
          description: "Lifecycle categories to fetch. Omit for all three.",
        },
        platforms: {
          type: "array",
          items: { type: "string" },
          description: "Launchpad platform filter. Omit for all platforms on the chain.",
        },
        limit: { type: "number", description: "Max results per category (default 30, max 80)." },
      },
    },
    build: (a) => {
      const chain = chainArg(a);
      const limit = clampLimit(a, 30, 80);
      return {
        method: "POST",
        subPath: "/v1/trenches",
        query: { chain },
        body: buildTrenchesBody(chain, strArray(a, "types"), strArray(a, "platforms"), limit),
      };
    },
  },
  // ---------------- smart-money / alpha tracking ----------------
  {
    name: "gmgn_track_smartmoney",
    description:
      "GMGN Smart Money activity — recent buys/sells from wallets with a statistically proven profitable track record (smart_degen). The strongest copy-trade / alpha signal GMGN exposes.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        limit: { type: "number", description: "Page size (default 50, max 200)." },
      },
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/user/smartmoney",
      query: { chain: chainArg(a), limit: clampLimit(a, 50, 200) },
    }),
    trim: (p, a) => trimList(p, a, 50, 200),
  },
  {
    name: "gmgn_track_kol",
    description:
      "GMGN KOL activity — recent trades from wallets tagged as influencers / well-known traders (renowned). Social/marketing signal, weaker than smart money.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        limit: { type: "number", description: "Page size (default 50, max 200)." },
      },
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/user/kol",
      query: { chain: chainArg(a), limit: clampLimit(a, 50, 200) },
    }),
    trim: (p, a) => trimList(p, a, 50, 200),
  },
  // ---------------- wallet analysis ----------------
  {
    name: "gmgn_portfolio_stats",
    description:
      "GMGN wallet performance stats over a period: realized/unrealized PnL, win rate, trade count, trading style. `pnl`/`profit_change` are multipliers (1.5 = +150%); `winrate` is 0–1. Use to decide whether to copy-trade a wallet.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        wallet_address: { type: "string", description: "Wallet address to analyze." },
        period: { type: "string", enum: ["7d", "30d"], description: "Stats period (default 7d)." },
      },
      required: ["wallet_address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/user/wallet_stats",
      query: {
        chain: chainArg(a),
        wallet_address: str(a, "wallet_address"),
        period: String(a["period"] ?? "7d"),
      },
    }),
  },
  {
    name: "gmgn_portfolio_activity",
    description:
      "GMGN wallet recent trading activity — buys/sells with token, amount and timing. Use to see what a wallet is currently doing.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        wallet_address: { type: "string", description: "Wallet address." },
        limit: { type: "number", description: "Page size (default 30, max 100)." },
        token_address: { type: "string", description: "Optional: filter activity to one token." },
      },
      required: ["wallet_address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/user/wallet_activity",
      query: {
        chain: chainArg(a),
        wallet_address: str(a, "wallet_address"),
        limit: clampLimit(a, 30, 100),
        ...pickQuery(a, ["token_address"]),
      },
    }),
    trim: (p, a) => trimList(p, a, 30, 100),
  },
  {
    name: "gmgn_portfolio_created_tokens",
    description:
      "GMGN tokens created/launched by a developer wallet, incl. ATH market cap and DEX graduation status. Use to vet a dev: their best-ever launch and graduation rate.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP,
        wallet_address: { type: "string", description: "Developer wallet address." },
        limit: { type: "number", description: "Page size (default 30, max 100)." },
        order_by: { type: "string", description: "Optional sort field." },
        direction: { type: "string", enum: ["asc", "desc"], description: "Sort direction." },
      },
      required: ["wallet_address"],
    },
    build: (a) => ({
      method: "GET",
      subPath: "/v1/user/created_tokens",
      query: {
        chain: chainArg(a),
        wallet_address: str(a, "wallet_address"),
        limit: clampLimit(a, 30, 100),
        ...pickQuery(a, ["order_by", "direction"]),
      },
    }),
    trim: (p, a) => trimList(p, a, 30, 100),
  },
];

const toolIndex = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function listGmgnTools(): GmgnTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findGmgnTool(name: string): boolean {
  return toolIndex.has(name);
}

export function gmgnStatus(): { connected: boolean; toolCount: number } {
  // Connected when bunnyDS is on (gateway injects the key) OR the user brought
  // their own GMGN key for BYO/open-source mode.
  let connected = false;
  try {
    connected =
      (getBunnyDsEnabled() && isGatewayConfigured()) ||
      Boolean(getGmgnApiKey());
  } catch {
    connected = isGatewayConfigured();
  }
  return { connected, toolCount: TOOLS.length };
}

function buildUrl(subPath: string, query: Record<string, string | number | string[]>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `${HOST}${subPath}?${qs}` : `${HOST}${subPath}`;
}

export async function callGmgnTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = toolIndex.get(name);
  if (!tool) {
    return { isError: true, content: `Unknown GMGN tool: ${name}` };
  }

  let apiKey: string | undefined;
  try {
    apiKey = getGmgnApiKey();
  } catch {
    apiKey = undefined;
  }
  let useGateway = false;
  try {
    useGateway = getBunnyDsEnabled() && isGatewayConfigured();
  } catch {
    useGateway = isGatewayConfigured();
  }
  if (!useGateway && !apiKey) {
    return {
      isError: true,
      content:
        "No GMGN API key configured. Turn on bunnyDS, or add a GMGN key in Configure → api tab.",
    };
  }

  let req: BuiltRequest;
  try {
    req = tool.build(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `Failed to build GMGN request: ${message}` };
  }

  const headers: Record<string, string> = useGateway
    ? {
        ...gatewayAuthHeaders(),
        "Content-Type": "application/json",
        accept: "application/json",
      }
    : {
        "X-APIKEY": apiKey!,
        "Content-Type": "application/json",
        accept: "application/json",
      };

  const run = async (): Promise<{ content: string; isError: boolean }> => {
    // Exist-auth: timestamp (server validates ±5s) + client_id (replay guard).
    // These are added per attempt so they can't poison the cache key.
    const query: Record<string, string | number | string[]> = {
      ...req.query,
      timestamp: Math.floor(Date.now() / 1000),
      client_id: crypto.randomUUID(),
    };
    let url = buildUrl(req.subPath, query);
    const bodyStr = req.body != null ? JSON.stringify(req.body) : undefined;
    // bunnyDS on → route through the gateway (it injects the upstream GMGN key).
    if (useGateway) url = gatewayCloudUrl(url);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: req.method,
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await resp.text();
      if (!resp.ok) {
        logger.warn(
          { tool: name, status: resp.status, body: text.slice(0, 500) },
          "GMGN API error",
        );
        if (resp.status === 401 || resp.status === 403) {
          return {
            isError: true,
            content: `GMGN ${resp.status}: auth rejected. Check the API key. (Note: GMGN is IPv4-only — requests over IPv6 also return 401/403.)`,
          };
        }
        if (resp.status === 429) {
          return {
            isError: true,
            content: "GMGN rate limit hit. Wait a moment and retry, or narrow `limit`.",
          };
        }
        return { isError: true, content: `GMGN ${resp.status}: ${text.slice(0, 1000)}` };
      }

      let json: { code?: number | string; data?: unknown; message?: string; error?: string };
      try {
        json = JSON.parse(text);
      } catch {
        return { isError: true, content: `GMGN returned non-JSON: ${text.slice(0, 500)}` };
      }

      // GMGN success is code 0. Accept both numeric and string "0" since the
      // envelope type can come back either way across endpoints. Anything else
      // is a logical error (HTTP 200 + non-zero code).
      if (json.code !== 0 && json.code !== "0") {
        return {
          isError: true,
          content: `GMGN error (code ${json.code}): ${json.error ?? json.message ?? "unknown"}`,
        };
      }

      let data = json.data;
      if (tool.trim) {
        try {
          data = tool.trim(data, args);
        } catch (err) {
          logger.warn({ tool: name, err }, "GMGN trim failed; returning raw data");
        }
      }
      return { isError: false, content: JSON.stringify(data) };
    } catch (err) {
      // undici wraps the underlying network error in `err.cause`, so check both.
      const cause = (err as { cause?: NodeJS.ErrnoException })?.cause;
      const errno = (err as NodeJS.ErrnoException)?.code ?? cause?.code;
      if (errno === "EADDRNOTAVAIL" || errno === "ENETUNREACH") {
        return {
          isError: true,
          content:
            "GMGN network unreachable — the API is IPv4-only and outbound IPv6 is not supported on this host.",
        };
      }
      if (err instanceof Error && err.name === "AbortError") {
        return { isError: true, content: "GMGN request timed out." };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: `GMGN request failed: ${message}` };
    }
  };

  // Only GET reads are cacheable. Key off req.query (the stable tool args, NOT
  // the per-attempt timestamp/client_id) plus subPath + transport mode.
  if (req.method !== "GET") return run();
  const mode = useGateway ? "gateway" : "direct";
  const cacheKey = `gmgn:${mode}:${req.subPath}?${JSON.stringify(req.query)}`;
  return withApiCache(cacheKey, GMGN_TTL_MS, run);
}

// ---------------- report enrichment: holder distribution ----------------
//
// Aggregate holder/distribution metrics for the token report panel, sourced
// from GMGN. NOT an agent tool — this is report enrichment only (like
// token-security.ts), so it is gated by the per-user `gmgn` protocol toggle + key and
// never throws (missing data just omits the panel). The per-holder list
// endpoint (token_top_holders) is tier-gated and often returns empty, so we
// rely on the aggregate fields from token/info (holder_count) + token/security
// (top-10 concentration, locked %, burn %), which are reliably populated.

export interface TokenDistribution {
  address: string;
  // null = field absent / unknown from GMGN.
  holderCount: number | null;
  top10HolderPercent: number | null; // percent of supply held by top 10, 0-100
  lockedPercent: number | null; // percent of liquidity locked, 0-100
  burnPercent: number | null; // percent of supply burned, 0-100
}

function pctFromRatio(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return null;
  // These are bounded supply/liquidity ratios (0-1). GMGN occasionally returns
  // tiny negative floating-point noise, so clamp to [0, 100]% defensively.
  return Math.min(100, Math.max(0, n * 100));
}

function intOrNull(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function callJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const r = await callGmgnTool(name, args);
  if (r.isError) {
    logger.warn({ tool: name, content: r.content.slice(0, 200) }, "GMGN enrichment call failed");
    return null;
  }
  try {
    const parsed = JSON.parse(r.content);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Best-effort holder/distribution enrichment for the report UI. Returns null
// when GMGN is disabled, no key is set, or no useful data comes back. Never
// throws.
export async function getTokenDistributionSafe(
  address: string,
  chain = "base",
): Promise<TokenDistribution | null> {
  let enabled = false;
  try {
    enabled = isProtocolEnabled("gmgn") && Boolean(getGmgnApiKey());
  } catch {
    enabled = false;
  }
  if (!enabled) return null;

  try {
    const [info, security] = await Promise.all([
      callJson("gmgn_token_info", { chain, address }),
      callJson("gmgn_token_security", { chain, address }),
    ]);

    const lockSummary =
      security && typeof security.lock_summary === "object" && security.lock_summary !== null
        ? (security.lock_summary as Record<string, unknown>)
        : null;

    const dist: TokenDistribution = {
      address,
      holderCount: info ? intOrNull(info.holder_count) : null,
      top10HolderPercent: security ? pctFromRatio(security.top_10_holder_rate) : null,
      lockedPercent: lockSummary ? pctFromRatio(lockSummary.lock_percent) : null,
      burnPercent: security ? pctFromRatio(security.burn_ratio) : null,
    };

    // If nothing useful came back, omit the panel entirely.
    if (
      dist.holderCount === null &&
      dist.top10HolderPercent === null &&
      dist.lockedPercent === null &&
      dist.burnPercent === null
    ) {
      return null;
    }
    return dist;
  } catch (err) {
    logger.warn({ err, address }, "GMGN distribution enrichment failed");
    return null;
  }
}

// Short, terminal-style block injected into the AI report prompt so the model
// can factor holder distribution into its risk assessment.
export function summarizeDistribution(d: TokenDistribution): string {
  const pct = (n: number | null): string => (n === null ? "unknown" : `${n.toFixed(1)}%`);
  const num = (n: number | null): string => (n === null ? "unknown" : n.toLocaleString("en-US"));
  return [
    `distribution (gmgn):`,
    `- holders: ${num(d.holderCount)}`,
    `- top 10 holders: ${pct(d.top10HolderPercent)} of supply`,
    `- liquidity locked: ${pct(d.lockedPercent)} | supply burned: ${pct(d.burnPercent)}`,
  ].join("\n");
}
