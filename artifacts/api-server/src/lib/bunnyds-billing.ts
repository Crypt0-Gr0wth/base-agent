// bunnyDS per-wallet billing.
//
// Gateway usage (inference + billed data) is metered against a USDC allowance
// the wallet grants the gateway's Collector contract on Base. This module:
//   - discovers billing availability + the live USDC/Collector addresses from
//     the gateway's UNAUTHENTICATED /v1/billing/config (so the UI can prompt
//     approve() before any wallet session token exists)
//   - reads the wallet's metered state (allowance / balance / owed / credit)
//     from the AUTHENTICATED /v1/billing/wallet once a token is minted
//   - builds the ERC-20 approve(Collector, amount) call batch the agent forwards
//     to Base MCP `send_calls` (Bunny never holds a key or broadcasts)
//
// Setting an allowance only needs the addresses (from config) + the user's Base
// wallet via send_calls — NOT a gateway session token. The token is only needed
// to read the per-wallet metered state and to actually use the gateway.

import { getAddress, encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { getCurrentUserWallet } from "./user";
import { clearBunnydsSession } from "./settings";
import type { Call } from "./bunny-exchange";
import {
  gatewayAuthHeaders,
  gatewayBillingWalletUrl,
  gatewayBillingConfigUrl,
  isGatewayConfigured,
} from "./bunnyos-gateway";

// USDC on Base has 6 decimals.
const USDC_DECIMALS = 6;

// Base mainnet chain id, canonical Circle USDC, and the zero address. The
// billing-config endpoint is intentionally UNAUTHENTICATED, so before we ever
// build an on-chain approve() from its response we fail closed unless the chain
// is Base and the token is canonical USDC — a compromised/misconfigured config
// must not be able to induce an approval against an attacker-controlled token.
const BASE_CHAIN_ID = 8453;
const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Gateway billing discovery (global, not user-scoped).
export interface BunnydsBillingConfig {
  // Whether the operator has provisioned metering. When false, bunnyDS is
  // dormant/free and no allowance is needed.
  configured: boolean;
  chainId: number | null;
  network: string | null;
  // Live on-chain addresses to approve against.
  usdc: string | null;
  collector: string | null;
  inferenceEnabled: boolean;
  dataEnabled: boolean;
}

export interface BunnydsBilling extends BunnydsBillingConfig {
  // Whether THIS user has minted a wallet session token (can read metered
  // state + use the gateway). Distinct from `configured` (operator-side).
  connected: boolean;
  wallet: string | null;
  // Per-wallet metered state (only populated once connected). Best-effort
  // strings as returned by the gateway.
  allowance: string | null;
  balance: string | null;
  owed: string | null;
  credit: string | null;
}

function emptyConfig(): BunnydsBillingConfig {
  return {
    configured: false,
    chainId: null,
    network: null,
    usdc: null,
    collector: null,
    inferenceEnabled: false,
    dataEnabled: false,
  };
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function bool(v: unknown): boolean {
  return v === true;
}

// Pull a field that may be nested under a few common envelope keys.
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return undefined;
}

function parseConfig(json: unknown): BunnydsBillingConfig {
  if (!json || typeof json !== "object") return emptyConfig();
  const o = json as Record<string, unknown>;
  return {
    configured: bool(o["configured"]),
    chainId: num(o["chainId"]),
    network: str(o["network"]),
    usdc: str(pick(o, "usdc", "usdcAddress")),
    collector: str(pick(o, "collector", "collectorAddress", "spender")),
    inferenceEnabled: bool(o["inferenceEnabled"]),
    dataEnabled: bool(o["dataEnabled"]),
  };
}

// Process-wide cache for the (global) billing config. Short TTL so a freshly
// provisioned gateway is picked up quickly without hammering /v1/billing/config
// on every billing read, chat tool call, and page load.
const CONFIG_TTL_MS = 60_000;
let configCache: { value: BunnydsBillingConfig; at: number } | null = null;
let configInFlight: Promise<BunnydsBillingConfig> | null = null;

// Read the gateway's billing config (unauthenticated). Never throws — returns
// an unconfigured snapshot if the gateway is unreachable or errors.
export async function getBillingConfig(
  force = false,
): Promise<BunnydsBillingConfig> {
  const now = Date.now();
  if (!force && configCache && now - configCache.at < CONFIG_TTL_MS) {
    return configCache.value;
  }
  if (configInFlight) return configInFlight;
  configInFlight = (async () => {
    try {
      const res = await fetch(gatewayBillingConfigUrl(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return configCache?.value ?? emptyConfig();
      const value = parseConfig((await res.json()) as unknown);
      configCache = { value, at: Date.now() };
      return value;
    } catch {
      return configCache?.value ?? emptyConfig();
    } finally {
      configInFlight = null;
    }
  })();
  return configInFlight;
}

function base(config: BunnydsBillingConfig, connected: boolean): BunnydsBilling {
  return {
    ...config,
    connected,
    wallet: null,
    allowance: null,
    balance: null,
    owed: null,
    credit: null,
  };
}

// Read the active user's bunnyDS billing snapshot: the gateway billing config
// (always, even pre-connect) merged with the per-wallet metered state (only
// once a session token is minted). Never throws on the "not set up yet" paths
// (gateway dormant, no token, no wallet, or a 404 for this wallet); a stale/
// rejected token (401/403) is cleared and surfaced as disconnected.
export async function getBillingStatus(): Promise<BunnydsBilling> {
  const config = await getBillingConfig();
  const connected = isGatewayConfigured();
  const snapshot = base(config, connected);
  if (!connected) return snapshot;

  const rawWallet = await getCurrentUserWallet();
  if (!rawWallet) return snapshot;
  const wallet = getAddress(rawWallet);
  snapshot.wallet = wallet;

  const res = await fetch(gatewayBillingWalletUrl(wallet), {
    headers: { Accept: "application/json", ...gatewayAuthHeaders() },
  });
  // 401/403 => the stored wallet session token is missing/expired/rejected
  // (the gateway returns `wallet_session_required`). Clear it and surface as
  // disconnected so the UI flips back to "connect" instead of throwing.
  if (res.status === 401 || res.status === 403) {
    await clearBunnydsSession();
    snapshot.connected = false;
    return snapshot;
  }
  // 404 => no metered record for this wallet yet (no allowance set). Keep the
  // config addresses so the UI can still show the approve() flow.
  if (res.status === 404) return snapshot;
  if (!res.ok) {
    throw new Error(`bunnyDS billing request failed (${res.status})`);
  }
  const json = (await res.json()) as unknown;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    // The wallet read may also echo the addresses — prefer config, fall back.
    snapshot.usdc =
      snapshot.usdc ?? str(pick(o, "usdc", "usdcAddress", "token"));
    snapshot.collector =
      snapshot.collector ?? str(pick(o, "collector", "collectorAddress", "spender"));
    // The gateway returns allowanceUsd/balanceUsd/owedUsd/availableUsd; credit
    // maps to availableUsd (= min(allowance, balance) − owed). Older/alias keys
    // kept as fallbacks.
    snapshot.allowance = str(
      pick(o, "allowanceUsd", "allowance", "approved", "limit"),
    );
    snapshot.balance = str(pick(o, "balanceUsd", "balance", "usdcBalance"));
    snapshot.owed = str(pick(o, "owedUsd", "owed", "due", "outstanding"));
    snapshot.credit = str(
      pick(o, "availableUsd", "credit", "creditRemaining", "remaining"),
    );
  }
  return snapshot;
}

// Build the ERC-20 approve(Collector, amount) call batch for the gateway's USDC
// Collector. The caller forwards the returned Call[] to Base MCP `send_calls`.
// Sourced from the gateway's billing config (no session token required — the
// approve is an on-chain tx signed by the user's Base wallet).
export async function buildAllowanceApproveCalls(
  amountUsdc: string,
): Promise<Call[]> {
  const config = await getBillingConfig();
  if (!config.configured || !config.usdc || !config.collector) {
    throw new Error(
      "bunnyDS billing isn't enabled on the gateway yet — bunnyDS runs free until the operator turns on metering, so no allowance is needed",
    );
  }
  // Fail closed: the config endpoint is unauthenticated, so refuse to build an
  // approve() unless it's Base + canonical USDC + a sane, distinct Collector.
  if (config.chainId != null && config.chainId !== BASE_CHAIN_ID) {
    throw new Error(
      `bunnyDS billing is on an unexpected chain (${config.chainId}); refusing to set an allowance`,
    );
  }
  let usdc: `0x${string}`;
  let collector: `0x${string}`;
  try {
    usdc = getAddress(config.usdc);
    collector = getAddress(config.collector);
  } catch {
    throw new Error(
      "bunnyDS billing returned an invalid USDC/Collector address; refusing to set an allowance",
    );
  }
  if (usdc !== BASE_USDC) {
    throw new Error(
      "bunnyDS billing returned an unexpected USDC token address; refusing to set an allowance",
    );
  }
  if (collector === ZERO_ADDRESS || collector === usdc) {
    throw new Error(
      "bunnyDS billing returned an invalid Collector address; refusing to set an allowance",
    );
  }
  const amount = parseUnits(amountUsdc, USDC_DECIMALS);
  if (amount <= 0n) {
    throw new Error("allowance amount must be greater than zero");
  }
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [collector, amount],
  });
  return [{ to: usdc, value: "0x0", data }];
}
