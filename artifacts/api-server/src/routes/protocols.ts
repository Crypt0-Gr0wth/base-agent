import { Router, type IRouter } from "express";
import { getStatus as getBaseMcpStatus, listTools as listBaseMcpTools } from "../lib/base-mcp";
import { listAnonMcpStatuses, getAnonMcpTools } from "../lib/mcp-anon";
import { listMoralisTools, moralisStatus } from "../lib/moralis";
import { listCoinGeckoTools, coinGeckoStatus } from "../lib/coingecko";
import { listBankrTools, bankrStatus } from "../lib/bankr";
import { listDefiLlamaTools, defiLlamaStatus } from "../lib/defillama";
import { listAvantisTools, avantisStatus } from "../lib/avantis";
import { listNativeTools, nativeToolsStatus } from "../lib/native-tools";
import { listGmgnTools, gmgnStatus } from "../lib/gmgn";
import { listZerionTools, zerionStatus } from "../lib/zerion";
import { listCoinstatsTools, coinstatsStatus } from "../lib/coinstats";
import { listDefinitiveTools, definitiveStatus } from "../lib/definitive";
import { isProtocolEnabled, isProtocolDefaultOff, setProtocolEnabled } from "../lib/settings";

const router: IRouter = Router();

interface ProtocolStatus {
  id: string;
  label: string;
  kind: string;
  connected: boolean;
  toolCount: number;
  requiresAuth: boolean;
  enabled: boolean;
  source: "mcp" | "api";
  via?: string;
  error?: string;
}

export interface ApiProtocol {
  id: string;
  label: string;
  kind: string;
  via: string;
  description: string;
}

// Plain HTTP-API integrations the agent can hit via web_request. No MCP
// transport, no tools — just documented endpoints.
export const API_PROTOCOLS: ApiProtocol[] = [];

const PROTOCOL_DESCRIPTIONS: Record<string, string> = {
  base: "Base account MCP — your wallet on Base. Provides read access to balances/portfolio and the ability to construct send/swap/sign transactions for approval in Base account.",
  moralis:
    "Moralis Web3 Data API — native bunnyOS implementation. Multi-chain EVM read tools: wallet history, token balances + USD prices, NFTs, DeFi positions, token metadata + holders + prices. Requires a Moralis API key (set in Configure → llm).",
  coingecko:
    "CoinGecko price + market data — native bunnyOS implementation. REQUIRED: bunnyOS needs a CoinGecko Demo key for token pricing, discovery, and global market context. CEX-grade endpoints: coin price by id, token price by contract address (defaults to Base), top market-cap listings (with category filters like base-ecosystem/meme-token), full coin metadata, search (resolve ticker → coin id), trending coins, and global market snapshot. On-chain endpoints (also require the demo key): live DEX token data and pool search — indexes brand-new launches fast, so it's the liquidity/price oracle for fresh tokens. Free Demo tier (no card required, ~30 req/min, get one at coingecko.com/en/api/pricing).",
  bankr:
    "Bankr token launches — native bunnyOS implementation. Single tool that returns the most recent (last ~50) token launches tracked by Bankr (https://bankr.bot). Public endpoint, no key required.",
  native:
    "bunnyOS native tools — our own composed functions, not thin wrappers around one API. Each tool fans out to the existing data sources and merges the results into a single answer. Currently: research_token aggregates onchain market data (price, liquidity, market cap, momentum, top pool — from CoinGecko) and contract security (ownership-renounced + severity-ranked findings like honeypot, blocked sells, blacklist, high taxes, unverified source — from GMGN) for a Base token address in one call. No key required; degrades gracefully when an underlying source has no data.",
  defillama:
    "DeFi Llama — native bunnyOS implementation against the free public API (api.llama.fi + coins.llama.fi). Covers protocol TVL, chain TVL history, token prices (current/historical/chart), yield pools, stablecoins, DEX volumes, options, open interest, and fees/revenue. Large list endpoints accept `limit` and are trimmed/projected server-side. No API key required.",
  avantis:
    "Avantis perps — native bunnyOS implementation against Avantis's public, keyless APIs on Base. Market intelligence for the leverage/perpetuals DEX: list tradable pairs with leverage caps and open interest, full per-pair detail (OI long/short, utilization, hourly borrow fee, leverage tiers, spread, fees, liquidity, min size), live Pyth oracle prices, and any wallet's open positions / pending orders / PnL. Trading is supported: open and close positions are built as unsigned calldata via Avantis's official tx-builder and executed through Base MCP send_calls — Bunny never holds a key or broadcasts. No API key required.",
  definitive:
    "Definitive Flash — native bunnyOS implementation, non-custodial DEX execution on Base. Quote, swap, order status, and cancel. Swaps are intent-based: Flash returns the signing payloads (token approval + Permit2 + order), the user signs/approves each in their Base wallet via Base MCP, and Bunny submits the signed order — Bunny never holds a key. Uses the operator's integrator API key (or a public fallback); no per-user key required. Tools: definitive_quote (preview), definitive_swap (start), definitive_finalize (advance after each wallet approval), definitive_orders, definitive_order_status, definitive_cancel_order.",
  gmgn:
    "GMGN OpenAPI — native bunnyOS implementation, READ-ONLY. Meme/degen market intelligence across sol/bsc/base/eth (defaults to base): token info + price, security audit (honeypot/rug/renounced/dev wallet/holder concentration), liquidity pool, top holders + traders, trending tokens (rich sorts + safety filters), OHLCV klines, Trenches new-launch discovery, smart-money + KOL activity feeds, and wallet P&L / activity / dev-created-tokens. Requires a per-user GMGN API key (free at gmgn.ai). No trade execution and no private key — signed swap/order endpoints are deliberately excluded.",
  zerion:
    "Zerion REST API — native bunnyOS implementation, READ-ONLY. The full set of Zerion's 8 wallet endpoints on Base (and other EVM chains): portfolio overview (total value, by chain, by position type, 24h change), detailed fungible + DeFi positions (spam filtered, sorted by value), PnL summary, portfolio value chart over time, transaction history, NFT positions, NFT portfolio summary, and NFT collections. The cheaper dashboard-grade alternative to Moralis for the portfolio surface — wallet-only, no token search. Not on the bunnyDS gateway path — needs a per-user Zerion API key (Basic auth) from developers.zerion.io. Defaults to chain='base'.",
  coinstats:
    "CoinStats Open API — native bunnyOS implementation, READ-ONLY. Scoped to three surfaces on Base (and other EVM chains): wallet data (token balances with USD prices, DeFi positions, transaction history, profit-and-loss — transactions/PnL need a one-time coinstats_wallet_sync first), crypto news (latest, by type — handpicked/trending/latest/bullish/bearish — and sources), and NFTs held by a wallet. Wallet endpoints default to connectionId='base-wallet'. Routes through the bunnyDS gateway when on; otherwise needs a per-user CoinStats API key from openapi.coinstats.app.",
};

