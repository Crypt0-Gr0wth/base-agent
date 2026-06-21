import { Router, type IRouter } from "express";
import { callCoinstatsTool, coinstatsStatus } from "../lib/coinstats";
import { take } from "../lib/rate-limit";
import { getCurrentUserId, getCurrentUserWallet } from "../lib/user";
import { isProtocolEnabled } from "../lib/settings";

// Native read-only surface for the portfolio page. Token holdings and DeFi /
// staking positions both come from the CoinStats wallet API (projected into
// typed JSON here); perps come from /api/perps/positions. Both surfaces are
// gated behind the coinstats protocol toggle + its connection status (bunnyDS
// gateway or a per-user CoinStats key) and are live (no wallet sync needed).
const router: IRouter = Router();

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstNum(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== null) return n;
  }
  return null;
}

// CoinStats returns money values as { USD, BTC, ETH } objects rather than plain
// numbers. Accept a number/numeric-string OR pull the USD member.
function usdNum(v: unknown): number | null {
  const direct = num(v);
  if (direct !== null) return direct;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return num(o["USD"]) ?? num(o["usd"]);
  }
  return null;
}

function firstUsd(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const n = usdNum(o[k]);
    if (n !== null) return n;
  }
  return null;
}

function str(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

// CoinStats wallet endpoints variously wrap rows in `result`/`data`, key them by
// chain/connection, or return a bare array. Normalize all of them to a flat
// array of row objects.
function listOf(parsed: unknown, ...wrapperKeys: string[]): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const k of ["result", "data", ...wrapperKeys]) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
    // Some balance responses are keyed by chain/connection id -> array. Flatten
    // every array-valued property as a fallback.
    const flattened: unknown[] = [];
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) flattened.push(...v);
    }
    if (flattened.length) return flattened;
  }
  return [];
}

function coinstatsAvailable(): boolean {
  return isProtocolEnabled("coinstats") && coinstatsStatus().connected;
}

interface TokenView {
  symbol: string | null;
  name: string | null;
  logo: string | null;
  balance: string | null;
  usdValue: number | null;
  usdPrice: number | null;
  pct24h: number | null;
  nativeToken: boolean;
  contractAddress: string | null;
}

function projectToken(raw: unknown): TokenView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const symbol = str(o, "symbol", "coinSymbol");
  const name = str(o, "name", "coinName");
  // Discriminator: a real holding must identify a coin AND carry some numeric
  // signal. This keeps the broad array-flatten fallback in listOf() from
  // letting unrelated rows pollute holdings / totalUsd.
  const amount = firstNum(o, "amount", "balance", "balance_formatted");
  const price = firstNum(o, "price", "priceUsd", "usd_price");
  let usdValue = firstNum(o, "value", "valueUsd", "usd_value", "totalValue");
  if (usdValue === null && amount !== null && price !== null) {
    usdValue = amount * price;
  }
  if (!symbol && !name) return null;
  if (amount === null && price === null && usdValue === null) return null;
  const contract = str(o, "contractAddress", "contract_address", "tokenAddress");
  return {
    symbol,
    name,
    logo: str(o, "imgUrl", "icon", "logo", "image", "thumbnail"),
    balance: amount !== null ? String(amount) : str(o, "amount", "balance"),
    usdValue,
    usdPrice: price,
    pct24h: firstNum(
      o,
      "pCh24h",
      "priceChange1d",
      "priceChange24h",
      "pricePercentChange24h",
      "usd_price_24hr_percent_change",
    ),
    nativeToken: !contract,
    contractAddress: contract,
  };
}

interface DefiPositionView {
  protocol: string | null;
  protocolLogo: string | null;
  label: string | null;
  valueUsd: number | null;
  unclaimedUsd: number | null;
  tokens: string[];
  // Vault/pool contract for this position. Equals the share token's
  // contractAddress in the wallet-balance list, so the client can dedupe.
  poolAddress: string | null;
}

