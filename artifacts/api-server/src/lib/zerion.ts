import { getZerionApiKey } from "./settings";
import { logger } from "./logger";

// Zerion REST API — native bunnyOS implementation.
//
// Purpose-built wallet/portfolio data — the full set of Zerion's 8 wallet
// endpoints: portfolio overview, fungible + DeFi positions, PnL, portfolio value
// chart, transaction history, NFT positions, NFT portfolio summary, and NFT
// collections. This is the cheaper dashboard-grade alternative to Moralis for
// the portfolio surface. (Token/fungible lookup + search are intentionally out
// of scope — this provider is wallet-only.)
//
// Host: https://api.zerion.io/v1. Auth is HTTP Basic with the API key as the
// username and an empty password: `Authorization: Basic base64("<key>:")`.
// Zerion is NOT on the bunnyDS gateway path — it always requires the user's
// own key.
//
// JSON:API responses; non-2xx returns an `errors` array — treated as a throw,
// not "no data". Every tool defaults to Base (chain id `base`).

const BASE_URL = "https://api.zerion.io/v1";
const DEFAULT_CHAIN = "base";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  build: (args: Record<string, unknown>) => {
    path: string;
    query: Record<string, string>;
  };
}

function addressSchema(extra: Record<string, unknown> = {}) {
  return {
    type: "object",
    required: ["address"],
    properties: {
      address: {
        type: "string",
        description: "EVM wallet address (0x-prefixed).",
      },
      chain: {
        type: "string",
        description:
          "Zerion chain id to filter by. Defaults to 'base'. Examples: base, ethereum, polygon, arbitrum, optimism, binance-smart-chain, avalanche. Pass an empty string to include all chains.",
      },
      ...extra,
    },
  } as Record<string, unknown>;
}

function chainFilter(args: Record<string, unknown>): Record<string, string> {
  const raw = args["chain"];
  // Explicit empty string => no chain filter (all chains).
  if (raw === "") return {};
  const chain = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_CHAIN;
  return { "filter[chain_ids]": chain };
}

function pageSize(args: Record<string, unknown>, fallback = 25): string {
  const v = Number(args["limit"]);
  if (!Number.isFinite(v) || v <= 0) return String(fallback);
  return String(Math.min(Math.floor(v), 100));
}

const CHART_PERIODS = new Set(["hour", "day", "week", "month", "year", "max"]);
function chartPeriod(args: Record<string, unknown>): string {
  const raw = args["period"];
  if (typeof raw === "string" && CHART_PERIODS.has(raw.trim())) {
    return raw.trim();
  }
  return "day";
}

