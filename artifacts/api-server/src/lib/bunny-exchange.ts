// bunny exchange — friend.tech-style "keys" market for bunnies, settled in the
// bunnyOS (OS) ERC20 paymentToken on Base. This lib is READ + CALLDATA only:
// it reads the bonding-curve state over a viem public client and builds the
// unsigned {to,value,data} calls (ERC20 approve + buyKeys) that the route then
// forwards into Base MCP `send_calls` — bunny never holds a key or broadcasts.
import {
  createPublicClient,
  http,
  fallback,
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseAbi,
  type Address,
} from "viem";
import { base } from "viem/chains";

// The deployed bunny-keys exchange on Base.
export const EXCHANGE_ADDRESS: Address = getAddress(
  "0x33714479d7a17d24303AB3b3623d2944C444F267",
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Minimal ABI subset of the exchange we actually touch.
const EXCHANGE_ABI = parseAbi([
  "function nextBunnyId() view returns (uint256)",
  "function bunnyCreator(uint256 bunnyId) view returns (address)",
  "function totalKeysOfBunny(uint256 bunnyId) view returns (uint256)",
  "function balanceOf(uint256 bunnyId, address account) view returns (uint256)",
  "function getPrice(uint256 supply, uint256 amount) pure returns (uint256)",
  "function floorPrice() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function bps() view returns (uint256)",
  "function registrationFee() view returns (uint256)",
  "function maxKeysPerBunny() view returns (uint256)",
  "function paymentToken() view returns (address)",
  "function assetName() view returns (string)",
  "function buyKeys(uint256 bunnyId, uint256 amount, uint256 maxPrice)",
  "function sellKeys(uint256 bunnyId, uint256 amount, uint256 minPrice)",
  "function createBunny(uint256 additionalBuyAmount, uint256 maxPrice) returns (uint256)",
]);

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

// Single shared public client to Base. viem's `base` chain ships the multicall3
// address so batched reads work out of the box, but its default public endpoint
// (mainnet.base.org) is aggressively rate-limited and routinely fails the
// curve's batched multicall under any load. So instead of a single transport we
// build a viem `fallback` across several reliable keyless public Base RPCs: a
// throttle/timeout on one node automatically rolls over to the next. A
// dedicated BASE_RPC_URL (Alchemy/Infura/CDP) is honored first when set.
// `batch.multicall` coalesces concurrent reads into a single multicall3 eth_call
// to stay well under each node's per-request limit.
const FALLBACK_RPC_URLS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://base.meowrpc.com",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];
const PRIMARY_RPC_URL = process.env.BASE_RPC_URL?.trim() || undefined;
const RPC_URLS = PRIMARY_RPC_URL
  ? [PRIMARY_RPC_URL, ...FALLBACK_RPC_URLS]
  : FALLBACK_RPC_URLS;
const client = createPublicClient({
  chain: base,
  transport: fallback(
    RPC_URLS.map((url) => http(url, { timeout: 10_000, retryCount: 2 })),
    { rank: false },
  ),
  batch: { multicall: true },
});

export interface ExchangeConfig {
  exchange: Address;
  paymentToken: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  assetName: string;
  feeBps: string;
  bps: string;
  floorPriceWei: string;
  floorPrice: string;
  registrationFeeWei: string;
  registrationFee: string;
  maxKeysPerBunny: string;
}

// Config is effectively static (set at deploy/admin time), so cache the whole
// object for a while to keep the list/quote/buy paths from re-reading it.
let configCache: { value: ExchangeConfig; at: number } | null = null;
const CONFIG_TTL_MS = 10 * 60 * 1000;

export async function getExchangeConfig(): Promise<ExchangeConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.value;
  }
  const c = { address: EXCHANGE_ADDRESS, abi: EXCHANGE_ABI } as const;
  const [
    paymentToken,
    assetName,
    feeBps,
    bps,
    floorPrice,
    registrationFee,
    maxKeysPerBunny,
  ] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "paymentToken" },
      { ...c, functionName: "assetName" },
      { ...c, functionName: "feeBps" },
      { ...c, functionName: "bps" },
      { ...c, functionName: "floorPrice" },
      { ...c, functionName: "registrationFee" },
      { ...c, functionName: "maxKeysPerBunny" },
    ],
  });
  const token = getAddress(paymentToken as Address);
  const [tokenDecimals, tokenSymbol] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: token, abi: ERC20_ABI, functionName: "decimals" },
      { address: token, abi: ERC20_ABI, functionName: "symbol" },
    ],
  });
  const decimals = Number(tokenDecimals);
  const value: ExchangeConfig = {
    exchange: EXCHANGE_ADDRESS,
    paymentToken: token,
    tokenSymbol: String(tokenSymbol),
    tokenDecimals: decimals,
    assetName: String(assetName),
    feeBps: (feeBps as bigint).toString(),
    bps: (bps as bigint).toString(),
    floorPriceWei: (floorPrice as bigint).toString(),
    floorPrice: formatUnits(floorPrice as bigint, decimals),
    registrationFeeWei: (registrationFee as bigint).toString(),
    registrationFee: formatUnits(registrationFee as bigint, decimals),
    maxKeysPerBunny: (maxKeysPerBunny as bigint).toString(),
  };
  configCache = { value, at: Date.now() };
  return value;
}