function tokenSymbols(raw: unknown): string[] {
  // CoinStats hands back `symbols` as a delimited string (e.g. "USDC,WETH").
  if (typeof raw === "string") {
    return raw
      .split(/[,/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((t) =>
      typeof t === "string"
        ? t
        : t && typeof t === "object"
          ? str(t as Record<string, unknown>, "symbol", "name", "coinSymbol")
          : null,
    )
    .filter((s): s is string => Boolean(s));
}

// Collect token symbols from every shape CoinStats / generic providers use:
// a `symbols` string, `tokens`/`underlyingTokens` arrays, or an `assets` array.
function defiTokens(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const part of [
    tokenSymbols(o["symbols"]),
    tokenSymbols(o["tokens"]),
    tokenSymbols(o["underlyingTokens"]),
    tokenSymbols(o["assets"]),
  ]) {
    for (const s of part) if (!out.includes(s)) out.push(s);
  }
  return out;
}

// A single CoinStats DeFi row may either be a flat position or a protocol bucket
// containing a nested `positions` array. Expand both into one view per position.
function projectDefiRows(raw: unknown): DefiPositionView[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const protocol = str(o, "protocolName", "protocol_name", "protocol", "name", "appName");
  const protocolLogo = str(o, "protocolLogo", "protocol_logo", "logo", "icon", "imgUrl");
  // CoinStats nests per-position rows under `investments`; other shapes use
  // `positions`/`items`. USD values arrive as { USD, BTC, ETH } objects, so pull
  // `.USD` via firstUsd instead of treating them as plain numbers.
  const nested = Array.isArray(o["investments"])
    ? (o["investments"] as unknown[])
    : Array.isArray(o["positions"])
      ? (o["positions"] as unknown[])
      : Array.isArray(o["items"])
        ? (o["items"] as unknown[])
        : null;
  if (nested && nested.length) {
    const out: DefiPositionView[] = [];
    for (const p of nested) {
      if (!p || typeof p !== "object") continue;
      const po = p as Record<string, unknown>;
      out.push({
        protocol,
        protocolLogo,
        label: str(po, "description", "name", "label", "type"),
        valueUsd: firstUsd(
          po,
          "value",
          "totalValue",
          "valueUsd",
          "balanceUsd",
          "total_usd_value",
        ),
        unclaimedUsd: firstUsd(po, "unclaimedValue", "unclaimedUsd", "rewardsUsd"),
        tokens: defiTokens(po),
        // Only the explicit pool/vault contract — NOT generic `address`, which
        // CoinStats uses for the underlying deposit asset (e.g. USDC) and would
        // cause false-positive dedupe against the real USDC balance.
        poolAddress:
          str(po, "poolAddress", "pool_address") ?? str(o, "poolAddress", "pool_address"),
      });
    }
    if (out.length) return out;
  }
  return [
    {
      protocol,
      protocolLogo,
      label: str(o, "label", "type"),
      valueUsd: firstUsd(
        o,
        "totalValue",
        "value",
        "valueUsd",
        "balanceUsd",
        "total_usd_value",
      ),
      unclaimedUsd: firstUsd(o, "unclaimedValue", "unclaimedUsd", "rewardsUsd"),
      tokens: defiTokens(o),
      poolAddress: str(o, "poolAddress", "pool_address"),
    },
  ];
}

// GET /api/portfolio/tokens — the active user's token holdings on Base with USD
// prices and 24h change, sourced from the CoinStats wallet balance API. Returns
// enabled=false (200) when coinstats is off/unconnected, needsWallet=true (200)
// when no wallet is connected.
router.get("/portfolio/tokens", async (req, res): Promise<void> => {
  if (!coinstatsAvailable()) {
    res.json({ enabled: false, needsWallet: false, tokens: [] });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.json({ enabled: true, needsWallet: true, tokens: [] });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const out = await callCoinstatsTool("coinstats_wallet_balance", {
    address: wallet,
  });
  if (out.isError) {
    res.status(502).json({ error: out.content });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    res.status(502).json({ error: "failed to parse coinstats response" });
    return;
  }
  const tokens = listOf(parsed, "balances", "coins", "assets")
    .map(projectToken)
    .filter((t): t is TokenView => t !== null)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  const totalUsd = tokens.reduce((sum, t) => sum + (t.usdValue ?? 0), 0);
  res.json({ enabled: true, needsWallet: false, wallet, totalUsd, tokens });
});

// GET /api/portfolio/defi — the active user's DeFi / staking / LP positions on
// Base, sourced from CoinStats. Returns enabled=false (200) when coinstats is
// off/unconnected, needsWallet=true (200) when no wallet is connected yet.
router.get("/portfolio/defi", async (req, res): Promise<void> => {
  if (!coinstatsAvailable()) {
    res.json({ enabled: false, needsWallet: false, positions: [] });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.json({ enabled: true, needsWallet: true, positions: [] });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const out = await callCoinstatsTool("coinstats_wallet_defi", {
    address: wallet,
  });
  if (out.isError) {
    res.status(502).json({ error: out.content });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    res.status(502).json({ error: "failed to parse coinstats response" });
    return;
  }
  const positions = listOf(parsed, "positions", "protocols")
    .flatMap(projectDefiRows)
    // Discriminator: a real position must carry a USD value or underlying
    // tokens. A bare protocol name alone is not enough to count as a holding.
    .filter((p) => p.valueUsd !== null || p.tokens.length > 0);
  const totalUsd = positions.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0);
  res.json({ enabled: true, needsWallet: false, wallet, totalUsd, positions });
});

// CoinStats /wallet/chart and /wallet/transactions both return an error until
// the wallet has been indexed once via PATCH /wallet/transactions
// (coinstats_wallet_sync). The chart 400s ("call PATCH … to sync the data"), the
// transactions 409s ("not synced"). Detect that, kick off a best-effort sync
// (itself rate-limited on the free plan, so swallow its failures), and tell the
// client we're syncing so it can show a spinner and poll. In practice the sync
// completes within seconds.
function isNotSynced(content: string): boolean {
  return /sync/i.test(content) && /\b(400|409)\b/.test(content);
}

async function triggerWalletSync(wallet: string): Promise<void> {
  try {
    await callCoinstatsTool("coinstats_wallet_sync", { address: wallet });
  } catch {
    // best effort — the sync endpoint is rate-limited; the client retries.
  }
}

interface TxView {
  type: string | null;
  date: string | null;
  symbol: string | null;
  amount: number | null;
  valueUsd: number | null;
  hash: string | null;
  explorerUrl: string | null;
}

// CoinStats transaction rows nest the coin under `coinData` ({ count, symbol,
// currentValue }) and the on-chain hash under `hash` ({ id, explorerUrl }).
function projectTx(raw: unknown): TxView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const coinData =
    o["coinData"] && typeof o["coinData"] === "object"
      ? (o["coinData"] as Record<string, unknown>)
      : {};
  const hashObj =
    o["hash"] && typeof o["hash"] === "object"
      ? (o["hash"] as Record<string, unknown>)
      : {};
  const type = str(o, "type");
  const symbolRaw = str(coinData, "symbol");
  const symbol = symbolRaw ? symbolRaw.trim() || null : null;
  const date = str(o, "date");
  if (!type && !symbol && !date) return null;
  return {
    type,
    date,
    symbol,
    amount: firstNum(coinData, "count"),
    valueUsd: firstUsd(coinData, "currentValue"),
    hash: str(hashObj, "id"),
    explorerUrl: str(hashObj, "explorerUrl"),
  };
}

// GET /api/portfolio/transactions — the active user's most recent wallet
// transactions on Base, sourced from the CoinStats wallet transactions API.
// Same gating as the chart route, including the syncing=true bootstrap state.
router.get("/portfolio/transactions", async (req, res): Promise<void> => {
  if (!coinstatsAvailable()) {
    res.json({ enabled: false, needsWallet: false, syncing: false, transactions: [] });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.json({ enabled: true, needsWallet: true, syncing: false, transactions: [] });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const out = await callCoinstatsTool("coinstats_wallet_transactions", {
    address: wallet,
    // Fetch a wider window than we display — we drop zero-value + received/fill
    // noise below, so over-fetch to still surface ~20 meaningful rows.
    limit: 50,
  });
  if (out.isError) {
    if (isNotSynced(out.content)) {
      void triggerWalletSync(wallet);
      res.json({ enabled: true, needsWallet: false, syncing: true, transactions: [] });
      return;
    }
    res.status(502).json({ error: out.content });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    res.status(502).json({ error: "failed to parse coinstats response" });
    return;
  }
  // Clean up the feed: drop noise rows — anything with no USD value, plus
  // inbound "received" airdrops and order "fill" events (low signal for a
  // portfolio activity view). Keep ~20 meaningful rows.
  const NOISE_TYPES = new Set(["received", "fill"]);
  const transactions = listOf(parsed, "transactions")
    .map(projectTx)
    .filter((t): t is TxView => t !== null)
    .filter((t) => {
      if (t.valueUsd === null || t.valueUsd <= 0) return false;
      if (t.type && NOISE_TYPES.has(t.type.toLowerCase())) return false;
      return true;
    })
    .slice(0, 20);
  res.json({ enabled: true, needsWallet: false, syncing: false, wallet, transactions });
});

export default router;