const TOOLS: ToolDef[] = [
  {
    name: "zerion_wallet_portfolio",
    description:
      "Get a wallet's portfolio overview on a chain: total USD value, value broken down by chain and by position type (wallet/deposited/borrowed/staked/locked), and 24h change. Best single call for a dashboard header. Defaults to chain='base'.",
    inputSchema: addressSchema(),
    build: (args) => ({
      path: `/wallets/${args["address"]}/portfolio`,
      query: { currency: "usd", ...chainFilter(args) },
    }),
  },
  {
    name: "zerion_wallet_positions",
    description:
      "Get a wallet's detailed positions on a chain — both fungible token balances (with USD price, value, 24h change) and DeFi positions (LP, lending, staking, locked), sorted by value, spam filtered. This is the core dashboard data source. Defaults to chain='base'.",
    inputSchema: addressSchema(),
    build: (args) => ({
      path: `/wallets/${args["address"]}/positions/`,
      query: {
        currency: "usd",
        "filter[trash]": "only_non_trash",
        sort: "value",
        ...chainFilter(args),
      },
    }),
  },
  {
    name: "zerion_wallet_pnl",
    description:
      "Get a wallet's profit-and-loss summary on a chain: realized + unrealized PnL, net invested, total fees, and external in/out flow. Defaults to chain='base'.",
    inputSchema: addressSchema(),
    build: (args) => ({
      path: `/wallets/${args["address"]}/pnl/`,
      query: { currency: "usd", ...chainFilter(args) },
    }),
  },
  {
    name: "zerion_wallet_transactions",
    description:
      "Get a wallet's transaction history on a chain (sends, receives, trades, approvals, deposits, withdrawals) with USD values. Use `limit` for page size (default 25, max 100). Defaults to chain='base'.",
    inputSchema: addressSchema({
      limit: {
        type: "number",
        description: "Page size (default 25, max 100).",
      },
    }),
    build: (args) => ({
      path: `/wallets/${args["address"]}/transactions/`,
      query: {
        currency: "usd",
        "page[size]": pageSize(args),
        ...chainFilter(args),
      },
    }),
  },
  {
    name: "zerion_wallet_chart",
    description:
      "Get a wallet's portfolio value chart over time on a chain. `period` is one of hour|day|week|month|year|max (default day). Returns time-series points of total USD value plus the change over the period. Defaults to chain='base'.",
    inputSchema: addressSchema({
      period: {
        type: "string",
        description:
          "Chart period: hour, day, week, month, year, or max. Defaults to day.",
      },
    }),
    build: (args) => ({
      path: `/wallets/${args["address"]}/chart/${chartPeriod(args)}`,
      query: { currency: "usd", ...chainFilter(args) },
    }),
  },
  {
    name: "zerion_wallet_nft_positions",
    description:
      "Get the individual NFT positions held by a wallet on a chain. Use `limit` for page size (default 25, max 100). Defaults to chain='base'.",
    inputSchema: addressSchema({
      limit: {
        type: "number",
        description: "Page size (default 25, max 100).",
      },
    }),
    build: (args) => ({
      path: `/wallets/${args["address"]}/nft-positions/`,
      query: {
        currency: "usd",
        "page[size]": pageSize(args),
        ...chainFilter(args),
      },
    }),
  },
  {
    name: "zerion_wallet_nft_portfolio",
    description:
      "Get a wallet's NFT portfolio summary on a chain: total floor-price value, number of NFTs and collections, and value broken down by chain. Defaults to chain='base'.",
    inputSchema: addressSchema(),
    build: (args) => ({
      path: `/wallets/${args["address"]}/nft-portfolio`,
      query: { currency: "usd", ...chainFilter(args) },
    }),
  },
  {
    name: "zerion_wallet_nft_collections",
    description:
      "Get the NFT collections held by a wallet on a chain, with floor price and held value per collection. Use `limit` for page size (default 25, max 100). Defaults to chain='base'.",
    inputSchema: addressSchema({
      limit: {
        type: "number",
        description: "Page size (default 25, max 100).",
      },
    }),
    build: (args) => ({
      path: `/wallets/${args["address"]}/nft-collections/`,
      query: {
        currency: "usd",
        "page[size]": pageSize(args),
        ...chainFilter(args),
      },
    }),
  },
];

const toolIndex = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function listZerionTools(): McpTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findZerionTool(name: string): boolean {
  return toolIndex.has(name);
}

export function zerionStatus(): { connected: boolean; toolCount: number } {
  return {
    // Zerion is NOT on the bunnyDS gateway path — it always needs the user's
    // own key. Connected only when a Zerion key is configured.
    connected: Boolean(getZerionApiKey()),
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

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

export async function callZerionTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = toolIndex.get(name);
  if (!tool) {
    return { isError: true, content: `Unknown Zerion tool: ${name}` };
  }
  const apiKey = getZerionApiKey();
  // Zerion is not on the bunnyDS gateway path — always use the user's key.
  if (!apiKey) {
    return {
      isError: true,
      content:
        "Zerion API key is not configured. Add a Zerion key in Configure → api tab.",
    };
  }
  let url: string;
  try {
    const { path, query } = tool.build(args);
    url = buildUrl(path, query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `Failed to build Zerion request: ${message}` };
  }
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(apiKey),
    accept: "application/json",
  };
  try {
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    if (!resp.ok) {
      logger.warn(
        { tool: name, status: resp.status, body: text.slice(0, 500) },
        "Zerion API error",
      );
      return {
        isError: true,
        content: `Zerion ${resp.status}: ${text.slice(0, 1000)}`,
      };
    }
    return { isError: false, content: text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err }, "Zerion fetch failed");
    return { isError: true, content: `Zerion request failed: ${message}` };
  }
}
