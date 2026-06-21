import { logger } from "./logger";
import {
  getCoinGeckoTokenOnchain,
  getCoinGeckoPoolData,
  coinGeckoStatus,
  type CoinGeckoMarketData,
} from "./coingecko";
import { getTokenSecuritySafe, type TokenSecurity } from "./token-security";
import { callTool } from "./base-mcp";
import { extractApprovalUrls } from "./bunny-agent";
import {
  getBillingStatus,
  buildAllowanceApproveCalls,
} from "./bunnyds-billing";

// bunnyOS native tools — the "call our own functions" set.
//
// Unlike the other tool libs (moralis/coingecko/defillama/bankr), these are NOT
// thin wrappers around a single upstream endpoint. They are higher-level
// COMPOSED functions implemented by bunnyOS that fan out to the existing data
// sources and merge the results into one answer, so the agent gets a complete
// picture from a single tool call instead of orchestrating three.
//
// Market data still comes exclusively from the CoinGecko demo API (per the
// project-wide mandate); contract-security data comes from GMGN (enrichment
// only). No new external data hosts are introduced here.
//
// Protocol id is "native"; gated by isProtocolEnabled("native") and toggleable
// from the Configure → protocols screen like every other tool set.

export interface NativeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ToolRunner = (
  args: Record<string, unknown>,
) => Promise<{ content: string; isError: boolean }>;

const DEFAULT_NETWORK = "base";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function reqAddress(args: Record<string, unknown>): string {
  const raw = args["address"];
  const addr = typeof raw === "string" ? raw.trim() : "";
  if (!addr) throw new Error("missing required arg: address");
  if (!ADDRESS_RE.test(addr)) {
    throw new Error(
      `invalid token address: ${addr} (expected a 0x-prefixed 40-hex EVM contract address)`,
    );
  }
  return addr;
}