router.get("/protocols", async (_req, res): Promise<void> => {
  try {
    const base = await getBaseMcpStatus();
    const anon = listAnonMcpStatuses();
    const moralis = moralisStatus();
    const coingecko = coinGeckoStatus();
    const bankr = bankrStatus();
    const protocols: ProtocolStatus[] = [
      {
        id: "native",
        label: "OS native",
        kind: "token research",
        connected: nativeToolsStatus().connected,
        toolCount: nativeToolsStatus().toolCount,
        requiresAuth: false,
        enabled: isProtocolEnabled("native"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "base",
        label: "base mcp",
        kind: "wallet / swap / send / sign",
        connected: base.connected,
        toolCount: base.toolCount,
        requiresAuth: true,
        enabled: isProtocolEnabled("base"),
        source: "mcp",
      },
      {
        id: "moralis",
        label: "moralis",
        kind: "wallet / token / nft / defi data",
        connected: moralis.connected,
        toolCount: moralis.toolCount,
        requiresAuth: true,
        enabled: isProtocolEnabled("moralis"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "coingecko",
        label: "coingecko",
        kind: "prices / markets / onchain dex",
        connected: coingecko.connected,
        toolCount: coingecko.toolCount,
        requiresAuth: true,
        enabled: isProtocolEnabled("coingecko"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "defillama",
        label: "defillama",
        kind: "tvl / yields / dex / fees / stablecoins",
        connected: defiLlamaStatus().connected,
        toolCount: defiLlamaStatus().toolCount,
        requiresAuth: false,
        enabled: isProtocolEnabled("defillama"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "bankr",
        label: "bankr",
        kind: "token launches",
        connected: bankr.connected,
        toolCount: bankr.toolCount,
        requiresAuth: false,
        enabled: isProtocolEnabled("bankr"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "avantis",
        label: "avantis",
        kind: "perps / leverage",
        connected: avantisStatus().connected,
        toolCount: avantisStatus().toolCount,
        requiresAuth: false,
        enabled: isProtocolEnabled("avantis"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "gmgn",
        label: "gmgn",
        kind: "meme intel / smart money / discovery",
        connected: gmgnStatus().connected,
        toolCount: gmgnStatus().toolCount,
        requiresAuth: true,
        enabled: isProtocolEnabled("gmgn"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "zerion",
        label: "zerion",
        kind: "wallet / portfolio / pnl / nft data",
        connected: zerionStatus().connected,
        toolCount: zerionStatus().toolCount,
        requiresAuth: true,
        enabled: isProtocolEnabled("zerion"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "coinstats",
        label: "coinstats",
        kind: "wallet / news / nft data",
        connected: coinstatsStatus().connected,
        toolCount: coinstatsStatus().toolCount,
        requiresAuth: true,
        enabled: isProtocolEnabled("coinstats"),
        source: "api" as const,
        via: "native",
      },
      {
        id: "definitive",
        label: "definitive",
        kind: "swap execution / dex",
        connected: definitiveStatus().connected,
        toolCount: definitiveStatus().toolCount,
        requiresAuth: false,
        enabled: isProtocolEnabled("definitive"),
        source: "api" as const,
        via: "native",
      },
      ...anon.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        connected: a.connected,
        toolCount: a.toolCount,
        requiresAuth: false,
        enabled: isProtocolEnabled(a.id),
        source: "mcp" as const,
        ...(a.error ? { error: a.error } : {}),
      })),
      ...API_PROTOCOLS.map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        connected: true, // HTTP APIs are assumed reachable
        toolCount: 0,
        requiresAuth: false,
        enabled: isProtocolEnabled(p.id),
        source: "api" as const,
        via: p.via,
      })),
    ];
    res.json({
      protocols: protocols.map((p) => ({
        ...p,
        defaultOff: isProtocolDefaultOff(p.id),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.get("/protocols/:id/tools", async (req, res): Promise<void> => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  try {
    if (id === "base") {
      const tools = await listBaseMcpTools();
      res.json({
        id,
        label: "base mcp",
        kind: "wallet / swap / send / sign",
        source: "mcp",
        description: PROTOCOL_DESCRIPTIONS["base"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "moralis") {
      const tools = listMoralisTools();
      res.json({
        id,
        label: "moralis",
        kind: "wallet / token / nft / defi data",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["moralis"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "coingecko") {
      const tools = listCoinGeckoTools();
      res.json({
        id,
        label: "coingecko",
        kind: "prices / markets / onchain dex",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["coingecko"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "defillama") {
      const tools = listDefiLlamaTools();
      res.json({
        id,
        label: "defillama",
        kind: "tvl / yields / dex / fees / stablecoins",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["defillama"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "bankr") {
      const tools = listBankrTools();
      res.json({
        id,
        label: "bankr",
        kind: "token launches",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["bankr"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "avantis") {
      const tools = listAvantisTools();
      res.json({
        id,
        label: "avantis",
        kind: "perps / leverage",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["avantis"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "gmgn") {
      const tools = listGmgnTools();
      res.json({
        id,
        label: "gmgn",
        kind: "meme intel / smart money / discovery",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["gmgn"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "zerion") {
      const tools = listZerionTools();
      res.json({
        id,
        label: "zerion",
        kind: "wallet / portfolio / pnl / nft data",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["zerion"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "coinstats") {
      const tools = listCoinstatsTools();
      res.json({
        id,
        label: "coinstats",
        kind: "wallet / news / nft data",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["coinstats"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "definitive") {
      const tools = listDefinitiveTools();
      res.json({
        id,
        label: "definitive",
        kind: "swap execution / dex",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["definitive"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    if (id === "native") {
      const tools = listNativeTools();
      res.json({
        id,
        label: "OS native",
        kind: "token research",
        source: "api",
        via: "native",
        description: PROTOCOL_DESCRIPTIONS["native"] ?? "",
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    const anonStatus = listAnonMcpStatuses().find((a) => a.id === id);
    if (anonStatus) {
      const tools = getAnonMcpTools(id) ?? [];
      res.json({
        id,
        label: anonStatus.label,
        kind: anonStatus.kind,
        source: "mcp",
        description: `${anonStatus.label} MCP server — ${anonStatus.kind}.`,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
      return;
    }
    const api = API_PROTOCOLS.find((p) => p.id === id);
    if (api) {
      res.json({
        id,
        label: api.label,
        kind: api.kind,
        source: "api",
        via: api.via,
        description: api.description,
        tools: [],
      });
      return;
    }
    res.status(404).json({ error: "unknown protocol" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.post("/protocols/:id", async (req, res): Promise<void> => {
  const id = req.params["id"];
  const body = req.body as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be boolean" });
    return;
  }
  if (!id) {
    res.status(400).json({ error: "missing id" });
    return;
  }
  await setProtocolEnabled(id, body.enabled);
  res.json({ id, enabled: body.enabled });
});

export default router;