export interface BunnyListItem {
  id: number;
  creator: Address;
  supply: string;
  // Cost to buy ONE key at the current supply, including protocol fee.
  buyPriceWei: string;
  buyPrice: string;
  soldOut: boolean;
  // Present only when a wallet was supplied.
  userKeys?: string;
  // Present only when the caller has connected bunnyOS and the bunny has a
  // human profile there. Purely additive — absent for everyone else.
  name?: string;
  description?: string;
}

// List every existing bunny (creator != zero) with its current supply and the
// all-in price to buy one more key. `wallet`, when given, adds the caller's
// key balance per bunny.
export async function listBunnies(
  wallet?: string | null,
): Promise<{ config: ExchangeConfig; bunnies: BunnyListItem[] }> {
  const config = await getExchangeConfig();
  const next = (await client.readContract({
    address: EXCHANGE_ADDRESS,
    abi: EXCHANGE_ABI,
    functionName: "nextBunnyId",
  })) as bigint;
  const count = Number(next);
  if (!Number.isFinite(count) || count <= 0) {
    return { config, bunnies: [] };
  }
  const ids = Array.from({ length: count }, (_, i) => i);
  const c = { address: EXCHANGE_ADDRESS, abi: EXCHANGE_ABI } as const;

  const meta = await client.multicall({
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      { ...c, functionName: "bunnyCreator", args: [BigInt(id)] },
      { ...c, functionName: "totalKeysOfBunny", args: [BigInt(id)] },
    ]),
  });

  const existing: Array<{ id: number; creator: Address; supply: bigint }> = [];
  for (let i = 0; i < ids.length; i++) {
    const creatorRes = meta[i * 2];
    const supplyRes = meta[i * 2 + 1];
    if (!creatorRes || creatorRes.status !== "success") continue;
    const creator = creatorRes.result as Address;
    if (!creator || creator.toLowerCase() === ZERO_ADDRESS) continue;
    const supply =
      supplyRes && supplyRes.status === "success"
        ? (supplyRes.result as bigint)
        : 0n;
    existing.push({ id: ids[i]!, creator: getAddress(creator), supply });
  }

  if (existing.length === 0) return { config, bunnies: [] };

  const priceRes = await client.multicall({
    allowFailure: true,
    contracts: existing.map((b) => ({
      ...c,
      functionName: "getPrice" as const,
      args: [b.supply, 1n],
    })),
  });

  const lowerWallet = wallet ? wallet.toLowerCase() : null;
  const balRes = lowerWallet
    ? await client.multicall({
        allowFailure: true,
        contracts: existing.map((b) => ({
          ...c,
          functionName: "balanceOf" as const,
          args: [BigInt(b.id), lowerWallet as Address],
        })),
      })
    : null;

  const feeBps = BigInt(config.feeBps);
  const bps = BigInt(config.bps || "10000");
  const maxKeys = BigInt(config.maxKeysPerBunny);
  const dec = config.tokenDecimals;

  const bunnies: BunnyListItem[] = existing.map((b, i) => {
    const pr = priceRes[i];
    const base =
      pr && pr.status === "success" ? (pr.result as bigint) : 0n;
    const fee = bps > 0n ? (base * feeBps) / bps : 0n;
    const allIn = base + fee;
    const item: BunnyListItem = {
      id: b.id,
      creator: b.creator,
      supply: b.supply.toString(),
      buyPriceWei: allIn.toString(),
      buyPrice: formatUnits(allIn, dec),
      soldOut: maxKeys > 0n && b.supply >= maxKeys,
    };
    if (balRes) {
      const br = balRes[i];
      item.userKeys =
        br && br.status === "success"
          ? (br.result as bigint).toString()
          : "0";
    }
    return item;
  });

  return { config, bunnies };
}

