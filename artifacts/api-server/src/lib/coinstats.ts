import { getCoinstatsApiKey, getBunnyDsEnabled } from "./settings";
import { logger } from "./logger";
import {
  gatewayAuthHeaders,
  gatewayCloudUrl,
  isGatewayConfigured,
} from "./bunnyos-gateway";
import { withApiCache } from "./api-cache";

// CoinStats Open API — native bunnyOS implementation, READ-ONLY.
//
// Scoped to three surfaces: wallet/portfolio data, crypto news, and NFTs held
// by a wallet. Market-data/price endpoints are intentionally out of scope (that
// surface is owned by coingecko), and contract-security / token-risk is owned by
// gmgn (see lib/token-security.ts).
//
// Host: https://openapiv1.coinstats.app. Auth is the `X-API-KEY` header.
// When bunnyDS is on we route through the gateway pass-through (which injects
// the upstream key) and never send the X-API-KEY header ourselves.
//
// Chain naming quirk: wallet endpoints take a `connectionId` like
// `base-wallet` (NOT `base`), and default to Base. Wallet transactions + PnL
// require a one-time sync first (coinstats_wallet_sync) or they return HTTP 409.
//
// Non-2xx is treated as a throw, not "no data".

const BASE_URL = "https://openapiv1.coinstats.app";
// Wallet endpoints use the `<chain>-wallet` connectionId form.
const DEFAULT_CONNECTION = "base-wallet";