function optNetwork(args: Record<string, unknown>): string {
  const raw = args["network"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_NETWORK;
}

// Compose a full research snapshot for a single token contract: onchain market
// data (price / liquidity / market cap / volume / momentum from CoinGecko) plus
// the GMGN contract-security profile (ownership-renounced + severity-ranked
// findings). Each source degrades independently — a missing CoinGecko key or an
// unindexed token still returns whatever the other source has, with a note
// explaining the gap, rather than failing the whole call.
async function researchToken(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const address = reqAddress(args);
  const network = optNetwork(args);
  const key = address.toLowerCase();
  const notes: string[] = [];

  let market:
    | (CoinGeckoMarketData & {
        topPool: string | null;
        volume24hAggregate: number | null;
      })
    | null = null;

  try {
    const onchain = await getCoinGeckoTokenOnchain([key], network);
    const info = onchain.get(key);
    if (info?.pool) {
      const pd = await getCoinGeckoPoolData([info.pool], network);
      const md = pd.data.get(info.pool.toLowerCase());
      if (md) {
        market = {
          ...md,
          topPool: info.pool,
          volume24hAggregate: info.volume24h,
        };
      }
    }
    if (!market) {
      if (!coinGeckoStatus().connected) {
        notes.push(
          "no onchain market data: CoinGecko demo key not configured (set it in Configure → llm).",
        );
      } else {
        notes.push(
          "no onchain market data: CoinGecko has not indexed a pool for this token on this network.",
        );
      }
    }
  } catch (err) {
    logger.warn({ err, address: key }, "native research: market lookup failed");
    notes.push("onchain market lookup failed (transient upstream error).");
  }

  let security: TokenSecurity | null = null;
  if (network === DEFAULT_NETWORK) {
    try {
      security = await getTokenSecuritySafe(key);
      if (!security) {
        notes.push(
          "no contract-security data: GMGN has no record for this token, or GMGN is not connected (turn on bunnyDS or add a GMGN key).",
        );
      }
    } catch (err) {
      logger.warn(
        { err, address: key },
        "native research: security lookup failed",
      );
      notes.push("contract-security lookup failed (transient upstream error).");
    }
  } else {
    // Security here is scoped to base to match the base-focused market data.
    // Skip it on other networks rather than pairing base security with non-base
    // market data for the same hex address, which would be misleading.
    notes.push(
      `contract-security skipped: only available on base, requested network was '${network}'.`,
    );
  }

  const payload = {
    address: key,
    network,
    market,
    security,
    notes,
  };
  return { isError: false, content: JSON.stringify(payload) };
}

// Read the active wallet's bunnyDS billing snapshot (allowance / balance /
// owed / credit + the USDC + Collector addresses). Surfaces the per-wallet
// metered-billing state so the agent can answer "how much bunnyDS credit do I
// have left" / "what's my allowance". Returns a `configured: false` snapshot
// (not an error) when the user hasn't minted a wallet session token yet.
async function bunnydsBillingStatus(): Promise<{
  content: string;
  isError: boolean;
}> {
  const billing = await getBillingStatus();
  return { isError: false, content: JSON.stringify(billing) };
}

// Set (or raise) the wallet's USDC spending allowance for the bunnyDS gateway
// Collector. Builds an ERC-20 approve(Collector, amount) batch and forwards it
// to Base MCP `send_calls`; the user approves it in their wallet via the
// returned approval URL. Echoes `approvalUrl` in the content so the agent can
// surface it to the user (Bunny never broadcasts).
async function bunnydsSetAllowance(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const raw = args["amount"];
  const amount =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number"
        ? String(raw)
        : "";
  if (!amount || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new Error("missing/invalid arg: amount (positive USDC number)");
  }
  const calls = await buildAllowanceApproveCalls(amount);
  const result = await callTool("send_calls", { chain: "base", calls });
  if (result.isError) {
    return { isError: true, content: result.content || "send_calls failed" };
  }
  const approvalUrls = extractApprovalUrls(result.content);
  return {
    isError: false,
    content: JSON.stringify({
      submitted: true,
      amountUsdc: amount,
      approvalUrl: approvalUrls[0] ?? null,
      approvalUrls,
    }),
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "bunnyds_billing_status",
    description:
      "Read the user's bunnyDS gateway billing for their connected Base wallet: USDC spending allowance, balance, amount owed, and remaining credit, plus the USDC + Collector contract addresses. bunnyDS is metered per wallet (USDC on Base). `configured` is whether the gateway has metering turned on (false = bunnyDS is free/dormant, no allowance needed); `connected` is whether THIS user has minted a wallet session token (allowance/balance/owed/credit are only populated when connected) — tell them to connect bunnyDS to see their live metered state. Use when the user asks about their bunnyDS credit, allowance, or spending.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bunnyds_set_allowance",
    description:
      "Set or raise the user's USDC spending allowance for the bunnyDS gateway Collector on Base. Submits an ERC-20 approve via the user's wallet and returns an `approvalUrl` the user must open to sign — surface that URL to them. The Collector/USDC addresses come from the gateway's billing config, so this works even before the user mints a session token, as long as the gateway has metering enabled (`configured: true`). Confirm the amount with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description:
            "The USDC allowance to approve (human units, e.g. '25' for 25 USDC).",
        },
      },
      required: ["amount"],
    },
  },
  {
    name: "research_token",
    description:
      "Research a single token by its contract address on Base. Composes onchain market data (USD price, liquidity, market cap, 1h/24h price change, 24h volume, top pool address — all from CoinGecko) with the token's contract-security profile (ownership-renounced flag and severity-ranked findings such as honeypot, blocked sells, blacklist, high trading taxes, unverified source — from GMGN) into one call. Use this as the first stop when the user asks you to research / vet / due-diligence a token address. Returns partial data with a `notes` array if a source has nothing for the token.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "The token contract address (CA), 0x-prefixed 40-hex EVM address.",
        },
        network: {
          type: "string",
          description:
            "Network slug. Optional, defaults to 'base'. Contract-security data is Base-only and is skipped (with a note) on other networks.",
        },
      },
      required: ["address"],
    },
  },
];

const RUNNERS = new Map<string, ToolRunner>([
  ["research_token", researchToken],
  ["bunnyds_billing_status", bunnydsBillingStatus],
  ["bunnyds_set_allowance", bunnydsSetAllowance],
]);

const toolIndex = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function listNativeTools(): NativeTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findNativeTool(name: string): boolean {
  return toolIndex.has(name);
}

// Native composed tools have no key/connection of their own — they are always
// "connected". They depend on CoinGecko/CoinStats at call time and degrade
// gracefully when those are unavailable.
export function nativeToolsStatus(): { connected: boolean; toolCount: number } {
  return { connected: true, toolCount: TOOLS.length };
}

export async function callNativeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const run = RUNNERS.get(name);
  if (!run) {
    return { isError: true, content: `Unknown native tool: ${name}` };
  }
  try {
    return await run(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `native tool ${name} failed: ${message}` };
  }
}