export interface BuyQuote {
  bunnyId: number;
  amount: string;
  supply: string;
  priceWei: string;
  price: string;
  feeWei: string;
  fee: string;
  totalWei: string;
  total: string;
  maxPriceWei: string;
  maxPrice: string;
  slippageBps: number;
  soldOut: boolean;
  tokenSymbol: string;
  tokenDecimals: number;
}

// Quote the cost (base + protocol fee) to buy `amount` keys of `bunnyId` at the
// current supply, plus the slippage-padded `maxPrice` the buyKeys call should
// be sent with (and the amount to approve).
export async function quoteBuy(
  bunnyId: number,
  amount: bigint,
  slippageBps = 300,
): Promise<BuyQuote> {
  if (amount <= 0n) throw new Error("amount must be a positive integer");
  const config = await getExchangeConfig();
  const c = { address: EXCHANGE_ADDRESS, abi: EXCHANGE_ABI } as const;
  // Read creator + supply together so we can reject a non-existent bunny before
  // ever building a (revert-bound) wallet request. getPrice depends on the
  // current supply, so it has to follow.
  const [creator, supplyBn] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "bunnyCreator", args: [BigInt(bunnyId)] },
      { ...c, functionName: "totalKeysOfBunny", args: [BigInt(bunnyId)] },
    ],
  });
  if (
    !creator ||
    (creator as Address).toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error(`bunny ${bunnyId} does not exist`);
  }
  const supply = supplyBn as bigint;
  const priceBn = (await client.readContract({
    ...c,
    functionName: "getPrice",
    args: [supply, amount],
  })) as bigint;

  const feeBps = BigInt(config.feeBps);
  const bps = BigInt(config.bps || "10000");
  const fee = bps > 0n ? (priceBn * feeBps) / bps : 0n;
  const total = priceBn + fee;
  // maxPrice = total padded by slippage, rounded UP (ceil). Covers both
  // interpretations (whether the contract compares maxPrice against base or
  // total) since the pad sits on top of the full all-in cost; ceiling the
  // division avoids under-padding by 1 wei at boundary cases.
  const slip = BigInt(Math.max(0, Math.floor(slippageBps)));
  const maxPrice = total + (total * slip + 9999n) / 10000n;
  const maxKeys = BigInt(config.maxKeysPerBunny);
  const soldOut = maxKeys > 0n && supply + amount > maxKeys;
  const dec = config.tokenDecimals;

  return {
    bunnyId,
    amount: amount.toString(),
    supply: supplyBn.toString(),
    priceWei: priceBn.toString(),
    price: formatUnits(priceBn, dec),
    feeWei: fee.toString(),
    fee: formatUnits(fee, dec),
    totalWei: total.toString(),
    total: formatUnits(total, dec),
    maxPriceWei: maxPrice.toString(),
    maxPrice: formatUnits(maxPrice, dec),
    slippageBps: Number(slip),
    soldOut,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: dec,
  };
}

// Quote proceeds for SELLING `amount` keys at the current supply. Sells run on
// the SAME bonding curve as buys: selling `amount` from supply `s` returns the
// area under the curve between `s-amount` and `s`, i.e. getPrice(s-amount,
// amount). A protocol fee is taken out of the proceeds; `minPrice` is the
// slippage-padded floor the sellKeys call is sent with. No ERC20 approve is
// needed — the seller surrenders keys and receives the payment token.
export interface SellQuote {
  bunnyId: number;
  amount: string;
  supply: string;
  userKeys: string;
  // gross proceeds (pre-fee) for the keys being sold
  grossWei: string;
  gross: string;
  feeWei: string;
  fee: string;
  // net = gross - fee, what the seller actually receives
  netWei: string;
  net: string;
  // slippage floor the sellKeys tx is sent with (and what the UI shows as min)
  minPriceWei: string;
  minPrice: string;
  slippageBps: number;
  tokenSymbol: string;
  tokenDecimals: number;
}