// Read (GET) calls are served through the durable DB-backed cache (see
// lib/api-cache) so a burst of identical lookups — the agent loop, the scanner —
// answers without re-hitting bunnyDS. The key is `<mode>:<target URL>` — the URL
// already encodes the wallet address / coin id (public, chain-derived) so
// entries aren't per-user, but gateway vs direct transport is kept separate so a
// degraded gateway path can never hand its result/error to a BYO-key caller.
const DATA_TTL_MS = 60_000; // 60s — wallet / news / nft reads

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface BuiltRequest {
  path: string;
  query: Record<string, string>;
  method?: "GET" | "PATCH";
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build: (args: Record<string, unknown>) => BuiltRequest;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function connectionId(args: Record<string, unknown>): string {
  const raw = args["connectionId"];
  // Explicit empty string => omit (let the API default apply).
  if (raw === "") return "";
  const c = str(raw);
  return c || DEFAULT_CONNECTION;
}

function pageNum(args: Record<string, unknown>): string {
  const v = Number(args["page"]);
  if (!Number.isFinite(v) || v <= 0) return "";
  return String(Math.floor(v));
}

function pageLimit(args: Record<string, unknown>, fallback = 20): string {
  const v = Number(args["limit"]);
  if (!Number.isFinite(v) || v <= 0) return String(fallback);
  return String(Math.min(Math.floor(v), 100));
}

const CHART_TYPES = new Set(["24h", "1w", "1m", "3m", "6m", "1y", "all"]);

// CoinStats wallet-chart range selector. "7 day" => "1w" (the default).
function chartType(args: Record<string, unknown>): string {
  const t = str(args["type"]).toLowerCase();
  return CHART_TYPES.has(t) ? t : "1w";
}

function walletAddressSchema(extra: Record<string, unknown> = {}) {
  return {
    type: "object",
    required: ["address"],
    properties: {
      address: {
        type: "string",
        description: "EVM wallet address (0x-prefixed).",
      },
      connectionId: {
        type: "string",
        description:
          "CoinStats wallet connection id. Defaults to 'base-wallet'. Examples: base-wallet, ethereum, polygon-wallet, arbitrum-wallet, optimism-wallet, avalanche-wallet. Use 'all' for every supported chain, or pass an empty string to let the API decide.",
      },
      ...extra,
    },
  } as Record<string, unknown>;
}

const NEWS_TYPES = new Set(["handpicked", "trending", "latest", "bullish", "bearish"]);

const TOOLS: ToolDef[] = [
  // ---------- Wallet / portfolio ----------
  {
    name: "coinstats_wallet_balance",
    description:
      "Get a wallet's token balances on a chain: per-token amount, current USD price, 24h change, contract address, decimals, and market rank/volume. Live (no sync needed). Best single call for 'what does this wallet hold'. Defaults to connectionId='base-wallet'.",
    inputSchema: walletAddressSchema(),
    build: (args) => ({
      path: `/wallet/balance`,
      query: { address: str(args["address"]), connectionId: connectionId(args) },
    }),
  },
  {
    name: "coinstats_wallet_defi",
    description:
      "Get a wallet's DeFi positions on a chain — staking, lending, liquidity-pool, and yield-farming positions auto-detected across 10,000+ protocols, with USD values. Live (no sync needed). Defaults to connectionId='base-wallet'.",
    inputSchema: walletAddressSchema(),
    build: (args) => ({
      path: `/wallet/defi`,
      query: { address: str(args["address"]), connectionId: connectionId(args) },
    }),
  },
  {
    name: "coinstats_wallet_pnl",
    description:
      "Get a wallet's profit-and-loss breakdown on a chain: per-holding realized + unrealized PnL, all-time/24h/last-trade values, average buy/sell prices, plus a totals summary (value, cost, profit, profit %). Requires a prior sync — call coinstats_wallet_sync first or this returns 409. Optional coinId filter. Defaults to connectionId='base-wallet'.",
    inputSchema: walletAddressSchema({
      coinId: {
        type: "string",
        description: "Optional CoinStats coin id to filter the result (e.g. 'ethereum').",
      },
      page: { type: "number", description: "Page number (1-based)." },
      limit: { type: "number", description: "Items per page (max 100)." },
    }),
    build: (args) => ({
      path: `/wallet/pl`,
      query: {
        address: str(args["address"]),
        connectionId: connectionId(args),
        coinId: str(args["coinId"]),
        page: pageNum(args),
        limit: pageLimit(args, 100),
      },
    }),
  },
  {
    name: "coinstats_wallet_transactions",
    description:
      "Get a wallet's transaction history on a chain (deposits, withdrawals, approvals, executes, fees) with USD values. Requires a prior sync — call coinstats_wallet_sync first or this returns 409. Use page/limit for pagination (limit default 20, max 100) and optional `types`. Defaults to connectionId='base-wallet'.",
    inputSchema: walletAddressSchema({
      page: { type: "number", description: "Page number (1-based)." },
      limit: { type: "number", description: "Items per page (default 20, max 100)." },
      types: {
        type: "string",
        description:
          "Optional comma-separated transaction types: deposit,withdraw,approve,executed,balance,fee.",
      },
    }),
    build: (args) => ({
      path: `/wallet/transactions`,
      query: {
        address: str(args["address"]),
        connectionId: connectionId(args),
        page: pageNum(args),
        limit: pageLimit(args, 20),
        types: str(args["types"]),
      },
    }),
  },
  {
    name: "coinstats_wallet_sync",
    description:
      "Trigger CoinStats to (re)index a wallet's transactions on a chain. Run this once before coinstats_wallet_transactions or coinstats_wallet_pnl, which return 409 until the wallet is synced. This only refreshes CoinStats' read-only index — it does NOT touch the wallet or move funds. Defaults to connectionId='base-wallet'.",
    inputSchema: walletAddressSchema(),
    build: (args) => ({
      path: `/wallet/transactions`,
      method: "PATCH",
      query: { address: str(args["address"]), connectionId: connectionId(args) },
    }),
  },
  {
    name: "coinstats_wallet_chart",
    description:
      "Get a wallet's total portfolio value over time on a chain as a series of [timestampMs, USD, BTC, ETH] points. `type` selects the range: 24h, 1w (default — last 7 days), 1m, 3m, 6m, 1y, all. Requires a prior sync — call coinstats_wallet_sync first or this returns 400/409. Defaults to connectionId='base-wallet'.",
    inputSchema: walletAddressSchema({
      type: {
        type: "string",
        description: "Time range: 24h, 1w (default, last 7 days), 1m, 3m, 6m, 1y, all.",
      },
    }),
    build: (args) => ({
      path: `/wallet/chart`,
      query: {
        address: str(args["address"]),
        connectionId: connectionId(args),
        type: chartType(args),
      },
    }),
  },
  // ---------- News ----------
  {
    name: "coinstats_news",
    description:
      "Get the latest crypto news articles (paginated). Use page/limit (limit default 20) and optional ISO-8601 `from`/`to` date filters.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (1-based)." },
        limit: { type: "number", description: "Items per page (default 20, max 100)." },
        from: { type: "string", description: "Optional start date, ISO-8601." },
        to: { type: "string", description: "Optional end date, ISO-8601." },
      },
    },
    build: (args) => ({
      path: `/news`,
      query: {
        page: pageNum(args),
        limit: pageLimit(args, 20),
        from: str(args["from"]),
        to: str(args["to"]),
      },
    }),
  },
  {
    name: "coinstats_news_by_type",
    description:
      "Get crypto news filtered by type. `type` must be one of: handpicked, trending, latest, bullish, bearish. Use page/limit for pagination.",
    inputSchema: {
      type: "object",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          description: "News type: handpicked, trending, latest, bullish, or bearish.",
        },
        page: { type: "number", description: "Page number (1-based)." },
        limit: { type: "number", description: "Items per page (default 20, max 100)." },
      },
    },
    build: (args) => {
      const type = str(args["type"]).toLowerCase();
      const safeType = NEWS_TYPES.has(type) ? type : "latest";
      return {
        path: `/news/type/${encodeURIComponent(safeType)}`,
        query: { page: pageNum(args), limit: pageLimit(args, 20) },
      };
    },
  },
  {
    name: "coinstats_news_sources",
    description:
      "Get the list of supported crypto news sources. No parameters.",
    inputSchema: { type: "object", properties: {} },
    build: () => ({ path: `/news/sources`, query: {} }),
  },
  // ---------- NFTs ----------
  {
    name: "coinstats_nfts_by_wallet",
    description:
      "Get the NFT assets owned by a wallet address (collection, token id, name, image, floor/estimated value). Use page/limit for pagination (limit default 20, max 100).",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "string", description: "EVM wallet address (0x-prefixed)." },
        page: { type: "number", description: "Page number (1-based)." },
        limit: { type: "number", description: "Items per page (default 20, max 100)." },
      },
    },
    build: (args) => ({
      path: `/nft/wallet/${encodeURIComponent(str(args["address"]))}/assets`,
      query: { page: pageNum(args), limit: pageLimit(args, 20) },
    }),
  },
];

const toolIndex = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function listCoinstatsTools(): McpTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findCoinstatsTool(name: string): boolean {
  return toolIndex.has(name);
}

export function coinstatsStatus(): { connected: boolean; toolCount: number } {
  return {
    // Connected when bunnyDS is on (gateway injects the key) OR the user
    // brought their own CoinStats key for BYO/open-source mode.
    connected:
      (getBunnyDsEnabled() && isGatewayConfigured()) ||
      Boolean(getCoinstatsApiKey()),
    toolCount: TOOLS.length,
  };
}

function buildUrl(path: string, query: Record<string, string>): string {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function callCoinstatsTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = toolIndex.get(name);
  if (!tool) {
    return { isError: true, content: `Unknown CoinStats tool: ${name}` };
  }
  const apiKey = getCoinstatsApiKey();
  // bunnyDS on → route through the gateway (it injects the upstream CoinStats
  // key); never send X-API-KEY in that case. bunnyDS off → use the user's key.
  const useGateway = getBunnyDsEnabled() && isGatewayConfigured();
  if (!useGateway && !apiKey) {
    return {
      isError: true,
      content:
        "CoinStats API key is not configured. Turn on bunnyDS, or add a CoinStats key in Configure → api tab.",
    };
  }
  let targetUrl: string;
  let url: string;
  let method: "GET" | "PATCH";
  try {
    const built = tool.build(args);
    method = built.method ?? "GET";
    targetUrl = buildUrl(built.path, built.query);
    url = useGateway ? gatewayCloudUrl(targetUrl) : targetUrl;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `Failed to build CoinStats request: ${message}` };
  }

  // Only GET responses are cacheable; PATCH (wallet sync) always hits upstream.
  const cacheable = method === "GET";
  const cacheKey = `coinstats:${useGateway ? "gateway" : "direct"}:${targetUrl}`;
  const ttlMs = DATA_TTL_MS;

  const headers: Record<string, string> = useGateway
    ? { ...gatewayAuthHeaders(), accept: "application/json" }
    : { "X-API-KEY": apiKey!, accept: "application/json" };

  const run = async (): Promise<{ content: string; isError: boolean }> => {
    try {
      const resp = await fetch(url, { method, headers });
      const text = await resp.text();
      if (!resp.ok) {
        logger.warn(
          { tool: name, status: resp.status, body: text.slice(0, 500) },
          "CoinStats API error",
        );
        return {
          isError: true,
          content: `CoinStats ${resp.status}: ${text.slice(0, 1000)}`,
        };
      }
      return { isError: false, content: text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: name, err }, "CoinStats fetch failed");
      return { isError: true, content: `CoinStats request failed: ${message}` };
    }
  };

  if (!cacheable) return run();
  return withApiCache(cacheKey, ttlMs, run);
}