export async function quoteSell(
  bunnyId: number,
  amount: bigint,
  wallet: string,
  slippageBps = 300,
): Promise<SellQuote> {
  if (amount <= 0n) throw new Error("amount must be a positive integer");
  const holder = getAddress(wallet);
  const config = await getExchangeConfig();
  const c = { address: EXCHANGE_ADDRESS, abi: EXCHANGE_ABI } as const;
  const [creator, supplyBn, balanceBn] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "bunnyCreator", args: [BigInt(bunnyId)] },
      { ...c, functionName: "totalKeysOfBunny", args: [BigInt(bunnyId)] },
      { ...c, functionName: "balanceOf", args: [BigInt(bunnyId), holder] },
    ],
  });
  if (!creator || (creator as Address).toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`bunny ${bunnyId} does not exist`);
  }
  const supply = supplyBn as bigint;
  const userKeys = balanceBn as bigint;
  if (amount > supply) throw new Error("amount exceeds current supply");
  if (amount > userKeys) throw new Error("you don't hold that many keys");

  // Proceeds = area under the curve removed by selling: getPrice over the
  // [supply-amount, supply] band.
  const gross = (await client.readContract({
    ...c,
    functionName: "getPrice",
    args: [supply - amount, amount],
  })) as bigint;

  const feeBps = BigInt(config.feeBps);
  const bps = BigInt(config.bps || "10000");
  const fee = bps > 0n ? (gross * feeBps) / bps : 0n;
  const net = gross - fee;
  // minPrice = net padded DOWN by slippage, rounded DOWN (floor). Sits below
  // the net-after-fee proceeds, so it stays safe whether the contract compares
  // minPrice against gross or net.
  const slip = BigInt(Math.max(0, Math.floor(slippageBps)));
  const minPrice = net - (net * slip) / 10000n;
  const dec = config.tokenDecimals;

  return {
    bunnyId,
    amount: amount.toString(),
    supply: supply.toString(),
    userKeys: userKeys.toString(),
    grossWei: gross.toString(),
    gross: formatUnits(gross, dec),
    feeWei: fee.toString(),
    fee: formatUnits(fee, dec),
    netWei: net.toString(),
    net: formatUnits(net, dec),
    minPriceWei: minPrice.toString(),
    minPrice: formatUnits(minPrice, dec),
    slippageBps: Number(slip),
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: dec,
  };
}

export interface CurvePoint {
  supply: number;
  priceWei: string;
  // Marginal price (base, pre-fee) to buy ONE key at this supply level.
  price: string;
}

export interface BondingCurve {
  bunnyId: number;
  currentSupply: number;
  maxKeys: number;
  tokenSymbol: string;
  tokenDecimals: number;
  // protocol fee parts, so the client can derive the buy (price+fee) and sell
  // (price-fee) lines from each base point and render the bid/ask spread.
  feeBps: string;
  bps: string;
  points: CurvePoint[];
}

// Sample the bonding curve for a bunny: getPrice(supply, 1) across a spread of
// supply levels so the UI can plot price-vs-supply and mark where the bunny is
// right now. getPrice is `pure`, so every sample lands in a single multicall3
// eth_call regardless of `samples`.
export async function getBondingCurve(
  bunnyId: number,
  samples = 48,
): Promise<BondingCurve> {
  const config = await getExchangeConfig();
  const c = { address: EXCHANGE_ADDRESS, abi: EXCHANGE_ABI } as const;
  const [creator, supplyBn] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "bunnyCreator", args: [BigInt(bunnyId)] },
      { ...c, functionName: "totalKeysOfBunny", args: [BigInt(bunnyId)] },
    ],
  });
  if (!creator || (creator as Address).toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`bunny ${bunnyId} does not exist`);
  }
  const currentSupply = Number(supplyBn as bigint);
  const maxKeys = Number(BigInt(config.maxKeysPerBunny));

  // Plot a WINDOW-wide slice of the curve centered on where the bunny sits
  // today, rather than the full 0..maxKeysPerBunny life. The curve is quadratic
  // (price = scaleFactor*supply^2 + floorPrice): across the whole cap the
  // low-supply region compresses against the floor, and across a tiny window the
  // floor term dominates and it looks flat. A ~100-key window around the current
  // supply keeps local detail near the action while still showing real
  // curvature. getPrice is `pure`, so the whole window lands in one multicall3
  // eth_call. The window is clamped to [0, cap] (or an open-ended cap when
  // maxKeys==0) and slides so it never runs off either end.
  const WINDOW = 100;
  const cap = maxKeys > 0 ? maxKeys : currentSupply + WINDOW;
  const span = Math.min(WINDOW, cap);
  let lower = Math.max(0, currentSupply - Math.floor(span / 2));
  lower = Math.min(lower, Math.max(0, cap - span));
  const upper = Math.min(cap, lower + span);

  // Build a deduped, sorted set of integer supply levels to sample, always
  // including the window bounds and the current supply so the marker lands
  // exactly on a point.
  const steps = Math.max(2, Math.min(samples, upper - lower + 1));
  const set = new Set<number>([lower, currentSupply, upper]);
  for (let i = 0; i < steps; i++) {
    set.add(lower + Math.round(((upper - lower) * i) / (steps - 1)));
  }
  const levels = Array.from(set)
    .filter((s) => s >= lower && s <= upper)
    .sort((a, b) => a - b);

  const priceRes = await client.multicall({
    allowFailure: true,
    contracts: levels.map((s) => ({
      ...c,
      functionName: "getPrice" as const,
      args: [BigInt(s), 1n],
    })),
  });

  const dec = config.tokenDecimals;
  const points: CurvePoint[] = [];
  for (let i = 0; i < levels.length; i++) {
    const r = priceRes[i];
    if (!r || r.status !== "success") continue;
    const wei = r.result as bigint;
    points.push({
      supply: levels[i]!,
      priceWei: wei.toString(),
      price: formatUnits(wei, dec),
    });
  }

  return {
    bunnyId,
    currentSupply,
    maxKeys,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: dec,
    feeBps: config.feeBps,
    bps: config.bps || "10000",
    points,
  };
}

export interface Call {
  to: Address;
  value: string;
  data: string;
}

// Whether `address` has contract bytecode on Base. A Coinbase Smart Wallet is
// counterfactual (no code) until its first outbound transaction deploys it;
// once deployed it returns bytecode here. EOAs never have code, so this is only
// meaningful for the smart-wallet activation flow (callers pair it with the
// knowledge that the connected account is a smart wallet). Never throws "not a
// contract" — absent/`0x` code simply means not deployed.
export async function isWalletDeployed(address: Address): Promise<boolean> {
  const code = await client.getCode({ address: getAddress(address) });
  return typeof code === "string" && code.length > 2 && code !== "0x";
}

// Build a single 0-value self-call (wallet -> its own address, empty data).
// For a counterfactual Coinbase Smart Wallet this first outbound userOp carries
// the account's initCode and deploys it on-chain; afterwards the wallet signs
// plain ERC-1271 signatures bunnyOS can verify. No value or token is moved — it
// only costs gas. The wallet must already hold a little ETH on Base to pay it.
export function buildActivateCalls(wallet: Address): Call[] {
  return [{ to: getAddress(wallet), value: "0x0", data: "0x" }];
}

// Build the ordered call batch to buy keys: ERC20 approve(OS -> exchange,
// maxPrice) FIRST, then buyKeys(bunnyId, amount, maxPrice). Order matters —
// the approval must precede the buy or the transfer reverts.
export async function buildBuyCalls(
  bunnyId: number,
  amount: bigint,
  maxPrice: bigint,
): Promise<Call[]> {
  const config = await getExchangeConfig();
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [EXCHANGE_ADDRESS, maxPrice],
  });
  const buyData = encodeFunctionData({
    abi: EXCHANGE_ABI,
    functionName: "buyKeys",
    args: [BigInt(bunnyId), amount, maxPrice],
  });
  return [
    { to: config.paymentToken, value: "0x0", data: approveData },
    { to: EXCHANGE_ADDRESS, value: "0x0", data: buyData },
  ];
}

// Build the call to sell keys: a single sellKeys(bunnyId, amount, minPrice).
// No ERC20 approve is needed — the seller surrenders keys (tracked internally
// by the exchange) and receives the payment token, so there's nothing to
// pre-authorize.
export async function buildSellCalls(
  bunnyId: number,
  amount: bigint,
  minPrice: bigint,
): Promise<Call[]> {
  const sellData = encodeFunctionData({
    abi: EXCHANGE_ABI,
    functionName: "sellKeys",
    args: [BigInt(bunnyId), amount, minPrice],
  });
  return [{ to: EXCHANGE_ADDRESS, value: "0x0", data: sellData }];
}

// ---- create ---------------------------------------------------------------
// Creating a bunny mints a fresh bonding curve owned by the caller. The
// contract charges a flat `registrationFee` (sent to the protocol wallet) and
// grants a free, unsellable genesis key (supply starts at 1). An optional
// `additionalBuyAmount` buys extra keys on top of the genesis at launch,
// priced from supply 1 via getPrice(1, amount) plus the protocol fee. The
// registration fee carries no slippage; only the optional buy portion does.

export interface CreateQuote {
  additionalBuyAmount: string;
  // flat anti-spam fee, no slippage
  registrationFeeWei: string;
  registrationFee: string;
  // optional initial-keys purchase (base curve price)
  buyPriceWei: string;
  buyPrice: string;
  buyFeeWei: string;
  buyFee: string;
  // base + fee for the initial keys (the figure the contract caps with maxPrice)
  buyTotalWei: string;
  buyTotal: string;
  // slippage-padded cap the createBunny call is sent with (0 when no extra buy)
  maxPriceWei: string;
  maxPrice: string;
  // registrationFee + buyTotal — what the creator actually pays
  grandTotalWei: string;
  grandTotal: string;
  // registrationFee + maxPrice — what the single ERC20 approve must cover
  approveWei: string;
  slippageBps: number;
  // true when 1 + additionalBuyAmount exceeds the per-bunny cap
  soldOut: boolean;
  tokenSymbol: string;
  tokenDecimals: number;
}

// Quote the cost to create a bunny with an optional `additionalBuyAmount` of
// initial keys (0 = registration only). Returns the slippage-padded `maxPrice`
// the createBunny call should carry and the total amount to approve.
export async function quoteCreate(
  additionalBuyAmount: bigint,
  slippageBps = 300,
): Promise<CreateQuote> {
  if (additionalBuyAmount < 0n) {
    throw new Error("additionalBuyAmount must be a non-negative integer");
  }
  const config = await getExchangeConfig();
  const dec = config.tokenDecimals;
  const registrationFee = BigInt(config.registrationFeeWei);
  const feeBps = BigInt(config.feeBps);
  const bps = BigInt(config.bps || "10000");
  const maxKeys = BigInt(config.maxKeysPerBunny);

  let buyPrice = 0n;
  let buyFee = 0n;
  let buyTotal = 0n;
  let maxPrice = 0n;
  let soldOut = false;

  if (additionalBuyAmount > 0n) {
    // The genesis key occupies supply slot 1, so the per-bunny cap is checked
    // against 1 + additionalBuyAmount (mirrors the contract's SoldOut guard).
    soldOut = maxKeys > 0n && 1n + additionalBuyAmount > maxKeys;
    if (!soldOut) {
      buyPrice = (await client.readContract({
        address: EXCHANGE_ADDRESS,
        abi: EXCHANGE_ABI,
        functionName: "getPrice",
        args: [1n, additionalBuyAmount],
      })) as bigint;
      buyFee = bps > 0n ? (buyPrice * feeBps) / bps : 0n;
      buyTotal = buyPrice + buyFee;
      // Pad the buy portion up by slippage, rounded UP. The contract compares
      // maxPrice against (price + fee) of the buy only — registrationFee is not
      // included in that comparison.
      const slip = BigInt(Math.max(0, Math.floor(slippageBps)));
      maxPrice = buyTotal + (buyTotal * slip + 9999n) / 10000n;
    }
  }

  const grandTotal = registrationFee + buyTotal;
  // The exchange pulls BOTH the registrationFee and the buy via transferFrom,
  // so the single approve must cover registrationFee + the padded buy cap.
  const approve = registrationFee + maxPrice;

  return {
    additionalBuyAmount: additionalBuyAmount.toString(),
    registrationFeeWei: registrationFee.toString(),
    registrationFee: formatUnits(registrationFee, dec),
    buyPriceWei: buyPrice.toString(),
    buyPrice: formatUnits(buyPrice, dec),
    buyFeeWei: buyFee.toString(),
    buyFee: formatUnits(buyFee, dec),
    buyTotalWei: buyTotal.toString(),
    buyTotal: formatUnits(buyTotal, dec),
    maxPriceWei: maxPrice.toString(),
    maxPrice: formatUnits(maxPrice, dec),
    grandTotalWei: grandTotal.toString(),
    grandTotal: formatUnits(grandTotal, dec),
    approveWei: approve.toString(),
    slippageBps: Number(BigInt(Math.max(0, Math.floor(slippageBps)))),
    soldOut,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: dec,
  };
}

// Build the ordered call batch to create a bunny: ERC20 approve(OS -> exchange,
// approveAmount) FIRST, then createBunny(additionalBuyAmount, maxPrice). The
// approve always runs because the contract pulls the registrationFee via
// transferFrom even when no extra keys are bought.
export async function buildCreateCalls(
  additionalBuyAmount: bigint,
  maxPrice: bigint,
  approveAmount: bigint,
): Promise<Call[]> {
  const config = await getExchangeConfig();
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [EXCHANGE_ADDRESS, approveAmount],
  });
  const createData = encodeFunctionData({
    abi: EXCHANGE_ABI,
    functionName: "createBunny",
    args: [additionalBuyAmount, maxPrice],
  });
  return [
    { to: config.paymentToken, value: "0x0", data: approveData },
    { to: EXCHANGE_ADDRESS, value: "0x0", data: createData },
  ];
}

// Read the on-chain creator of a bunny. Returns a checksummed address, or null
// when the bunny does not exist (creator is the zero address). Used to authorize
// off-chain profile edits — only the creator may write a bunny's profile.
export async function getBunnyCreator(bunnyId: number): Promise<string | null> {
  const creator = (await client.readContract({
    address: EXCHANGE_ADDRESS,
    abi: EXCHANGE_ABI,
    functionName: "bunnyCreator",
    args: [BigInt(bunnyId)],
  })) as Address;
  if (!creator || creator.toLowerCase() === ZERO_ADDRESS) return null;
  return getAddress(creator);
}

// How many keys `account` holds for a given bunny. Returns 0n for a null/empty
// wallet so callers can treat "not signed in" as "not a key holder" without a
// branch. Used to gate visibility of a bunny's action push history.
export async function getKeyBalance(
  bunnyId: number,
  account: string | null | undefined,
): Promise<bigint> {
  if (!account) return 0n;
  let holder: Address;
  try {
    holder = getAddress(account);
  } catch {
    return 0n;
  }
  const balance = (await client.readContract({
    address: EXCHANGE_ADDRESS,
    abi: EXCHANGE_ABI,
    functionName: "balanceOf",
    args: [BigInt(bunnyId), holder],
  })) as bigint;
  return balance;
}

// Wallet funds relevant to a buy: the payment-token (OS) balance used to pay for
// keys, and the native ETH balance needed for gas on Base. Returns 0n for both
// on a null/invalid wallet so callers can pre-flight a buy without a branch.
export async function getBuyFunds(
  account: string | null | undefined,
): Promise<{ osWei: bigint; ethWei: bigint }> {
  if (!account) return { osWei: 0n, ethWei: 0n };
  let holder: Address;
  try {
    holder = getAddress(account);
  } catch {
    return { osWei: 0n, ethWei: 0n };
  }
  const config = await getExchangeConfig();
  const [osWei, ethWei] = await Promise.all([
    client.readContract({
      address: config.paymentToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [holder],
    }) as Promise<bigint>,
    client.getBalance({ address: holder }),
  ]);
  return { osWei, ethWei };
}
