import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  Globe,
  ImageUp,
  KeyRound,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  Shield,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useT, type TFn } from "@/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { PageHeader } from "@/components/PageHeader";
import defaultBunnyImg from "@assets/bunny-logo.png";

interface ExchangeConfig {
  exchange: string;
  paymentToken: string;
  tokenSymbol: string;
  tokenDecimals: number;
  assetName: string;
  feeBps: string;
  bps: string;
  floorPrice: string;
  registrationFee: string;
  maxKeysPerBunny: string;
}

type BunnyMethodology =
  | "Human"
  | "AI Agent"
  | "Algorithm"
  | "Robot Machine"
  | "Team";

const BUNNY_METHODOLOGIES: BunnyMethodology[] = [
  "Human",
  "AI Agent",
  "Algorithm",
  "Robot Machine",
  "Team",
];

interface BunnyProfile {
  bunnyId: number;
  name: string | null;
  description: string | null;
  photoUrl: string | null;
  website: string | null;
  socials: {
    x: string | null;
    discord: string | null;
    telegram: string | null;
  };
  methodology: BunnyMethodology[];
}

interface BunnyListItem {
  id: number;
  creator: string;
  supply: string;
  buyPriceWei: string;
  buyPrice: string;
  soldOut: boolean;
  userKeys?: string;
  name?: string;
  description?: string;
  profile?: BunnyProfile | null;
}

interface ListResponse {
  config: ExchangeConfig;
  bunnies: BunnyListItem[];
  bunnyos?: { connected: boolean };
  // True when the signed-in wallet is an admin. Admins bypass the holder/creator
  // key lock on gated surfaces (recommendations, threads).
  isAdmin?: boolean;
  // USD price of one OS token (best-effort from CoinGecko). null when market
  // data is unavailable; the UI simply omits the ~USD hints in that case.
  osPriceUsd?: number | null;
}

interface CurvePoint {
  supply: number;
  priceWei: string;
  price: string;
}

interface BondingCurve {
  bunnyId: number;
  currentSupply: number;
  maxKeys: number;
  tokenSymbol: string;
  tokenDecimals: number;
  feeBps: string;
  bps: string;
  points: CurvePoint[];
}

interface BuyQuote {
  bunnyId: number;
  amount: string;
  supply: string;
  price: string;
  fee: string;
  total: string;
  maxPrice: string;
  maxPriceWei: string;
  slippageBps: number;
  soldOut: boolean;
  tokenSymbol: string;
  tokenDecimals: number;
}

interface SellQuote {
  bunnyId: number;
  amount: string;
  supply: string;
  userKeys: string;
  gross: string;
  fee: string;
  net: string;
  minPrice: string;
  minPriceWei: string;
  slippageBps: number;
  tokenSymbol: string;
  tokenDecimals: number;
}

interface TradeResponse {
  approvalUrl: string | null;
  approvalUrls: string[];
  content: string;
}

interface CreateQuote {
  additionalBuyAmount: string;
  registrationFee: string;
  buyPrice: string;
  buyFee: string;
  buyTotal: string;
  maxPrice: string;
  grandTotal: string;
  slippageBps: number;
  soldOut: boolean;
  tokenSymbol: string;
  tokenDecimals: number;
}

interface TradeHistoryItem {
  id: string;
  bunnyId: number;
  side: Side;
  amount: string;
  priceWei: string;
  price: string;
  tokenSymbol: string;
  tokenDecimals: number;
  status: "pending" | "confirmed" | "failed";
  txHash: string | null;
  createdAt: string;
}

type Side = "buy" | "sell";

interface BunnyCandle {
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeKeys: string;
  volumeValue: string;
  tradeCount: number;
}

interface CandlesResponse {
  bunnyId: number;
  interval: string;
  tokenSymbol: string;
  candles: BunnyCandle[];
}

interface BunnyTransaction {
  side: string;
  amount: string;
  pricePerKey: string;
  total: string;
  trader: string;
  timestamp: string;
}

interface TransactionsResponse {
  bunnyId: number;
  tokenSymbol: string;
  nextCursor: string | null;
  hasMore: boolean;
  transactions: BunnyTransaction[];
}

interface OfficialPnl {
  connected: boolean;
  bunnyId?: number;
  tokenSymbol?: string;
  balance?: string;
  costBasis?: string;
  realizedPnl?: string;
  unrealizedPnl?: string;
  totalPnl?: string;
}

const FETCH_OPTS: RequestInit = { credentials: "include" };

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// Normalize a user-entered X/twitter handle into a full profile URL.
function twitterUrl(handle: string): string {
  const h = handle.trim().replace(/^@+/, "");
  if (/^https?:\/\//i.test(handle.trim())) return handle.trim();
  return `https://x.com/${h}`;
}

// X (formerly Twitter) brand glyph. lucide ships no X brand mark — its `X` is
// the close icon — so render the official logo path inline.
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

function externalUrl(url: string): string {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
}

function fmtToken(v: string | number, dp = 2): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return "0";
  // Round down (truncate toward zero) to `dp` places — never show more $OS than
  // the user actually has.
  const factor = 10 ** dp;
  const truncated = Math.trunc(n * factor) / factor;
  if (truncated === 0) return "0";
  return truncated.toLocaleString("en-US", { maximumFractionDigits: dp });
}

// Format a USD amount with sensible precision: sub-cent values keep more
// significant digits (OS is cheap), everything else is plain 2dp currency.
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const digits = abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  });
}

// Inline "~ $X" approximation for an OS amount. Renders nothing when no OS
// price is known (market data unavailable) so callers can drop it in freely.
function UsdHint({
  os,
  price,
  className,
}: {
  os: string | number;
  price?: number | null;
  className?: string;
}): ReactElement | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const amount = typeof os === "number" ? os : Number(os);
  if (!Number.isFinite(amount)) return null;
  return (
    <span className={cn("text-muted-foreground", className)}>
      ~{fmtUsd(amount * price)}
    </span>
  );
}

// ---- wallet approval popup (mirrors ChatPanel's ApprovalLink) -----------

function openApprovalPopup(url: string): void {
  const width = 480;
  const height = 720;
  const left = Math.max(0, (window.screenX ?? 0) + (window.innerWidth - width) / 2);
  const top = Math.max(0, (window.screenY ?? 0) + (window.innerHeight - height) / 2);
  const features = [
    "popup=yes",
    `width=${width}`,
    `height=${height}`,
    `left=${Math.round(left)}`,
    `top=${Math.round(top)}`,
    "resizable=yes",
    "scrollbars=yes",
    "noopener",
    "noreferrer",
  ].join(",");
  const win = window.open(url, "bunny-approval", features);
  if (!win) window.open(url, "_blank", "noopener,noreferrer");
}

function extractRequestId(url: string): string | null {
  const m = url.match(
    /\/(?:wallet-requests|wallet-request|requests|request|calls|approve)\/([a-zA-Z0-9_-]+)/,
  );
  return m?.[1] ?? null;
}

function classifyStatus(content: string): "pending" | "confirmed" | "failed" {
  const lower = content.toLowerCase();
  if (
    /"status"\s*:\s*"(?:failed|reverted|rejected|cancell?ed|expired|denied)"/i.test(content) ||
    /\b(?:reverted|rejected|cancelled|canceled|expired|denied|user[_ ]rejected)\b/i.test(lower)
  ) {
    return "failed";
  }
  if (
    /"status"\s*:\s*"(?:confirmed|success|completed|complete|submitted|broadcast|broadcasted|approved|done|executed|mined|included)"/i.test(content) ||
    /"(?:transactionhash|txhash|tx_hash|transaction_hash|hash|userophash|userop_hash)"\s*:\s*"0x[0-9a-f]{16,}"/i.test(content) ||
    /\b(?:transaction\s+(?:confirmed|submitted|broadcast|broadcasted|sent|executed|mined|included)|approved\s+by\s+user|user\s+approved|successfully\s+(?:submitted|broadcast|sent|executed))\b/i.test(lower)
  ) {
    return "confirmed";
  }
  return "pending";
}

function extractTxHash(content: string): string | null {
  const m = content.match(
    /"(?:transactionHash|txHash|tx_hash|transaction_hash|userOpHash|userop_hash|hash)"\s*:\s*"(0x[0-9a-fA-F]{16,})"/,
  );
  return m?.[1] ?? null;
}

type DoneState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirmed"; txHash: string | null }
  | { kind: "pending" }
  | { kind: "failed"; reason: string }
  | { kind: "unknown" };

function ApprovalRow({
  url,
  onConfirmed,
  t,
}: {
  url: string;
  onConfirmed: () => void;
  t: TFn;
}) {
  const requestId = extractRequestId(url);
  const [state, setState] = useState<DoneState>({ kind: "idle" });

  const markDone = async () => {
    if (!requestId) {
      setState({ kind: "unknown" });
      return;
    }
    setState({ kind: "checking" });
    try {
      const r = await fetch("/api/base-mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...FETCH_OPTS,
        body: JSON.stringify({ name: "get_request_status", args: { requestId } }),
      });
      if (!r.ok) {
        setState({ kind: "unknown" });
        return;
      }
      const j = (await r.json()) as { content?: string };
      const raw = j.content ?? "";
      const cls = classifyStatus(raw);
      if (cls === "confirmed") setState({ kind: "confirmed", txHash: extractTxHash(raw) });
      else if (cls === "failed") {
        const m = raw.match(/"(?:error|message|reason)"\s*:\s*"([^"]{1,160})"/i);
        setState({ kind: "failed", reason: m?.[1] ?? t("bunny.failed") });
      } else setState({ kind: "pending" });
      // Refresh the history list once the wallet request resolves; the bunnyOS
      // transactions feed surfaces the new trade once it's indexed on-chain.
      if (cls !== "pending") onConfirmed();
    } catch {
      setState({ kind: "unknown" });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 space-y-1.5"
    >
      <button
        type="button"
        onClick={() => openApprovalPopup(url)}
        className="block w-full px-3 py-2.5 bg-accent text-accent-foreground rounded-md text-xs font-sans font-medium hover:bg-accent/90 transition-colors text-center"
      >
        {t("bunny.approveCta")}
      </button>
      <div className="flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-widest">
        {state.kind === "idle" && (
          <button
            type="button"
            onClick={markDone}
            className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
          >
            {t("bunny.checkDone")}
          </button>
        )}
        {state.kind === "checking" && (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">{t("bunny.checking")}</span>
          </>
        )}
        {state.kind === "confirmed" && (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-green" />
              <span className="text-green">{t("bunny.confirmed")}</span>
            </div>
            {state.txHash && (
              <a
                href={`https://basescan.org/tx/${state.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline normal-case tracking-normal"
              >
                {t("bunny.viewOnBasescan")}
              </a>
            )}
          </div>
        )}
        {state.kind === "pending" && (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">{t("bunny.stillPending")}</span>
            </div>
            <button
              type="button"
              onClick={markDone}
              className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 normal-case tracking-normal"
            >
              {t("bunny.checkAgain")}
            </button>
          </div>
        )}
        {state.kind === "failed" && (
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
            <span className="text-destructive">{state.reason || t("bunny.failed")}</span>
          </div>
        )}
        {state.kind === "unknown" && (
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-green" />
            <span className="text-green">{t("bunny.markedDone")}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ---- bonding curve chart (animated SVG) ---------------------------------

const W = 720;
const H = 300;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 18;
const PAD_B = 26;

// Linear interpolation of the sampled curve at an arbitrary supply level.
function priceAtSupply(points: CurvePoint[], supply: number): number {
  if (points.length === 0) return 0;
  if (supply <= points[0]!.supply) return Number(points[0]!.price);
  const last = points[points.length - 1]!;
  if (supply >= last.supply) return Number(last.price);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (supply <= b.supply) {
      const span = b.supply - a.supply || 1;
      const ratio = (supply - a.supply) / span;
      return Number(a.price) + (Number(b.price) - Number(a.price)) * ratio;
    }
  }
  return Number(last.price);
}

function BondingCurveChart({
  curve,
  highlightSupply,
  side,
  t,
}: {
  curve: BondingCurve;
  highlightSupply: number | null;
  side: Side;
  t: TFn;
}) {
  const pts = curve.points;
  const feeFrac = useMemo(() => {
    const bps = Number(curve.bps) || 10000;
    const fee = Number(curve.feeBps) || 0;
    return bps > 0 ? fee / bps : 0;
  }, [curve.feeBps, curve.bps]);

  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const supplies = pts.map((p) => p.supply);
    const prices = pts.map((p) => Number(p.price));
    const minS = Math.min(...supplies);
    const maxS = Math.max(...supplies);
    // Buy line sits above the mid curve, so scale to the buy peak.
    const maxP = Math.max(...prices, 0) * (1 + feeFrac);
    const spanS = maxS - minS || 1;
    // Keep a little headroom above the peak so the line never hugs the top.
    const spanP = maxP * 1.08 || 1;
    const x = (s: number) => PAD_L + ((s - minS) / spanS) * (W - PAD_L - PAD_R);
    const y = (p: number) => H - PAD_B - (p / spanP) * (H - PAD_T - PAD_B);
    return { x, y, minS, maxS, maxP };
  }, [pts, feeFrac]);

  if (!geom) {
    return (
      <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  const { x, y, minS, maxS, maxP } = geom;
  const buyPath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.supply).toFixed(2)} ${y(Number(p.price) * (1 + feeFrac)).toFixed(2)}`)
    .join(" ");
  const sellPath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.supply).toFixed(2)} ${y(Number(p.price) * (1 - feeFrac)).toFixed(2)}`)
    .join(" ");
  // Spread band: buy line forward, sell line back.
  const spread =
    pts.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.supply).toFixed(2)} ${y(Number(p.price) * (1 + feeFrac)).toFixed(2)}`).join(" ") +
    " " +
    [...pts].reverse().map((p) => `L ${x(p.supply).toFixed(2)} ${y(Number(p.price) * (1 - feeFrac)).toFixed(2)}`).join(" ") +
    " Z";

  const nowMid = priceAtSupply(pts, curve.currentSupply);
  const nowX = x(curve.currentSupply);
  const nowY = y(nowMid * (side === "buy" ? 1 + feeFrac : 1 - feeFrac));
  const markColor = side === "buy" ? "hsl(var(--accent))" : "hsl(var(--green))";
  const hl =
    highlightSupply !== null && highlightSupply !== curve.currentSupply
      ? {
          x: x(highlightSupply),
          y: y(priceAtSupply(pts, highlightSupply) * (side === "buy" ? 1 + feeFrac : 1 - feeFrac)),
        }
      : null;

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("bunny.curveTitle")}
      >
        <defs>
          <linearGradient id="bunnySpreadFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity="0.22" />
            <stop offset="100%" stopColor="hsl(var(--green))" stopOpacity="0.1" />
          </linearGradient>
        </defs>

        {/* horizontal gridlines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={H - PAD_B - f * (H - PAD_T - PAD_B)}
            y2={H - PAD_B - f * (H - PAD_T - PAD_B)}
            stroke="hsl(var(--border))"
            strokeWidth={1}
            strokeDasharray="2 6"
            opacity={0.6}
          />
        ))}

        {/* spread band between buy and sell */}
        <motion.path
          d={spread}
          fill="url(#bunnySpreadFill)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.5 }}
        />

        {/* sell (bid) line */}
        <motion.path
          d={sellPath}
          fill="none"
          stroke="hsl(var(--green))"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={side === "sell" ? 1 : 0.55}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: "easeInOut" }}
        />

        {/* buy (ask) line */}
        <motion.path
          d={buyPath}
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={side === "buy" ? 1 : 0.55}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: "easeInOut" }}
        />

        {/* current-supply marker on the active line */}
        <motion.line
          x1={nowX}
          x2={nowX}
          y1={PAD_T}
          y2={H - PAD_B}
          stroke="hsl(var(--foreground))"
          strokeWidth={1}
          strokeDasharray="3 4"
          opacity={0.4}
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.4 }}
          transition={{ delay: 1 }}
        />
        <motion.circle
          cx={nowX}
          cy={nowY}
          r={6}
          fill={markColor}
          stroke="hsl(var(--background))"
          strokeWidth={2}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 1, type: "spring", stiffness: 300, damping: 14 }}
        />
        <motion.circle
          cx={nowX}
          cy={nowY}
          r={6}
          fill="none"
          stroke={markColor}
          strokeWidth={2}
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 2.6 }}
          transition={{ delay: 1, duration: 1.6, repeat: Infinity, repeatDelay: 0.4 }}
        />

        {/* target marker (after the trade) */}
        {hl && (
          <>
            <motion.line
              x1={hl.x}
              x2={hl.x}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke={markColor}
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={0.5}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
            />
            <motion.circle
              cx={hl.x}
              cy={hl.y}
              r={5}
              fill={markColor}
              stroke="hsl(var(--background))"
              strokeWidth={2}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 14 }}
            />
          </>
        )}
      </svg>

      {/* legend */}
      <div className="flex items-center gap-4 font-mono text-[10px] text-muted-foreground mt-1 px-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-3 rounded" style={{ background: "hsl(var(--accent))" }} />
          {t("bunny.legendBuy")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-3 rounded" style={{ background: "hsl(var(--green))" }} />
          {t("bunny.legendSell")}
        </span>
        <span className="ml-auto">
          {t("bunny.curveAxisSupply")} {minS}–{maxS} · ≤ {fmtToken(maxP)} {curve.tokenSymbol}
        </span>
      </div>
    </div>
  );
}

// ---- real price history (candles) ---------------------------------------

function PriceHistoryChart({
  candles,
  tokenSymbol,
  t,
}: {
  candles: BunnyCandle[];
  tokenSymbol: string;
  t: TFn;
}) {
  const geom = useMemo(() => {
    if (candles.length < 2) return null;
    const times = candles.map((c) => new Date(c.bucketStart).getTime());
    const closes = candles.map((c) => Number(c.close));
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const minP = Math.min(...closes);
    const maxP = Math.max(...closes);
    const spanT = maxT - minT || 1;
    const padP = (maxP - minP) * 0.08 || maxP * 0.08 || 1;
    const lo = minP - padP;
    const hi = maxP + padP;
    const x = (ti: number) => PAD_L + ((ti - minT) / spanT) * (W - PAD_L - PAD_R);
    const y = (p: number) =>
      H - PAD_B - ((p - lo) / (hi - lo || 1)) * (H - PAD_T - PAD_B);
    return { x, y, minP, maxP };
  }, [candles]);

  if (!geom) return null;
  const { x, y, minP, maxP } = geom;
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const up = Number(last.close) >= Number(first.close);
  const stroke = up ? "hsl(var(--green))" : "hsl(var(--accent))";
  const line = candles
    .map(
      (c, i) =>
        `${i === 0 ? "M" : "L"} ${x(new Date(c.bucketStart).getTime()).toFixed(2)} ${y(Number(c.close)).toFixed(2)}`,
    )
    .join(" ");
  const area =
    line +
    ` L ${x(new Date(last.bucketStart).getTime()).toFixed(2)} ${(H - PAD_B).toFixed(2)}` +
    ` L ${x(new Date(first.bucketStart).getTime()).toFixed(2)} ${(H - PAD_B).toFixed(2)} Z`;
  const lastX = x(new Date(last.bucketStart).getTime());
  const lastY = y(Number(last.close));

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("bunny.priceTitle")}
      >
        <defs>
          <linearGradient id="bunnyPriceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={H - PAD_B - f * (H - PAD_T - PAD_B)}
            y2={H - PAD_B - f * (H - PAD_T - PAD_B)}
            stroke="hsl(var(--border))"
            strokeWidth={1}
            strokeDasharray="2 6"
            opacity={0.6}
          />
        ))}

        <motion.path
          d={area}
          fill="url(#bunnyPriceFill)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.4 }}
        />
        <motion.path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: "easeInOut" }}
        />
        <motion.circle
          cx={lastX}
          cy={lastY}
          r={5}
          fill={stroke}
          stroke="hsl(var(--background))"
          strokeWidth={2}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 1, type: "spring", stiffness: 300, damping: 14 }}
        />
      </svg>

      <div className="flex items-center gap-4 font-mono text-[10px] text-muted-foreground mt-1 px-1">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-3 rounded"
            style={{ background: stroke }}
          />
          {t("bunny.priceTitle")}
        </span>
        <span className="ml-auto">
          {fmtToken(minP)}–{fmtToken(maxP)} {tokenSymbol}
        </span>
      </div>
    </div>
  );
}

// ---- trade panel (selected bunny detail) --------------------------------

function TradePanel({
  bunny,
  config,
  t,
  onTraded,
  isAdmin = false,
  mobileActive = false,
  onBack,
  osPriceUsd,
}: {
  bunny: BunnyListItem;
  config: ExchangeConfig;
  t: TFn;
  onTraded: () => void;
  isAdmin?: boolean;
  mobileActive?: boolean;
  onBack?: () => void;
  osPriceUsd?: number | null;
}) {
  const [side, setSide] = useState<Side>("buy");
  const [rightTab, setRightTab] = useState<
    "exchange" | "recommendations" | "threads"
  >("exchange");
  // View-access for the recommendations feed. Seeded from locally-known signals
  // (owning a key, or being able to edit the bunny) so the tab lock hint is
  // correct before the feed is ever opened, then corrected to the authoritative
  // value reported up by ActionPushHistory once the actions response loads.
  const [recsCanView, setRecsCanView] = useState(
    () => isAdmin || Number(bunny.userKeys ?? "0") > 0,
  );
  // View-access for the Threads forum, same gate as recommendations: seeded from
  // local signals (admin / key holder / creator) then corrected to the
  // authoritative value reported up by the forum panel once its first list
  // response loads.
  const [forumCanView, setForumCanView] = useState(
    () => isAdmin || Number(bunny.userKeys ?? "0") > 0,
  );
  // The local seed above only knows on-chain signals (admin / key holder), so a
  // bunnyOS-recognized viewer (e.g. a bunnyOS admin not in the local admin list,
  // or a holder via proxy) would show a LOCK on both tabs until the tab is
  // opened and its content reports access up. Fetch the authoritative capability
  // map once on mount and clear the lock ahead of time. Grant-only: never flip a
  // tab back to locked here (recs additionally honors on-chain keys that this
  // bunnyOS map doesn't see) — the per-tab content remains the source of truth
  // for the locked treatment.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/permissions`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          permissions: ForumPermissions | null;
        };
        if (j.permissions?.recommendation.canView) setRecsCanView(true);
        if (j.permissions?.thread.canView) setForumCanView(true);
      } catch {
        // Keep the local seed on any failure.
      }
    })();
    return () => ctrl.abort();
  }, [bunny.id]);
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  const [curve, setCurve] = useState<BondingCurve | null>(null);
  const [curveErr, setCurveErr] = useState(false);
  const [candles, setCandles] = useState<BunnyCandle[] | null>(null);
  // Bumped after a confirmed trade to re-pull the live curve/supply without a
  // full page refresh (and without wiping the approval row's confirmed state).
  const [curveNonce, setCurveNonce] = useState(0);
  const [buyQuote, setBuyQuote] = useState<BuyQuote | null>(null);
  const [sellQuote, setSellQuote] = useState<SellQuote | null>(null);
  const quoteSeq = useRef(0);

  const userKeys = Number(bunny.userKeys ?? "0");
  const canSell = userKeys > 0;

  // Off-chain profile (name/bio/avatar/socials) + whether the connected wallet
  // is the bunny's on-chain creator (server-computed) and may edit it.
  const [profile, setProfile] = useState<BunnyProfile | null>(
    bunny.profile ?? null,
  );
  const [canEdit, setCanEdit] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    setProfile(bunny.profile ?? null);
    setCanEdit(false);
    setEditOpen(false);
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/profile`, {
          ...FETCH_OPTS,
          // Bypass the browser's ETag/304 cache so a just-saved profile edit
          // (e.g. a freshly uploaded avatar) is always reflected immediately
          // instead of revalidating to a stale cached body.
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          profile: BunnyProfile | null;
          canEdit: boolean;
        };
        setProfile(j.profile);
        setCanEdit(j.canEdit);
      } catch {
        // best-effort; the list's embedded profile (if any) still renders
      }
    })();
    return () => ctrl.abort();
  }, [bunny.id, bunny.profile]);

  // Reset transient trade-form state when the selected bunny changes.
  useEffect(() => {
    setApprovalUrl(null);
    setSubmitted(false);
    setError(null);
    setAmount(1);
    setSide("buy");
    setBuyQuote(null);
    setSellQuote(null);
  }, [bunny.id]);

  // Load the bonding curve + candles when the selected bunny changes, and again
  // after a confirmed trade (curveNonce) so supply/price update without a reload.
  useEffect(() => {
    let cancelled = false;
    setCurve(null);
    setCurveErr(false);
    setCandles(null);
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/curve`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (!r.ok) {
          if (!cancelled) setCurveErr(true);
          return;
        }
        const j = (await r.json()) as BondingCurve;
        if (!cancelled) setCurve(j);
      } catch {
        if (!cancelled && !ctrl.signal.aborted) setCurveErr(true);
      }
    })();
    // Real per-key price history. Best-effort: a failure just falls back to the
    // bonding curve, so an empty/errored candle response is treated as "none".
    (async () => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/candles?interval=1h&limit=168`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (!r.ok) {
          if (!cancelled) setCandles([]);
          return;
        }
        const j = (await r.json()) as CandlesResponse;
        if (!cancelled) setCandles(j.candles ?? []);
      } catch {
        if (!cancelled && !ctrl.signal.aborted) setCandles([]);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [bunny.id, curveNonce]);

  // Reset transient submit state when switching sides; clamp sell amount.
  useEffect(() => {
    setError(null);
    setApprovalUrl(null);
    setSubmitted(false);
    if (side === "sell" && canSell) setAmount((a) => Math.min(Math.max(1, a), userKeys));
    if (side === "buy") setAmount((a) => Math.max(1, a));
  }, [side, canSell, userKeys]);

  // Debounced fresh quote for the current amount + side.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const path =
      side === "buy"
        ? `/api/bunny/${bunny.id}/quote?amount=${amount}`
        : `/api/bunny/${bunny.id}/sell-quote?amount=${amount}`;
    if (side === "sell" && !canSell) return;
    const seq = ++quoteSeq.current;
    const handle = setTimeout(async () => {
      try {
        const r = await fetch(path, { ...FETCH_OPTS, signal: ctrl.signal });
        if (!r.ok) return;
        const j = await r.json();
        // Drop out-of-order resolves so a slow earlier request can't clobber
        // the latest side/amount selection.
        if (cancelled || seq !== quoteSeq.current) return;
        if (side === "buy") setBuyQuote(j as BuyQuote);
        else setSellQuote(j as SellQuote);
      } catch {
        /* aborted or transient — ignore */
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [bunny.id, amount, side, canSell]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setApprovalUrl(null);
    setSubmitted(false);
    const endpoint = side === "buy" ? "buy" : "sell";
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...FETCH_OPTS,
        body: JSON.stringify({ amount: String(amount) }),
      });
      if (r.status === 429) {
        setError(t("bunny.rateLimit"));
        return;
      }
      const j = (await r.json()) as Partial<TradeResponse> & { error?: string };
      if (!r.ok) {
        setError(j.error ?? t(side === "buy" ? "bunny.buyError" : "bunny.sellError"));
        return;
      }
      if (j.approvalUrl) setApprovalUrl(j.approvalUrl);
      else setSubmitted(true);
      // Refresh the history feed; the new trade appears once bunnyOS indexes it.
      setHistoryKey((k) => k + 1);
      onTraded();
    } catch {
      setError(t(side === "buy" ? "bunny.buyError" : "bunny.sellError"));
    } finally {
      setBusy(false);
    }
  };

  const targetSupply = curve
    ? side === "buy"
      ? curve.currentSupply + amount
      : curve.currentSupply - amount
    : null;
  const total = buyQuote ? buyQuote.total : null;
  const net = sellQuote ? sellQuote.net : null;
  const feePct = curve
    ? ((Number(curve.feeBps) || 0) / (Number(curve.bps) || 10000)) * 100
    : 0;
  // Estimate realizable proceeds for the whole position. Selling N keys walks
  // the curve DOWN, so marginal-price × N overstates it — use the trapezoidal
  // area between the price at the current supply and the price after the sell.
  const positionValue = (() => {
    if (!canSell || !curve) return 0;
    const n = Math.min(userKeys, curve.currentSupply);
    const pNow = priceAtSupply(curve.points, curve.currentSupply);
    const pAfter = priceAtSupply(curve.points, curve.currentSupply - n);
    return ((pNow + pAfter) / 2) * n * (1 - feePct / 100);
  })();

  const sellDisabled = side === "sell" && (!canSell || busy);
  const buyDisabled = side === "buy" && (bunny.soldOut || busy);

  return (
    <div
      className={cn(
        "min-h-0 flex-col lg:flex lg:min-w-0 lg:flex-[2] lg:overflow-hidden",
        mobileActive ? "flex" : "hidden",
      )}
    >
      {/* ---- tab switcher for the right side ---- */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex items-center text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          aria-label={t("bunny.back")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setRightTab("exchange")}
          className={cn(
            "font-mono text-[11px] px-3 py-1 rounded border transition-colors",
            rightTab === "exchange"
              ? "bg-foreground/10 border-foreground/30 text-foreground"
              : "bg-transparent border-border/40 text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {t("bunny.tabExchange")}
        </button>
        <button
          type="button"
          onClick={() => setRightTab("recommendations")}
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[11px] px-3 py-1 rounded border transition-colors",
            rightTab === "recommendations"
              ? "bg-foreground/10 border-foreground/30 text-foreground"
              : "bg-transparent border-border/40 text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {!recsCanView && <Lock className="h-3 w-3" />}
          {t("bunny.tabRecommendations")}
        </button>
        <button
          type="button"
          onClick={() => setRightTab("threads")}
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[11px] px-3 py-1 rounded border transition-colors",
            rightTab === "threads"
              ? "bg-foreground/10 border-foreground/30 text-foreground"
              : "bg-transparent border-border/40 text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {!forumCanView && <Lock className="h-3 w-3" />}
          {t("bunny.tabThreads")}
        </button>
      </div>

      {rightTab === "recommendations" ? (
        <div className="min-h-0 lg:flex-1 lg:overflow-y-auto">
          <ActionPushHistory
            bunny={bunny}
            t={t}
            onNotConnected={onTraded}
            onAccessChange={setRecsCanView}
          />
        </div>
      ) : rightTab === "threads" ? (
        <div className="min-h-0 lg:flex-1 lg:overflow-y-auto">
          <BunnyForum bunny={bunny} t={t} onAccessChange={setForumCanView} />
        </div>
      ) : (
        <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row lg:overflow-hidden">
      {/* ---- column 2: bunny information ---- */}
      <div className="flex shrink-0 flex-col border-b border-border/50 lg:flex-1 lg:min-w-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="flex h-9 shrink-0 items-center border-b border-border/50 px-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.colDetails")}
        </div>
        <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <img
              src={profile?.photoUrl ?? defaultBunnyImg}
              alt=""
              className="h-20 w-20 shrink-0 rounded-lg border border-border bg-background object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-xl font-semibold truncate">
                  {profile?.name ||
                    bunny.name ||
                    t("bunny.bunnyId", { id: String(bunny.id) })}
                </h2>
                {(profile?.name || bunny.name) && (
                  <span className="font-mono text-xs text-muted-foreground shrink-0">
                    #{bunny.id}
                  </span>
                )}
              </div>
              <a
                href={`https://basescan.org/address/${bunny.creator}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-block font-mono text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline break-all"
              >
                {t("bunny.colCreator")}: {shortAddr(bunny.creator)}
              </a>
              {profile?.methodology && profile.methodology.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {profile.methodology.map((m) => (
                    <span
                      key={m}
                      className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                    >
                      {t(`bunny.methodology.${m}`)}
                    </span>
                  ))}
                </div>
              )}
              {(profile?.socials.x ||
                profile?.socials.discord ||
                profile?.socials.telegram ||
                profile?.website) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  {profile?.socials.x && (
                    <a
                      href={twitterUrl(profile.socials.x)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <XLogo className="h-3 w-3" />
                      {profile.socials.x.replace(/^@+/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")}
                    </a>
                  )}
                  {profile?.socials.discord && (
                    <a
                      href={externalUrl(profile.socials.discord)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <MessageCircle className="h-3 w-3" />
                      {t("bunny.socialDiscord")}
                    </a>
                  )}
                  {profile?.socials.telegram && (
                    <a
                      href={externalUrl(profile.socials.telegram)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <Send className="h-3 w-3" />
                      {t("bunny.socialTelegram")}
                    </a>
                  )}
                  {profile?.website && (
                    <a
                      href={externalUrl(profile.website)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <Globe className="h-3 w-3" />
                      {profile.website.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {bunny.soldOut ? (
              <span className="rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-destructive">
                {t("bunny.soldOut")}
              </span>
            ) : (
              <span className="rounded-full border border-[hsl(var(--green))]/40 bg-[hsl(var(--green))]/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[hsl(var(--green))]">
                {t("bunny.statusActive")}
              </span>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
                {profile ? t("bunny.profileEdit") : t("bunny.profileCreate")}
              </button>
            )}
          </div>
        </div>

        {(profile?.description || bunny.description) && (
          <p className="w-full whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
            {profile?.description || bunny.description}
          </p>
        )}

        {editOpen && (
          <BunnyProfileModal
            bunnyId={bunny.id}
            profile={profile}
            t={t}
            onClose={() => setEditOpen(false)}
            onSaved={(p) => {
              setProfile(p);
              setEditOpen(false);
              onTraded();
            }}
            onNotConnected={() => {
              // bunnyOS JWT expired mid-edit: close and reload so the top-level
              // BunnyOsConnect banner re-appears for the user to reconnect.
              setEditOpen(false);
              onTraded();
            }}
          />
        )}

        {/* headline price */}
        <div className="rounded-md border border-border bg-background/40 px-3 py-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("bunny.statLast")}
          </div>
          <div className="font-mono text-2xl leading-none mt-1.5 truncate">
            {fmtToken(bunny.buyPrice)}{" "}
            <span className="text-sm text-muted-foreground">{config.tokenSymbol}</span>
          </div>
          <UsdHint
            os={bunny.buyPrice}
            price={osPriceUsd}
            className="mt-1 block font-mono text-[11px]"
          />
        </div>

        {/* info rows */}
        <dl className="space-y-2">
          {[
            { label: t("bunny.colSupply"), value: bunny.supply },
            { label: t("bunny.youOwn"), value: String(userKeys) },
            {
              label: t("bunny.positionValue"),
              value: canSell ? `${fmtToken(positionValue)} ${config.tokenSymbol}` : "—",
            },
            {
              label: t("bunny.statFee"),
              value: `${Math.round(feePct * 100) / 100}%`,
            },
          ].map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0"
            >
              <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {row.label}
              </dt>
              <dd className="font-mono text-sm truncate text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
        </div>
      </div>

      {/* ---- column 3: chart + buy / sell ---- */}
      <div className="flex min-h-0 flex-col lg:flex-1 lg:min-w-0 lg:overflow-y-auto">
        <div className="flex h-9 shrink-0 items-center border-b border-border/50 px-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground lg:px-5">
          {t("bunny.colExchange")}
        </div>
        <div className="px-4 py-4 lg:px-5">
        {(() => {
          const showPrice = candles !== null && candles.length >= 2;
          return (
            <>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  {showPrice ? t("bunny.priceTitle") : t("bunny.curveTitle")}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {showPrice ? t("bunny.priceSubtitle") : t("bunny.curveSubtitle")}
                </span>
              </div>

              {curveErr && (
                <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
                  {t("bunny.curveError")}
                </div>
              )}
              {!curveErr && !curve && (
                <div className="h-[180px] flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("bunny.curveLoading")}
                </div>
              )}
              {!curveErr && curve && showPrice && (
                <PriceHistoryChart
                  candles={candles}
                  tokenSymbol={curve.tokenSymbol}
                  t={t}
                />
              )}
              {!curveErr && curve && !showPrice && (
                <BondingCurveChart
                  curve={curve}
                  highlightSupply={targetSupply}
                  side={side}
                  t={t}
                />
              )}
            </>
          );
        })()}

      {/* buy / sell tabs */}
      <div className="mt-4 grid grid-cols-2 gap-1 rounded-md border border-border bg-background/40 p-0.5">
        <button
          type="button"
          onClick={() => setSide("buy")}
          className={cn(
            "h-7 rounded font-mono text-[11px] uppercase tracking-widest transition-colors",
            side === "buy"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("bunny.tabBuy")}
        </button>
        <button
          type="button"
          onClick={() => setSide("sell")}
          disabled={!canSell}
          className={cn(
            "h-7 rounded font-mono text-[11px] uppercase tracking-widest transition-colors",
            side === "sell"
              ? "bg-[hsl(var(--green))] text-background"
              : "text-muted-foreground hover:text-foreground",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          {t("bunny.tabSell")}
        </button>
      </div>

      {/* trade controls */}
      <div className="mt-3 space-y-3">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("bunny.colAmount")}
              </label>
              {side === "sell" && canSell && (
                <button
                  type="button"
                  onClick={() => setAmount(userKeys)}
                  className="font-mono text-[10px] uppercase tracking-widest text-accent hover:underline"
                >
                  {t("bunny.max")}
                </button>
              )}
            </div>
            <input
              type="number"
              min={1}
              step={1}
              max={side === "sell" ? userKeys : undefined}
              value={amount}
              onChange={(e) => {
                let n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                if (side === "sell" && canSell) n = Math.min(n, userKeys);
                setAmount(n);
              }}
              disabled={side === "buy" ? bunny.soldOut || busy : sellDisabled}
              className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              aria-label={t("bunny.colAmount")}
            />
          </div>
          <div className="flex-1 text-right">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {side === "buy" ? t("bunny.curveYouPay") : t("bunny.youReceive")}
            </div>
            <div className="font-mono text-lg leading-tight mt-1 min-h-[1.75rem]">
              <AnimatePresence mode="popLayout">
                <motion.span
                  key={`${side}-${(side === "buy" ? total : net) ?? "…"}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className="inline-block"
                >
                  {side === "buy"
                    ? total
                      ? `${fmtToken(total)} ${config.tokenSymbol}`
                      : "…"
                    : net
                      ? `${fmtToken(net)} ${config.tokenSymbol}`
                      : "…"}
                </motion.span>
              </AnimatePresence>
            </div>
            {(side === "buy" ? total : net) != null && (
              <UsdHint
                os={(side === "buy" ? total : net) as string | number}
                price={osPriceUsd}
                className="block font-mono text-[10px]"
              />
            )}
            {side === "buy" && buyQuote && Number(buyQuote.fee) > 0 && (
              <div className="font-mono text-[10px] text-muted-foreground">
                +{fmtToken(buyQuote.fee)} {config.tokenSymbol} {t("bunny.statFee")}
              </div>
            )}
            {side === "sell" && sellQuote && Number(sellQuote.fee) > 0 && (
              <div className="font-mono text-[10px] text-muted-foreground">
                −{fmtToken(sellQuote.fee)} {config.tokenSymbol} {t("bunny.statFee")}
              </div>
            )}
          </div>
        </div>

        {side === "sell" && !canSell && (
          <div className="font-mono text-[11px] text-muted-foreground">{t("bunny.noKeys")}</div>
        )}
        {side === "sell" && canSell && (
          <div className="font-mono text-[10px] text-muted-foreground">
            {t("bunny.sellFeeNote", { amount: String(amount), fee: fmtToken(feePct, 2) })}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={side === "buy" ? buyDisabled : sellDisabled}
          className={cn(
            "w-full h-9 rounded-md text-xs font-medium uppercase tracking-widest transition-colors",
            side === "buy"
              ? "bg-accent text-accent-foreground hover:bg-accent/90"
              : "bg-[hsl(var(--green))] text-background hover:opacity-90",
            "disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2",
          )}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {side === "buy"
            ? bunny.soldOut
              ? t("bunny.soldOut")
              : busy
                ? t("bunny.buying")
                : t("bunny.buy")
            : busy
              ? t("bunny.selling")
              : t("bunny.sell")}
        </button>

        {error && <div className="font-mono text-[11px] text-destructive">{error}</div>}
        {submitted && !approvalUrl && (
          <div className="font-mono text-[11px] text-muted-foreground">
            {t("bunny.noApprovalUrl")}
          </div>
        )}
        {approvalUrl && (
          <ApprovalRow
            url={approvalUrl}
            onConfirmed={() => {
              setHistoryKey((k) => k + 1);
              setCurveNonce((n) => n + 1);
              onTraded();
            }}
            t={t}
          />
        )}

        <TradeHistory bunny={bunny} refreshKey={historyKey} t={t} />

        <RecentTrades bunny={bunny} t={t} />
      </div>
      </div>
      </div>
        </div>
      )}
    </div>
  );
}

// ---- trade history ------------------------------------------------------
// The caller's own buy/sell history for this bunny, sourced live from the
// bunnyOS transactions feed filtered to the connected wallet (confirmed fills).

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TradeHistory({
  bunny,
  refreshKey,
  t,
}: {
  bunny: BunnyListItem;
  refreshKey: number;
  t: TFn;
}) {
  const [trades, setTrades] = useState<TradeHistoryItem[] | null>(null);
  const [err, setErr] = useState(false);
  const [official, setOfficial] = useState<OfficialPnl | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`/api/bunny/trades?bunnyId=${bunny.id}`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (!r.ok) {
          if (!cancelled) setErr(true);
          return;
        }
        const j = (await r.json()) as { trades: TradeHistoryItem[] };
        if (!cancelled) {
          setTrades(j.trades);
          setErr(false);
        }
      } catch {
        if (!cancelled && !ctrl.signal.aborted) setErr(true);
      }
    })();
    // Official per-bunny PnL from the bunnyOS ledger. { connected: false } when
    // the user hasn't connected bunnyOS — then the feed-derived numbers stand.
    (async () => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/pnl`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (!r.ok) {
          if (!cancelled) setOfficial(null);
          return;
        }
        const j = (await r.json()) as OfficialPnl;
        if (!cancelled) setOfficial(j);
      } catch {
        if (!cancelled && !ctrl.signal.aborted) setOfficial(null);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [bunny.id, refreshKey]);

  // Only the official bunnyOS ledger PnL is shown — total/realized/unrealized
  // straight from GET /api/bunny/:id/pnl. Null (panel hidden) until the user has
  // connected bunnyOS and the ledger reports numbers.
  const officialConnected = !!official?.connected && official.totalPnl !== undefined;
  const pnlView = officialConnected
    ? {
        symbol: official?.tokenSymbol ?? "",
        total: Number(official?.totalPnl),
        realized: Number(official?.realizedPnl),
        unrealized: Number(official?.unrealizedPnl),
      }
    : null;

  const pnlClass = (n: number) =>
    n > 0
      ? "text-[hsl(var(--green))]"
      : n < 0
        ? "text-destructive"
        : "text-foreground";
  const pnlSign = (n: number) => (n > 0 ? "+" : "");

  return (
    <div className="mt-6 border-t border-border/50 pt-4">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {t("bunny.historyTitle")}
      </div>
      {pnlView && (
        <div className="mb-3 rounded-md border border-border/60 bg-background/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("bunny.pnlTotal")}
              <span className="rounded bg-accent/10 px-1 py-0.5 text-[8px] tracking-widest text-accent">
                {t("bunny.pnlOfficial")}
              </span>
            </span>
            <span className={cn("font-mono text-lg leading-none", pnlClass(pnlView.total))}>
              {pnlSign(pnlView.total)}
              {fmtToken(pnlView.total)} {pnlView.symbol}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                {t("bunny.pnlRealized")}
              </span>
              <span className={cn("font-mono text-[11px]", pnlClass(pnlView.realized))}>
                {pnlSign(pnlView.realized)}
                {fmtToken(pnlView.realized)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                {t("bunny.pnlUnrealized")}
              </span>
              <span className={cn("font-mono text-[11px]", pnlClass(pnlView.unrealized))}>
                {pnlSign(pnlView.unrealized)}
                {fmtToken(pnlView.unrealized)}
              </span>
            </div>
          </div>
        </div>
      )}
      {!err && trades === null && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("bunny.historyLoading")}
        </div>
      )}
      {!err && trades !== null && trades.length === 0 && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {t("bunny.historyEmpty")}
        </div>
      )}
      {!err && trades !== null && trades.length > 0 && (
        <div className="space-y-1.5">
          {trades.map((tr) => {
            const keys = Number(tr.amount) || 0;
            const totalNum = Number(tr.price);
            const perKey = keys > 0 ? totalNum / keys : totalNum;
            const isBuy = tr.side === "buy";
            return (
              <div
                key={tr.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest",
                      isBuy
                        ? "bg-accent/10 text-accent"
                        : "bg-[hsl(var(--green))]/10 text-[hsl(var(--green))]",
                    )}
                  >
                    {isBuy ? t("bunny.tabBuy") : t("bunny.tabSell")}
                  </span>
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] truncate">
                      {t("bunny.historyKeys", { count: String(keys) })}
                      <span className="text-muted-foreground">
                        {" · "}
                        {fmtToken(perKey)} {tr.tokenSymbol}/{t("bunny.historyPerKey")}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {fmtTime(tr.createdAt)}
                      {tr.status === "pending" && ` · ${t("bunny.historyPending")}`}
                      {tr.status === "failed" && (
                        <span className="text-destructive">
                          {" · "}
                          {t("bunny.failed")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "font-mono text-[11px]",
                      tr.status === "failed" && "text-muted-foreground line-through",
                    )}
                  >
                    {isBuy ? "−" : "+"}
                    {fmtToken(totalNum)} {tr.tokenSymbol}
                  </div>
                  {tr.txHash ? (
                    <a
                      href={`https://basescan.org/tx/${tr.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[9px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    >
                      {t("bunny.viewOnBasescan")}
                    </a>
                  ) : tr.status === "confirmed" ? (
                    <span className="font-mono text-[9px] text-[hsl(var(--green))]">
                      {t("bunny.confirmed")}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- recent trades tape -------------------------------------------------
// The bunny's global trade tape (all traders), pulled from the bunnyOS API.
// Complementary to the caller's own TradeHistory above; works anonymously.

function RecentTrades({ bunny, t }: { bunny: BunnyListItem; t: TFn }) {
  const [tape, setTape] = useState<BunnyTransaction[] | null>(null);
  const [symbol, setSymbol] = useState("");
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setTape(null);
    setErr(false);
    (async () => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/transactions?limit=20`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (!r.ok) {
          if (!cancelled) setErr(true);
          return;
        }
        const j = (await r.json()) as TransactionsResponse;
        if (!cancelled) {
          setTape(j.transactions ?? []);
          setSymbol(j.tokenSymbol ?? "");
        }
      } catch {
        if (!cancelled && !ctrl.signal.aborted) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [bunny.id]);

  return (
    <div className="mt-6 border-t border-border/50 pt-4">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {t("bunny.recentTitle")}
      </div>
      {err && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {t("bunny.recentError")}
        </div>
      )}
      {!err && tape === null && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("bunny.recentLoading")}
        </div>
      )}
      {!err && tape !== null && tape.length === 0 && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {t("bunny.recentEmpty")}
        </div>
      )}
      {!err && tape !== null && tape.length > 0 && (
        <div className="space-y-1.5">
          {tape.map((tx, i) => {
            const isBuy = tx.side.toLowerCase() === "buy";
            const keys = Number(tx.amount) || 0;
            return (
              <div
                key={`${tx.timestamp}-${tx.trader}-${i}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest",
                      isBuy
                        ? "bg-accent/10 text-accent"
                        : "bg-[hsl(var(--green))]/10 text-[hsl(var(--green))]",
                    )}
                  >
                    {isBuy ? t("bunny.tabBuy") : t("bunny.tabSell")}
                  </span>
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] truncate">
                      {t("bunny.historyKeys", { count: String(keys) })}
                      <span className="text-muted-foreground">
                        {" · "}
                        {fmtToken(tx.pricePerKey)} {symbol}/{t("bunny.historyPerKey")}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {shortAddr(tx.trader)} · {fmtTime(tx.timestamp)}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[11px]">
                    {isBuy ? "−" : "+"}
                    {fmtToken(tx.total)} {symbol}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- bunny actions ------------------------------------------------------
// Owner-authored actions sourced from bunnyOS. Key holders (and the
// creator/admins) can read them; non-holders get the locked treatment. The
// owner/admins can compose new actions and archive/unarchive existing ones —
// bunnyOS is the final authority on both view and manage access.

interface BunnyOsContractCall {
  chainId: number;
  to: string;
  function: string;
  args: unknown[];
  value: string | null;
}

interface BunnyActionItem {
  id: string;
  createdAt: string;
  // Full (viewer) fields, present only when the response is canView=true.
  type?: "body" | "contract_call";
  body?: string | null;
  contractCall?: BunnyOsContractCall | null;
  archivedAt?: string | null;
  // Per-user "completed" flag: true when this caller has executed or dismissed
  // the rec (present only on canView=true responses).
  executedByMe?: boolean;
  // Redacted (non-viewer) field: the local feed's action kind, used to render
  // the "pushed a recommendation/alert" stub without leaking content.
  kind?: "alert" | "recommendation";
}

interface ActionsResponse {
  canView: boolean;
  canManage: boolean;
  connected: boolean;
  actions: BunnyActionItem[];
}

function ActionPushHistory({
  bunny,
  t,
  onNotConnected,
  onAccessChange,
}: {
  bunny: BunnyListItem;
  t: TFn;
  onNotConnected: () => void;
  onAccessChange?: (canView: boolean) => void;
}) {
  const [data, setData] = useState<ActionsResponse | null>(null);
  const [err, setErr] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [recsView, setRecsView] = useState<"active" | "completed" | "all">(
    "active",
  );
  const setChatInput = useAppStore((s) => s.setChatInput);
  const setChatOpen = useAppStore((s) => s.setChatOpen);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/actions`, {
          ...FETCH_OPTS,
          signal,
        });
        if (!r.ok) {
          setErr(true);
          return;
        }
        const j = (await r.json()) as ActionsResponse;
        setData(j);
      } catch {
        if (!signal?.aborted) setErr(true);
      }
    },
    [bunny.id],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setErr(false);
    setDraft("");
    setPostErr(null);
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const post = useCallback(async () => {
    const body = draft.trim();
    if (body.length === 0) return;
    setPosting(true);
    setPostErr(null);
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/actions`, {
        ...FETCH_OPTS,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "body", body }),
      });
      if (r.status === 401) {
        // bunnyOS session expired mid-action: reflect it locally so the
        // composer hides, and bubble up so the top-level bunnyOS reconnect
        // prompt reappears (top status comes from /api/bunny/list).
        setData((d) => (d ? { ...d, connected: false } : d));
        setComposerOpen(false);
        onNotConnected();
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error || t("bunny.actionsPostError"));
      }
      setDraft("");
      setComposerOpen(false);
      await load();
    } catch (e) {
      setPostErr(e instanceof Error ? e.message : t("bunny.actionsPostError"));
    } finally {
      setPosting(false);
    }
  }, [bunny.id, draft, load, onNotConnected, t]);

  const toggleArchive = useCallback(
    async (a: BunnyActionItem) => {
      setBusyId(a.id);
      setPostErr(null);
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/actions/${a.id}`, {
          ...FETCH_OPTS,
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            archivedAt: a.archivedAt ? null : new Date().toISOString(),
          }),
        });
        if (r.status === 401) {
          setData((d) => (d ? { ...d, connected: false } : d));
          onNotConnected();
          return;
        }
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(j?.error || t("bunny.actionsArchiveError"));
        }
        await load();
      } catch (e) {
        setPostErr(
          e instanceof Error ? e.message : t("bunny.actionsArchiveError"),
        );
      } finally {
        setBusyId(null);
      }
    },
    [bunny.id, load, onNotConnected, t],
  );

  // Mark a rec done for this caller (per-user flag). The action `id` is the
  // bunnyOS actionId; the execute endpoint expects the inbox key form
  // ("bunnyos:<id>"). Optimistically flip executedByMe so the row jumps to the
  // "completed" bucket at once, then reconcile from the server.
  const markDone = useCallback(
    async (a: BunnyActionItem) => {
      setData((d) =>
        d
          ? {
              ...d,
              actions: d.actions.map((x) =>
                x.id === a.id ? { ...x, executedByMe: true } : x,
              ),
            }
          : d,
      );
      try {
        await fetch(
          `/api/bunny/recommendations/${encodeURIComponent(`bunnyos:${a.id}`)}/execute`,
          { ...FETCH_OPTS, method: "POST" },
        );
      } catch {
        // Reconcile below — a failed mark-done refetches the true state.
      } finally {
        void load();
      }
    },
    [load],
  );

  // Execute a rec: same UX as the from-bunnies inbox — paste the body into the
  // chat composer, open chat, then record it done so it moves to "completed".
  // Only body-type recs are executable (contract-call recs are display-only).
  const executeRec = useCallback(
    (a: BunnyActionItem) => {
      const text = (a.body ?? "").trim();
      if (text) {
        setChatInput(text);
        setChatOpen(true);
        queueMicrotask(() => {
          document.getElementById("chat-input")?.focus();
        });
      }
      void markDone(a);
    },
    [markDone, setChatInput, setChatOpen],
  );

  const actions = data?.actions ?? [];
  const canView = data?.canView ?? false;
  const canManage = data?.canManage ?? false;
  const connected = data?.connected ?? false;

  // Bucket the recs: active = live (not archived, not done by me), completed =
  // executed/dismissed by me, all = everything (archived + completed labeled).
  const counts = useMemo(
    () => ({
      active: actions.filter((a) => !a.archivedAt && !a.executedByMe).length,
      completed: actions.filter((a) => a.executedByMe).length,
      all: actions.length,
    }),
    [actions],
  );
  const visibleActions = useMemo(() => {
    if (recsView === "active")
      return actions.filter((a) => !a.archivedAt && !a.executedByMe);
    if (recsView === "completed") return actions.filter((a) => a.executedByMe);
    return actions;
  }, [actions, recsView]);

  // Surface authoritative view-access to the parent tab (lock hint) once loaded.
  useEffect(() => {
    if (data !== null) onAccessChange?.(canView);
  }, [data, canView, onAccessChange]);

  return (
    <>
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.actionsTitle")}
        </div>
        {canView && connected && canManage && (
          <button
            type="button"
            onClick={() => {
              setPostErr(null);
              setComposerOpen(true);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            {t("bunny.actionsAddCta")}
          </button>
        )}
      </div>

      {err && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {t("bunny.actionsError")}
        </div>
      )}

      {!err && data === null && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("bunny.actionsLoading")}
        </div>
      )}

      {!err && data !== null && (
        <>
          {!canView && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 bg-background/40 px-6 py-12 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card">
                <Lock className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="font-mono text-sm">
                {t("bunny.recsLockedTitle")}
              </div>
              <div className="max-w-xs font-mono text-[11px] leading-relaxed text-muted-foreground">
                {t("bunny.recsLockedBody")}
              </div>
            </div>
          )}

          {canView && !connected && (
            <div className="font-mono text-[11px] text-muted-foreground">
              {t("bunny.actionsConnectHint")}
            </div>
          )}

          {canView && connected && (
            <>
              <div className="mb-3 flex items-center gap-1">
                {(["active", "completed", "all"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setRecsView(v)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                      recsView === v
                        ? "bg-card text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`bunny.recsFilter_${v}`)}
                    <span className="text-muted-foreground/70">
                      {counts[v]}
                    </span>
                  </button>
                ))}
              </div>

              {visibleActions.length === 0 ? (
                <div className="font-mono text-[11px] text-muted-foreground">
                  {recsView === "active"
                    ? t("bunny.actionsEmpty")
                    : t("bunny.recsBucketEmpty")}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {visibleActions.map((a) => {
                    const archived = Boolean(a.archivedAt);
                    const completed = Boolean(a.executedByMe);
                    const isActive = !archived && !completed;
                    const canExecute =
                      a.type === "body" && !!(a.body ?? "").trim();
                    return (
                      <div
                        key={a.id}
                        className={cn(
                          "flex items-start justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2",
                          (archived || completed) && "opacity-60",
                        )}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <span
                            className={cn(
                              "mt-1 shrink-0 font-mono text-sm leading-none",
                              a.type === "contract_call"
                                ? "text-accent"
                                : "text-[hsl(var(--green))]",
                            )}
                          >
                            ●
                          </span>
                          <div className="min-w-0">
                            {a.type === "contract_call" && a.contractCall ? (
                              <div className="font-mono text-[11px] font-medium leading-snug">
                                {t("bunny.actionsContractCall", {
                                  fn: a.contractCall.function,
                                })}
                              </div>
                            ) : (
                              <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
                                {a.body}
                              </div>
                            )}
                            <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
                              <span>{fmtTime(a.createdAt)}</span>
                              {completed && (
                                <span className="inline-flex items-center gap-0.5 rounded border border-[hsl(var(--green))]/40 px-1 uppercase tracking-widest text-[hsl(var(--green))]">
                                  <Check className="h-2.5 w-2.5" />
                                  {t("bunny.recsCompleted")}
                                </span>
                              )}
                              {archived && (
                                <span className="rounded border border-border/60 px-1 uppercase tracking-widest">
                                  {t("bunny.actionsArchived")}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {isActive && (
                            <>
                              {canExecute && (
                                <button
                                  type="button"
                                  onClick={() => executeRec(a)}
                                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground"
                                >
                                  <Zap className="h-3 w-3" />
                                  {t("bunny.recsExecute")}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void markDone(a)}
                                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                              >
                                <X className="h-3 w-3" />
                                {t("bunny.recsDismiss")}
                              </button>
                            </>
                          )}
                          {canManage && (
                            <button
                              type="button"
                              onClick={() => toggleArchive(a)}
                              disabled={busyId === a.id}
                              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-50"
                            >
                              {busyId === a.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : archived ? (
                                t("bunny.actionsUnarchive")
                              ) : (
                                t("bunny.actionsArchive")
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>

    <AnimatePresence>
      {composerOpen && canView && connected && canManage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
          onClick={() => {
            if (!posting) setComposerOpen(false);
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border border-border bg-card shadow-xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
              <h2 className="font-mono text-sm font-medium lowercase">
                {t("bunny.actionsComposerTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                disabled={posting}
                className="shrink-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-col gap-3 px-4 py-4">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={5}
                maxLength={4000}
                autoFocus
                placeholder={t("bunny.actionsPostPlaceholder")}
                className="resize-none rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] focus:border-accent focus:outline-none"
              />
              {postErr && (
                <div className="font-mono text-[10px] text-[hsl(var(--red))]">
                  {postErr}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={post}
                  disabled={posting || draft.trim().length === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {posting && <Loader2 className="h-3 w-3 animate-spin" />}
                  {posting
                    ? t("bunny.actionsPosting")
                    : t("bunny.actionsPostCta")}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
    </>
  );
}

// ---- bunny forum (Threads) ---------------------------------------------
// A per-bunny community forum hosted entirely by bunnyOS (api.bunnyos.ai):
// key holders post topics, comment in nested threads, and up/down-vote. The
// owner, moderators and admins can delete any post/comment and manage the
// per-bunny moderator + ban lists. View/write access and every affordance is
// driven by the bunnyOS `/exchange/permissions` capability map (advisory; the
// server still enforces). Non-holders get the locked state. Sort: New / Top.

type ForumSort = "new" | "top";
type ViewerVote = "up" | "down" | null;

interface ForumThreadPermissions {
  isModerator: boolean;
  isBanned: boolean;
  canView: boolean;
  canPost: boolean;
  canModerate: boolean;
  moderators: { canView: boolean; canManage: boolean };
  bans: { canView: boolean; canManage: boolean };
}
interface ForumPermissions {
  id: string;
  roles: { isOwner: boolean; isKeyHolder: boolean };
  profile: { canEdit: boolean };
  thread: ForumThreadPermissions;
  recommendation: { canView: boolean; canCreate: boolean; canManage: boolean };
}

interface ForumPost {
  id: string;
  bunnyId: string;
  title: string;
  body: string;
  createdBy: string;
  createdAt: string;
  deleted: boolean;
  deletedAt: string | null;
  score: number;
  commentCount: number;
  viewerVote: ViewerVote;
}
interface ForumComment {
  id: string;
  bunnyId: string;
  postId: string;
  parentCommentId: string | null;
  body: string;
  createdBy: string;
  createdAt: string;
  deleted: boolean;
  deletedAt: string | null;
  score: number;
  viewerVote: ViewerVote;
}
interface ForumCommentNode extends ForumComment {
  replies: ForumCommentNode[];
}
interface ForumModerator {
  bunnyId: string;
  address: string;
  createdBy: string;
  createdAt: string;
}
interface ForumBan {
  bunnyId: string;
  address: string;
  createdBy: string;
  createdAt: string;
}

function forumAuthorLabel(createdBy: string, t: TFn): string {
  return createdBy ? shortAddr(createdBy) : t("bunny.forumAnon");
}

function voteDelta(v: ViewerVote): number {
  return v === "up" ? 1 : v === "down" ? -1 : 0;
}

// Recursively replace one node in a comment tree.
function mapCommentTree(
  nodes: ForumCommentNode[],
  id: string,
  fn: (c: ForumCommentNode) => ForumCommentNode,
): ForumCommentNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.replies.length === 0) return n;
    return { ...n, replies: mapCommentTree(n.replies, id, fn) };
  });
}

function VoteControl({
  score,
  viewerVote,
  onVote,
}: {
  score: number;
  viewerVote: ViewerVote;
  onVote: (dir: "up" | "down") => void;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5">
      <button
        type="button"
        onClick={() => onVote("up")}
        aria-label="upvote"
        className={cn(
          "transition-colors hover:text-[hsl(var(--green))]",
          viewerVote === "up"
            ? "text-[hsl(var(--green))]"
            : "text-muted-foreground",
        )}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <span
        className={cn(
          "font-mono text-[11px] tabular-nums",
          viewerVote === "up" && "text-[hsl(var(--green))]",
          viewerVote === "down" && "text-[hsl(var(--red))]",
        )}
      >
        {score}
      </span>
      <button
        type="button"
        onClick={() => onVote("down")}
        aria-label="downvote"
        className={cn(
          "transition-colors hover:text-[hsl(var(--red))]",
          viewerVote === "down"
            ? "text-[hsl(var(--red))]"
            : "text-muted-foreground",
        )}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}

// Max nesting depth shown in the UI, counted inclusive of the root comment
// (depth 0). At 3 we render the root + two levels of replies; replying and
// rendering stop past that for now (a future "read more" can expand deeper
// chains). The data tree itself is unbounded — this only caps display.
const MAX_COMMENT_DEPTH = 2;

// A single comment plus its nested children, with an inline reply composer and
// (when permitted) a delete control. Deleted comments render as a tombstone but
// keep their reply chain intact.
function ForumCommentNodeView({
  node,
  depth,
  t,
  canPost,
  canDelete,
  onVote,
  onReply,
  onDelete,
}: {
  node: ForumCommentNode;
  depth: number;
  t: TFn;
  canPost: boolean;
  canDelete: (createdBy: string) => boolean;
  onVote: (comment: ForumComment, dir: "up" | "down") => void;
  onReply: (parentCommentId: string, body: string) => Promise<boolean>;
  onDelete: (commentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body = draft.trim();
    if (body.length === 0) return;
    setBusy(true);
    const ok = await onReply(node.id, body);
    setBusy(false);
    if (ok) {
      setDraft("");
      setOpen(false);
    }
  };

  return (
    <div className={cn(depth > 0 && "ml-3 border-l border-border/50 pl-3")}>
      <div className="flex items-start gap-2 py-2">
        {!node.deleted && (
          <VoteControl
            score={node.score}
            viewerVote={node.viewerVote}
            onVote={(dir) => onVote(node, dir)}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
            <span className="text-foreground/80">
              {forumAuthorLabel(node.createdBy, t)}
            </span>
            <span>{fmtTime(node.createdAt)}</span>
          </div>
          {node.deleted ? (
            <div className="mt-0.5 font-mono text-[11px] italic text-muted-foreground/60">
              {t("bunny.forumDeleted")}
            </div>
          ) : (
            <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
              {node.body}
            </div>
          )}
          {!node.deleted && (
            <div className="mt-1 flex items-center gap-3">
              {canPost && depth < MAX_COMMENT_DEPTH && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t("bunny.forumReply")}
                </button>
              )}
              {canDelete(node.createdBy) && (
                <button
                  type="button"
                  onClick={() => onDelete(node.id)}
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-[hsl(var(--red))]"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("bunny.forumDelete")}
                </button>
              )}
            </div>
          )}
          {open && (
            <div className="mt-2 flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                maxLength={10000}
                autoFocus
                placeholder={t("bunny.forumReplyPlaceholder")}
                className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] focus:border-accent focus:outline-none"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  {t("bunny.forumCancel")}
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy || draft.trim().length === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("bunny.forumReplyCta")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {node.replies.length > 0 && depth < MAX_COMMENT_DEPTH && (
        <div>
          {node.replies.map((child) => (
            <ForumCommentNodeView
              key={child.id}
              node={child}
              depth={depth + 1}
              t={t}
              canPost={canPost}
              canDelete={canDelete}
              onVote={onVote}
              onReply={onReply}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Moderator + ban management modal. Each section is independently gated by the
// bunnyOS capability map: a row is read-only unless `canManage` is set.
function ForumModerationPanel({
  bunny,
  t,
  perms,
  onClose,
}: {
  bunny: BunnyListItem;
  t: TFn;
  perms: ForumThreadPermissions;
  onClose: () => void;
}) {
  const [mods, setMods] = useState<ForumModerator[] | null>(null);
  const [bans, setBans] = useState<ForumBan[] | null>(null);
  const [modDraft, setModDraft] = useState("");
  const [banDraft, setBanDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadMods = useCallback(async () => {
    if (!perms.moderators.canView) return;
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/forum/moderators`, {
        ...FETCH_OPTS,
      });
      if (!r.ok) return;
      const j = (await r.json()) as { moderators: ForumModerator[] };
      setMods(j.moderators ?? []);
    } catch {
      // best-effort
    }
  }, [bunny.id, perms.moderators.canView]);

  const loadBans = useCallback(async () => {
    if (!perms.bans.canView) return;
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/forum/bans`, {
        ...FETCH_OPTS,
      });
      if (!r.ok) return;
      const j = (await r.json()) as { bans: ForumBan[] };
      setBans(j.bans ?? []);
    } catch {
      // best-effort
    }
  }, [bunny.id, perms.bans.canView]);

  useEffect(() => {
    void loadMods();
    void loadBans();
  }, [loadMods, loadBans]);

  const isAddress = (a: string) => /^0x[a-fA-F0-9]{40}$/.test(a.trim());

  const addMod = async () => {
    const a = modDraft.trim().toLowerCase();
    if (!isAddress(a)) {
      setErr(t("bunny.forumInvalidAddress"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/forum/moderators/${a}`, {
        ...FETCH_OPTS,
        method: "PUT",
      });
      if (!r.ok) throw new Error();
      setModDraft("");
      await loadMods();
    } catch {
      setErr(t("bunny.forumActionError"));
    } finally {
      setBusy(false);
    }
  };

  const removeMod = async (address: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/bunny/${bunny.id}/forum/moderators/${address}`,
        { ...FETCH_OPTS, method: "DELETE" },
      );
      if (!r.ok) throw new Error();
      await loadMods();
    } catch {
      setErr(t("bunny.forumActionError"));
    } finally {
      setBusy(false);
    }
  };

  const addBan = async () => {
    const a = banDraft.trim().toLowerCase();
    if (!isAddress(a)) {
      setErr(t("bunny.forumInvalidAddress"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/forum/bans/${a}`, {
        ...FETCH_OPTS,
        method: "PUT",
      });
      if (!r.ok) throw new Error();
      setBanDraft("");
      await loadBans();
    } catch {
      setErr(t("bunny.forumActionError"));
    } finally {
      setBusy(false);
    }
  };

  const removeBan = async (address: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/forum/bans/${address}`, {
        ...FETCH_OPTS,
        method: "DELETE",
      });
      if (!r.ok) throw new Error();
      await loadBans();
    } catch {
      setErr(t("bunny.forumActionError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
          <h2 className="font-mono text-sm font-medium lowercase">
            {t("bunny.forumModerationTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">
          {err && (
            <div className="font-mono text-[10px] text-[hsl(var(--red))]">
              {err}
            </div>
          )}

          {/* moderators */}
          {perms.moderators.canView && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <Shield className="h-3 w-3" />
                {t("bunny.forumModerators")}
              </div>
              {perms.moderators.canManage && (
                <div className="flex items-center gap-2">
                  <input
                    value={modDraft}
                    onChange={(e) => setModDraft(e.target.value)}
                    placeholder={t("bunny.forumAddressPlaceholder")}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={addMod}
                    disabled={busy || modDraft.trim().length === 0}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    {t("bunny.forumAdd")}
                  </button>
                </div>
              )}
              {mods === null ? (
                <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("bunny.forumLoading")}
                </div>
              ) : mods.length === 0 ? (
                <div className="font-mono text-[11px] text-muted-foreground">
                  {t("bunny.forumModeratorsEmpty")}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {mods.map((m) => (
                    <div
                      key={m.address}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5"
                    >
                      <span className="truncate font-mono text-[11px]">
                        {shortAddr(m.address)}
                      </span>
                      {perms.moderators.canManage && (
                        <button
                          type="button"
                          onClick={() => removeMod(m.address)}
                          disabled={busy}
                          className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-[hsl(var(--red))] disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                          {t("bunny.forumRemove")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* bans */}
          {perms.bans.canView && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <Ban className="h-3 w-3" />
                {t("bunny.forumBans")}
              </div>
              {perms.bans.canManage && (
                <div className="flex items-center gap-2">
                  <input
                    value={banDraft}
                    onChange={(e) => setBanDraft(e.target.value)}
                    placeholder={t("bunny.forumAddressPlaceholder")}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={addBan}
                    disabled={busy || banDraft.trim().length === 0}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    {t("bunny.forumAdd")}
                  </button>
                </div>
              )}
              {bans === null ? (
                <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("bunny.forumLoading")}
                </div>
              ) : bans.length === 0 ? (
                <div className="font-mono text-[11px] text-muted-foreground">
                  {t("bunny.forumBansEmpty")}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {bans.map((b) => (
                    <div
                      key={b.address}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5"
                    >
                      <span className="truncate font-mono text-[11px]">
                        {shortAddr(b.address)}
                      </span>
                      {perms.bans.canManage && (
                        <button
                          type="button"
                          onClick={() => removeBan(b.address)}
                          disabled={busy}
                          className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-50"
                        >
                          <X className="h-3 w-3" />
                          {t("bunny.forumRemove")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function BunnyForum({
  bunny,
  t,
  onAccessChange,
}: {
  bunny: BunnyListItem;
  t: TFn;
  onAccessChange?: (canView: boolean) => void;
}) {
  const [sort, setSort] = useState<ForumSort>("new");
  const [list, setList] = useState<ForumPost[] | null>(null);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [listErr, setListErr] = useState(false);
  const [perms, setPerms] = useState<ForumPermissions | null>(null);
  const [viewerAddress, setViewerAddress] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    post: ForumPost;
    comments: ForumCommentNode[];
  } | null>(null);
  const [detailErr, setDetailErr] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);

  const canPost = perms?.thread.canPost ?? false;
  const canManage =
    (perms?.thread.moderators.canManage ?? false) ||
    (perms?.thread.bans.canManage ?? false) ||
    (perms?.thread.moderators.canView ?? false) ||
    (perms?.thread.bans.canView ?? false);

  const canDelete = useCallback(
    (createdBy: string): boolean => {
      if (perms?.thread.canModerate) return true;
      if (
        viewerAddress &&
        createdBy &&
        viewerAddress.toLowerCase() === createdBy.toLowerCase()
      )
        return true;
      return false;
    },
    [perms, viewerAddress],
  );

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await fetch(
          `/api/bunny/${bunny.id}/forum/posts?sort=${sort}`,
          { ...FETCH_OPTS, signal },
        );
        if (!r.ok) {
          setListErr(true);
          return;
        }
        const j = (await r.json()) as {
          canView: boolean;
          permissions: ForumPermissions | null;
          viewerAddress: string | null;
          posts: ForumPost[];
        };
        setCanView(j.canView);
        setPerms(j.permissions);
        setViewerAddress(j.viewerAddress ?? null);
        setList(j.posts ?? []);
        onAccessChange?.(j.canView);
      } catch {
        if (!signal?.aborted) setListErr(true);
      }
    },
    [bunny.id, sort, onAccessChange],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setList(null);
    setListErr(false);
    void loadList(ctrl.signal);
    return () => ctrl.abort();
  }, [loadList]);

  // Reset detail view when the bunny changes.
  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
  }, [bunny.id]);

  const loadDetail = useCallback(
    async (postId: string, signal?: AbortSignal) => {
      setDetail(null);
      setDetailErr(false);
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/forum/posts/${postId}`, {
          ...FETCH_OPTS,
          signal,
        });
        if (!r.ok) {
          setDetailErr(true);
          return;
        }
        const j = (await r.json()) as {
          post: ForumPost;
          comments: ForumCommentNode[];
          permissions: ForumPermissions | null;
          viewerAddress: string | null;
        };
        setDetail({ post: j.post, comments: j.comments ?? [] });
        if (j.permissions) setPerms(j.permissions);
        if (j.viewerAddress) setViewerAddress(j.viewerAddress);
      } catch {
        if (!signal?.aborted) setDetailErr(true);
      }
    },
    [bunny.id],
  );

  useEffect(() => {
    if (!selectedId) return;
    const ctrl = new AbortController();
    void loadDetail(selectedId, ctrl.signal);
    return () => ctrl.abort();
  }, [selectedId, loadDetail]);

  const submitPost = async () => {
    const tt = title.trim();
    const bb = body.trim();
    if (tt.length === 0 || bb.length === 0) return;
    setPosting(true);
    setPostErr(null);
    try {
      const r = await fetch(`/api/bunny/${bunny.id}/forum/posts`, {
        ...FETCH_OPTS,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: tt, body: bb }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error || t("bunny.forumPostError"));
      }
      setTitle("");
      setBody("");
      setComposerOpen(false);
      await loadList();
    } catch (e) {
      setPostErr(e instanceof Error ? e.message : t("bunny.forumPostError"));
    } finally {
      setPosting(false);
    }
  };

  // Optimistic vote: PUT a direction (set/flip) or DELETE when re-clicking the
  // active direction. bunnyOS returns the authoritative post/comment, which we
  // reconcile in. On failure we re-pull the affected view.
  const castPostVote = useCallback(
    async (post: ForumPost, dir: "up" | "down") => {
      const clearing = post.viewerVote === dir;
      const next: ViewerVote = clearing ? null : dir;
      const optimistic: ForumPost = {
        ...post,
        viewerVote: next,
        score: post.score - voteDelta(post.viewerVote) + voteDelta(next),
      };
      setList((cur) =>
        cur ? cur.map((p) => (p.id === post.id ? optimistic : p)) : cur,
      );
      setDetail((cur) =>
        cur && cur.post.id === post.id ? { ...cur, post: optimistic } : cur,
      );
      try {
        const r = await fetch(
          `/api/bunny/${bunny.id}/forum/posts/${post.id}/vote`,
          {
            ...FETCH_OPTS,
            method: clearing ? "DELETE" : "PUT",
            headers: { "Content-Type": "application/json" },
            ...(clearing
              ? {}
              : { body: JSON.stringify({ direction: dir }) }),
          },
        );
        if (!r.ok) throw new Error("vote failed");
        const j = (await r.json()) as { post: ForumPost };
        setList((cur) =>
          cur ? cur.map((p) => (p.id === post.id ? j.post : p)) : cur,
        );
        setDetail((cur) =>
          cur && cur.post.id === post.id ? { ...cur, post: j.post } : cur,
        );
      } catch {
        void loadList();
        if (selectedId) void loadDetail(selectedId);
      }
    },
    [bunny.id, loadList, loadDetail, selectedId],
  );

  const castCommentVote = useCallback(
    async (comment: ForumComment, dir: "up" | "down") => {
      if (!selectedId) return;
      const clearing = comment.viewerVote === dir;
      const next: ViewerVote = clearing ? null : dir;
      setDetail((cur) =>
        cur
          ? {
              ...cur,
              comments: mapCommentTree(cur.comments, comment.id, (c) => ({
                ...c,
                viewerVote: next,
                score: c.score - voteDelta(c.viewerVote) + voteDelta(next),
              })),
            }
          : cur,
      );
      try {
        const r = await fetch(
          `/api/bunny/${bunny.id}/forum/posts/${selectedId}/comments/${comment.id}/vote`,
          {
            ...FETCH_OPTS,
            method: clearing ? "DELETE" : "PUT",
            headers: { "Content-Type": "application/json" },
            ...(clearing
              ? {}
              : { body: JSON.stringify({ direction: dir }) }),
          },
        );
        if (!r.ok) throw new Error("vote failed");
        const j = (await r.json()) as { comment: ForumComment };
        setDetail((cur) =>
          cur
            ? {
                ...cur,
                comments: mapCommentTree(cur.comments, comment.id, (c) => ({
                  ...c,
                  score: j.comment.score,
                  viewerVote: j.comment.viewerVote,
                })),
              }
            : cur,
        );
      } catch {
        if (selectedId) void loadDetail(selectedId);
      }
    },
    [bunny.id, loadDetail, selectedId],
  );

  const submitComment = useCallback(
    async (
      parentCommentId: string | null,
      commentBody: string,
    ): Promise<boolean> => {
      if (!selectedId) return false;
      try {
        const r = await fetch(
          `/api/bunny/${bunny.id}/forum/posts/${selectedId}/comments`,
          {
            ...FETCH_OPTS,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: commentBody, parentCommentId }),
          },
        );
        if (!r.ok) return false;
        await loadDetail(selectedId);
        return true;
      } catch {
        return false;
      }
    },
    [bunny.id, selectedId, loadDetail],
  );

  const submitTopComment = async () => {
    const bb = replyDraft.trim();
    if (bb.length === 0) return;
    setReplyBusy(true);
    const ok = await submitComment(null, bb);
    setReplyBusy(false);
    if (ok) setReplyDraft("");
  };

  const deletePost = useCallback(
    async (postId: string) => {
      if (!window.confirm(t("bunny.forumDeleteConfirm"))) return;
      try {
        const r = await fetch(`/api/bunny/${bunny.id}/forum/posts/${postId}`, {
          ...FETCH_OPTS,
          method: "DELETE",
        });
        if (!r.ok) throw new Error();
        const j = (await r.json()) as { post: ForumPost };
        setList((cur) =>
          cur ? cur.map((p) => (p.id === postId ? j.post : p)) : cur,
        );
        setDetail((cur) =>
          cur && cur.post.id === postId ? { ...cur, post: j.post } : cur,
        );
      } catch {
        void loadList();
        if (selectedId) void loadDetail(selectedId);
      }
    },
    [bunny.id, t, loadList, loadDetail, selectedId],
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      if (!selectedId) return;
      if (!window.confirm(t("bunny.forumDeleteConfirm"))) return;
      try {
        const r = await fetch(
          `/api/bunny/${bunny.id}/forum/posts/${selectedId}/comments/${commentId}`,
          { ...FETCH_OPTS, method: "DELETE" },
        );
        if (!r.ok) throw new Error();
        const j = (await r.json()) as { comment: ForumComment };
        setDetail((cur) =>
          cur
            ? {
                ...cur,
                comments: mapCommentTree(cur.comments, commentId, (c) => ({
                  ...c,
                  ...j.comment,
                  replies: c.replies,
                })),
              }
            : cur,
        );
      } catch {
        if (selectedId) void loadDetail(selectedId);
      }
    },
    [bunny.id, t, selectedId, loadDetail],
  );

  // ---- locked / loading / error states ----
  if (listErr) {
    return (
      <div className="px-4 py-4 font-mono text-[11px] text-muted-foreground">
        {t("bunny.forumError")}
      </div>
    );
  }
  if (list === null && canView === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 font-mono text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("bunny.forumLoading")}
      </div>
    );
  }
  if (canView === false) {
    return (
      <div className="px-4 py-4">
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 bg-background/40 px-6 py-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card">
            <Lock className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="font-mono text-sm">
            {t("bunny.forumLockedTitle")}
          </div>
          <div className="max-w-xs font-mono text-[11px] leading-relaxed text-muted-foreground">
            {t("bunny.forumLockedBody")}
          </div>
        </div>
      </div>
    );
  }

  // ---- detail view ----
  if (selectedId) {
    return (
      <div className="px-4 py-4">
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className="mb-3 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          {t("bunny.forumBackToList")}
        </button>

        {detailErr && (
          <div className="font-mono text-[11px] text-muted-foreground">
            {t("bunny.forumError")}
          </div>
        )}
        {!detailErr && detail === null && (
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("bunny.forumLoading")}
          </div>
        )}
        {detail && (
          <>
            <div className="flex items-start gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-3">
              {!detail.post.deleted && (
                <VoteControl
                  score={detail.post.score}
                  viewerVote={detail.post.viewerVote}
                  onVote={(dir) => castPostVote(detail.post, dir)}
                />
              )}
              <div className="min-w-0 flex-1">
                {detail.post.deleted ? (
                  <div className="font-mono text-sm italic text-muted-foreground/60">
                    {t("bunny.forumDeleted")}
                  </div>
                ) : (
                  <div className="font-mono text-sm font-medium leading-snug">
                    {detail.post.title}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
                  <span className="text-foreground/80">
                    {forumAuthorLabel(detail.post.createdBy, t)}
                  </span>
                  <span>{fmtTime(detail.post.createdAt)}</span>
                </div>
                {!detail.post.deleted && (
                  <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">
                    {detail.post.body}
                  </div>
                )}
                {!detail.post.deleted && canDelete(detail.post.createdBy) && (
                  <button
                    type="button"
                    onClick={() => deletePost(detail.post.id)}
                    className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-[hsl(var(--red))]"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t("bunny.forumDelete")}
                  </button>
                )}
              </div>
            </div>

            {/* top-level comment composer */}
            {canPost && !detail.post.deleted && (
              <div className="mt-3 flex flex-col gap-2">
                <textarea
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  rows={2}
                  maxLength={10000}
                  placeholder={t("bunny.forumReplyPlaceholder")}
                  className="resize-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] focus:border-accent focus:outline-none"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={submitTopComment}
                    disabled={replyBusy || replyDraft.trim().length === 0}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {replyBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                    {t("bunny.forumReplyCta")}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-3">
              {detail.comments.length === 0 ? (
                <div className="font-mono text-[11px] text-muted-foreground">
                  {t("bunny.forumNoReplies")}
                </div>
              ) : (
                detail.comments.map((node) => (
                  <ForumCommentNodeView
                    key={node.id}
                    node={node}
                    depth={0}
                    t={t}
                    canPost={canPost}
                    canDelete={canDelete}
                    onVote={castCommentVote}
                    onReply={(parentCommentId, b) =>
                      submitComment(parentCommentId, b)
                    }
                    onDelete={deleteComment}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- list view ----
  return (
    <>
      <div className="px-4 py-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("bunny.forumTitle")}
          </div>
          <div className="flex items-center gap-2">
            {canManage && perms && (
              <button
                type="button"
                onClick={() => setManageOpen(true)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <Shield className="h-3 w-3" />
                {t("bunny.forumManage")}
              </button>
            )}
            {canPost && (
              <button
                type="button"
                onClick={() => {
                  setPostErr(null);
                  setComposerOpen(true);
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                {t("bunny.forumNewPost")}
              </button>
            )}
          </div>
        </div>

        {perms?.thread.isBanned && (
          <div className="mb-3 rounded-md border border-[hsl(var(--red))]/40 bg-[hsl(var(--red))]/5 px-3 py-2 font-mono text-[10px] text-[hsl(var(--red))]">
            {t("bunny.forumBannedNotice")}
          </div>
        )}

        <div className="mb-3 flex items-center gap-1">
          {(["new", "top"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                sort === s
                  ? "bg-card text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`bunny.forumSort_${s}`)}
            </button>
          ))}
        </div>

        {list === null ? (
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("bunny.forumLoading")}
          </div>
        ) : list.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground">
            {t("bunny.forumEmpty")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {list.map((p) => (
              <div
                key={p.id}
                className="flex items-start gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2"
              >
                {!p.deleted && (
                  <VoteControl
                    score={p.score}
                    viewerVote={p.viewerVote}
                    onVote={(dir) => castPostVote(p, dir)}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  {p.deleted ? (
                    <div className="truncate font-mono text-[12px] font-medium italic leading-snug text-muted-foreground/60">
                      {t("bunny.forumDeleted")}
                    </div>
                  ) : (
                    <>
                      <div className="truncate font-mono text-[12px] font-medium leading-snug">
                        {p.title}
                      </div>
                      <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground">
                        {p.body}
                      </div>
                    </>
                  )}
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
                    <span className="text-foreground/80">
                      {forumAuthorLabel(p.createdBy, t)}
                    </span>
                    <span>{fmtTime(p.createdAt)}</span>
                    <span className="inline-flex items-center gap-0.5">
                      <MessageSquare className="h-2.5 w-2.5" />
                      {p.commentCount}
                    </span>
                  </div>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {manageOpen && perms && (
          <ForumModerationPanel
            bunny={bunny}
            t={t}
            perms={perms.thread}
            onClose={() => setManageOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {composerOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
            onClick={() => {
              if (!posting) setComposerOpen(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-lg border border-border bg-card shadow-xl"
            >
              <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
                <h2 className="font-mono text-sm font-medium lowercase">
                  {t("bunny.forumComposerTitle")}
                </h2>
                <button
                  type="button"
                  onClick={() => setComposerOpen(false)}
                  disabled={posting}
                  className="shrink-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-col gap-3 px-4 py-4">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={300}
                  autoFocus
                  placeholder={t("bunny.forumTitlePlaceholder")}
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] focus:border-accent focus:outline-none"
                />
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  maxLength={10000}
                  placeholder={t("bunny.forumBodyPlaceholder")}
                  className="resize-none rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] focus:border-accent focus:outline-none"
                />
                {postErr && (
                  <div className="font-mono text-[10px] text-[hsl(var(--red))]">
                    {postErr}
                  </div>
                )}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={submitPost}
                    disabled={
                      posting ||
                      title.trim().length === 0 ||
                      body.trim().length === 0
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {posting && <Loader2 className="h-3 w-3 animate-spin" />}
                    {posting
                      ? t("bunny.forumPosting")
                      : t("bunny.forumPostCta")}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

// ---- list card ----------------------------------------------------------

function BunnyCard({
  bunny,
  config,
  selected,
  onSelect,
  t,
  osPriceUsd,
}: {
  bunny: BunnyListItem;
  config: ExchangeConfig;
  selected: boolean;
  onSelect: () => void;
  t: TFn;
  osPriceUsd?: number | null;
}) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={cn(
        "w-full text-left rounded-lg border p-3 transition-colors",
        selected
          ? "border-accent bg-accent/5 ring-1 ring-accent/40"
          : "border-border bg-card/40 hover:border-foreground/30",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src={bunny.profile?.photoUrl ?? defaultBunnyImg}
            alt=""
            className="h-9 w-9 shrink-0 rounded-md border border-border bg-background object-cover"
          />
          <div className="min-w-0">
            <div className="font-mono text-sm font-medium truncate">
              {bunny.profile?.name ||
                bunny.name ||
                t("bunny.bunnyId", { id: String(bunny.id) })}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground truncate">
              {bunny.profile?.name || bunny.name ? `#${bunny.id} · ` : ""}
              {shortAddr(bunny.creator)}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-sm">
            {fmtToken(bunny.buyPrice)} {config.tokenSymbol}
          </div>
          <UsdHint
            os={bunny.buyPrice}
            price={osPriceUsd}
            className="block font-mono text-[10px]"
          />
          <div className="font-mono text-[11px] text-muted-foreground">
            {t("bunny.colSupply")} {bunny.supply}
            {bunny.userKeys !== undefined && bunny.userKeys !== "0"
              ? ` · ${t("bunny.colYourKeys")} ${bunny.userKeys}`
              : ""}
          </div>
        </div>
      </div>
      {(() => {
        const desc = bunny.profile?.description || bunny.description;
        if (!desc) return null;
        const trimmed = desc.trim();
        const short = trimmed.length > 50 ? `${trimmed.slice(0, 50).trimEnd()}…` : trimmed;
        return (
          <div className="mt-1.5 font-mono text-[11px] text-muted-foreground/80 truncate">
            {short}
          </div>
        );
      })()}
      {bunny.soldOut && (
        <div className="mt-2 inline-block font-mono text-[10px] uppercase tracking-widest text-destructive">
          {t("bunny.soldOut")}
        </div>
      )}
    </motion.button>
  );
}

// ---- bunny profile editor ----------------------------------------------
// Editor for a bunny's profile, owned by bunnyOS. Writes require a connected
// bunnyOS session (bearer JWT); bunnyOS enforces that only the owner/admin may
// write. Avatars are display-only from bunnyOS `photoUrl` and not editable here.

// Reusable profile form body (fields + save + action buttons). Used by both the
// standalone edit modal (BunnyProfileModal) and the shared registration step of
// the add-bunny flow. The overlay/header chrome is provided by the caller; this
// renders only the form contents and saves via PUT /api/bunny/:id/profile.
function BunnyProfileForm({
  bunnyId,
  profile,
  t,
  onSaved,
  onNotConnected,
  onCancel,
  saveLabel,
  cancelLabel,
}: {
  bunnyId: number;
  profile: BunnyProfile | null;
  t: TFn;
  onSaved: (p: BunnyProfile) => void;
  onNotConnected: () => void;
  onCancel: () => void;
  saveLabel?: string;
  cancelLabel?: string;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [bio, setBio] = useState(profile?.description ?? "");
  const [twitter, setTwitter] = useState(profile?.socials.x ?? "");
  const [discord, setDiscord] = useState(profile?.socials.discord ?? "");
  const [telegram, setTelegram] = useState(profile?.socials.telegram ?? "");
  const [website, setWebsite] = useState(profile?.website ?? "");
  const [methodology, setMethodology] = useState<BunnyMethodology | "">(
    profile?.methodology[0] ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Avatar upload state. `photoUrl` is the current/preview image shown in the
  // form; `pendingObjectPath` is a freshly-uploaded object-storage path that is
  // sent as `photoUrl` in the profile save so bunnyOS persists it (no local
  // avatar table). The server turns the object path into a public serving URL.
  const [photoUrl, setPhotoUrl] = useState<string | null>(
    profile?.photoUrl ?? null,
  );
  const [pendingObjectPath, setPendingObjectPath] = useState<string | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const onPickFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setError(null);
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
        setError(t("bunny.profilePhotoTypeError"));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(t("bunny.profilePhotoSizeError"));
        return;
      }
      setUploading(true);
      try {
        const reqRes = await fetch("/api/storage/uploads/request-url", {
          ...FETCH_OPTS,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name || "avatar",
            size: file.size,
            contentType: file.type,
          }),
        });
        if (!reqRes.ok) throw new Error("request-url failed");
        const { uploadURL, objectPath } = (await reqRes.json()) as {
          uploadURL: string;
          objectPath: string;
        };
        const putRes = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!putRes.ok) throw new Error("upload failed");
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        const localPreview = URL.createObjectURL(file);
        previewUrlRef.current = localPreview;
        setPhotoUrl(localPreview);
        setPendingObjectPath(objectPath);
      } catch {
        setError(t("bunny.profilePhotoUploadError"));
      } finally {
        setUploading(false);
      }
    },
    [t],
  );

  const save = useCallback(async () => {
    if (name.trim().length === 0) {
      setError(t("bunny.profileNameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/bunny/${bunnyId}/profile`, {
        ...FETCH_OPTS,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          bio,
          website,
          twitter,
          discord,
          telegram,
          methodology,
          // Only send photoUrl when a new image was just uploaded; the server
          // converts the "/objects/..." path into a public URL and persists it
          // to bunnyOS. Omitting it leaves the existing avatar untouched.
          ...(pendingObjectPath ? { photoUrl: pendingObjectPath } : {}),
        }),
      });
      if (r.status === 401) {
        onNotConnected();
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error || t("bunny.profileSaveError"));
      }
      const j = (await r.json()) as { profile: BunnyProfile };
      setPendingObjectPath(null);
      onSaved(j.profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("bunny.profileSaveError"));
    } finally {
      setBusy(false);
    }
  }, [
    bunnyId,
    name,
    bio,
    website,
    twitter,
    discord,
    telegram,
    methodology,
    pendingObjectPath,
    onSaved,
    onNotConnected,
    t,
  ]);

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {/* avatar */}
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profilePhoto")}
        </span>
        <div className="flex items-center gap-3">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-border bg-card">
            {photoUrl ? (
              <img
                src={photoUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <ImageUp className="h-5 w-5" />
              </div>
            )}
            {uploading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="h-8 w-fit rounded-md border border-border px-3 text-xs hover:bg-card disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("bunny.profilePhotoUploading")}
                </>
              ) : (
                <>
                  <ImageUp className="h-3.5 w-3.5" />
                  {photoUrl
                    ? t("bunny.profilePhotoChange")
                    : t("bunny.profilePhotoAdd")}
                </>
              )}
            </button>
            <span className="text-[10px] text-muted-foreground">
              {t("bunny.profilePhotoHint")}
            </span>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => void onPickFile(e)}
        />
      </div>

      {/* name */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileName")}
        </span>
        <input
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("bunny.profileNamePlaceholder")}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
        />
      </label>

      {/* description */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileBio")}
        </span>
        <textarea
          value={bio}
          maxLength={600}
          rows={3}
          onChange={(e) => setBio(e.target.value)}
          placeholder={t("bunny.profileBioPlaceholder")}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none resize-none"
        />
      </label>

      {/* methodology */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileMethodology")}
        </span>
        <select
          value={methodology}
          onChange={(e) =>
            setMethodology(e.target.value as BunnyMethodology | "")
          }
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
        >
          <option value="">{t("bunny.profileMethodologyNone")}</option>
          {BUNNY_METHODOLOGIES.map((m) => (
            <option key={m} value={m}>
              {t(`bunny.methodology.${m}`)}
            </option>
          ))}
        </select>
      </label>

      {/* twitter */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileTwitter")}
        </span>
        <input
          type="text"
          value={twitter}
          maxLength={120}
          onChange={(e) => setTwitter(e.target.value)}
          placeholder="@handle"
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
        />
      </label>

      {/* discord */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileDiscord")}
        </span>
        <input
          type="text"
          value={discord}
          maxLength={2048}
          onChange={(e) => setDiscord(e.target.value)}
          placeholder="https://discord.gg/…"
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
        />
      </label>

      {/* telegram */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileTelegram")}
        </span>
        <input
          type="text"
          value={telegram}
          maxLength={2048}
          onChange={(e) => setTelegram(e.target.value)}
          placeholder="https://t.me/…"
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
        />
      </label>

      {/* website */}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.profileWebsite")}
        </span>
        <input
          type="text"
          value={website}
          maxLength={2048}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://…"
          className="h-9 rounded-md border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
        />
      </label>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 px-3 rounded-md border border-border text-sm hover:bg-card"
        >
          {cancelLabel ?? t("bunny.profileCancel")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="h-9 px-3 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/90 disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saveLabel ?? t("bunny.profileSave")}
        </button>
      </div>
    </div>
  );
}

function BunnyProfileModal({
  bunnyId,
  profile,
  t,
  onClose,
  onSaved,
  onNotConnected,
}: {
  bunnyId: number;
  profile: BunnyProfile | null;
  t: TFn;
  onClose: () => void;
  onSaved: (p: BunnyProfile) => void;
  onNotConnected: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-mono text-sm font-medium lowercase">
              {profile ? t("bunny.profileEditTitle") : t("bunny.profileCreateTitle")}
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("bunny.profileSubtitle", { id: String(bunnyId) })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <BunnyProfileForm
          bunnyId={bunnyId}
          profile={profile}
          t={t}
          onSaved={onSaved}
          onNotConnected={onNotConnected}
          onCancel={onClose}
        />
      </motion.div>
    </div>
  );
}

// ---- bunnyOS programmatic API keys --------------------------------------
// Self-service management of the user's bunnyEX `x-api-key` credentials. The
// minted secret is shown exactly once (create/regenerate) in a copyable panel
// and never refetched or cached. The whole section is gated behind a connected
// bunnyOS session; a 401 from any call flips the user back to "not connected"
// and surfaces the existing connect flow.

interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  revokedAt: string | null;
  revoked: boolean;
}
interface ApiKeyWithSecret extends ApiKeyMeta {
  key: string;
}

function CopyButton({ value, t }: { value: string; t: TFn }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value)?.then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-card"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? t("bunny.apiKeysCopied") : t("bunny.apiKeysCopy")}
    </button>
  );
}

// One-time secret reveal. Shown after create/regenerate; the secret lives only
// in this component's props and is dropped the moment it's dismissed.
function ApiKeySecretPanel({
  secret,
  onDismiss,
  t,
}: {
  secret: ApiKeyWithSecret;
  onDismiss: () => void;
  t: TFn;
}) {
  return (
    <div className="rounded-md border border-accent/50 bg-accent/5 p-3">
      <div className="flex items-center gap-2 font-mono text-xs">
        <KeyRound className="h-3.5 w-3.5 text-accent" />
        {t("bunny.apiKeysSecretTitle")}
        {secret.name ? ` · ${secret.name}` : ""}
      </div>
      <p className="mt-1 text-[11px] text-destructive">
        {t("bunny.apiKeysSecretWarning")}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-background/60 px-2 py-1.5 font-mono text-[11px]">
          {secret.key}
        </code>
        <CopyButton value={secret.key} t={t} />
      </div>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          className="h-7 rounded-md border border-border px-3 text-[11px] hover:bg-card"
        >
          {t("bunny.apiKeysSecretDone")}
        </button>
      </div>
    </div>
  );
}

function toLocalDateTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local wants local time without the timezone suffix.
  const off = d.getTime() - d.getTimezoneOffset() * 60000;
  return new Date(off).toISOString().slice(0, 16);
}

// A single key row: status badge, metadata, and inline rename/expiry edit plus
// regenerate and revoke actions.
function ApiKeyRow({
  apiKey,
  onChanged,
  onSecret,
  onNotConnected,
  t,
}: {
  apiKey: ApiKeyMeta;
  onChanged: () => void;
  onSecret: (s: ApiKeyWithSecret) => void;
  onNotConnected: () => void;
  t: TFn;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(apiKey.name);
  const [expiry, setExpiry] = useState(toLocalDateTimeInput(apiKey.expiresAt));
  const [busy, setBusy] = useState<null | "save" | "revoke" | "regen">(null);
  const [error, setError] = useState<string | null>(null);

  const status = apiKey.revoked
    ? { label: t("bunny.apiKeysStatusRevoked"), cls: "border-destructive/40 text-destructive" }
    : apiKey.expired
      ? { label: t("bunny.apiKeysStatusExpired"), cls: "border-border text-muted-foreground" }
      : { label: t("bunny.apiKeysStatusActive"), cls: "border-accent/50 text-accent" };
  const inactive = apiKey.revoked || apiKey.expired;

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("bunny.apiKeysNameRequired"));
      return;
    }
    let expiresAt: string | null = null;
    if (expiry.trim()) {
      const ms = Date.parse(expiry);
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        setError(t("bunny.apiKeysExpiryInvalid"));
        return;
      }
      expiresAt = new Date(ms).toISOString();
    }
    setBusy("save");
    setError(null);
    try {
      const r = await fetch(
        `/api/bunny/bunnyos/api-keys/${encodeURIComponent(apiKey.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          ...FETCH_OPTS,
          body: JSON.stringify({ name: trimmed, expiresAt }),
        },
      );
      if (r.status === 401) {
        onNotConnected();
        return;
      }
      if (!r.ok) {
        setError(t("bunny.apiKeysUpdateError"));
        return;
      }
      setEditing(false);
      onChanged();
    } catch {
      setError(t("bunny.apiKeysUpdateError"));
    } finally {
      setBusy(null);
    }
  }, [apiKey.id, name, expiry, onChanged, onNotConnected, t]);

  const revoke = useCallback(async () => {
    if (!window.confirm(t("bunny.apiKeysRevokeConfirm"))) return;
    setBusy("revoke");
    setError(null);
    try {
      const r = await fetch(
        `/api/bunny/bunnyos/api-keys/${encodeURIComponent(apiKey.id)}/revoke`,
        { method: "POST", ...FETCH_OPTS },
      );
      if (r.status === 401) {
        onNotConnected();
        return;
      }
      if (!r.ok) {
        setError(t("bunny.apiKeysRevokeError"));
        return;
      }
      onChanged();
    } catch {
      setError(t("bunny.apiKeysRevokeError"));
    } finally {
      setBusy(null);
    }
  }, [apiKey.id, onChanged, onNotConnected, t]);

  const regenerate = useCallback(async () => {
    if (!window.confirm(t("bunny.apiKeysRegenerateConfirm"))) return;
    setBusy("regen");
    setError(null);
    try {
      const r = await fetch(
        `/api/bunny/bunnyos/api-keys/${encodeURIComponent(apiKey.id)}/regenerate`,
        { method: "POST", ...FETCH_OPTS },
      );
      if (r.status === 401) {
        onNotConnected();
        return;
      }
      if (!r.ok) {
        setError(t("bunny.apiKeysRegenerateError"));
        return;
      }
      const j = (await r.json()) as { key: ApiKeyWithSecret };
      onSecret(j.key);
      onChanged();
    } catch {
      setError(t("bunny.apiKeysRegenerateError"));
    } finally {
      setBusy(null);
    }
  }, [apiKey.id, onChanged, onSecret, onNotConnected, t]);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-background/40 p-3",
        inactive && "opacity-70",
      )}
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("bunny.apiKeysNamePlaceholder")}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          />
          <div>
            <label className="text-[11px] text-muted-foreground">
              {t("bunny.apiKeysExpiry")}
            </label>
            <input
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
            />
          </div>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy === "save"}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-3 text-[11px] font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {busy === "save" && <Loader2 className="h-3 w-3 animate-spin" />}
              {busy === "save" ? t("bunny.apiKeysSaving") : t("bunny.apiKeysSave")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(apiKey.name);
                setExpiry(toLocalDateTimeInput(apiKey.expiresAt));
                setError(null);
              }}
              className="h-7 rounded-md border border-border px-3 text-[11px] hover:bg-card"
            >
              {t("bunny.apiKeysCancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-sm">{apiKey.name}</span>
                <span
                  className={cn(
                    "shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    status.cls,
                  )}
                >
                  {status.label}
                </span>
              </div>
              {apiKey.prefix && (
                <code className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                  {apiKey.prefix}…
                </code>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {apiKey.createdAt && (
              <span>{t("bunny.apiKeysCreated", { date: fmtTime(apiKey.createdAt) })}</span>
            )}
            <span>
              {apiKey.lastUsedAt
                ? t("bunny.apiKeysLastUsed", { date: fmtTime(apiKey.lastUsedAt) })
                : t("bunny.apiKeysNeverUsed")}
            </span>
            <span>
              {apiKey.expiresAt
                ? t("bunny.apiKeysExpires", { date: fmtTime(apiKey.expiresAt) })
                : t("bunny.apiKeysNeverExpires")}
            </span>
          </div>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {!apiKey.revoked && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[11px] hover:bg-card"
              >
                <Pencil className="h-3 w-3" />
                {t("bunny.apiKeysEdit")}
              </button>
              <button
                type="button"
                onClick={() => void regenerate()}
                disabled={busy === "regen"}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[11px] hover:bg-card disabled:opacity-50"
              >
                {busy === "regen" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCw className="h-3 w-3" />
                )}
                {busy === "regen" ? t("bunny.apiKeysRegenerating") : t("bunny.apiKeysRegenerate")}
              </button>
              <button
                type="button"
                onClick={() => void revoke()}
                disabled={busy === "revoke"}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-destructive/40 px-2.5 text-[11px] text-destructive hover:bg-destructive/5 disabled:opacity-50"
              >
                {busy === "revoke" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                {busy === "revoke" ? t("bunny.apiKeysRevoking") : t("bunny.apiKeysRevoke")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The create-key form: a name plus optional expiry. On success, the one-time
// secret is bubbled up via onSecret.
function ApiKeyCreateForm({
  onCreated,
  onSecret,
  onNotConnected,
  t,
}: {
  onCreated: () => void;
  onSecret: (s: ApiKeyWithSecret) => void;
  onNotConnected: () => void;
  t: TFn;
}) {
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("bunny.apiKeysNameRequired"));
      return;
    }
    let expiresAt: string | null = null;
    if (expiry.trim()) {
      const ms = Date.parse(expiry);
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        setError(t("bunny.apiKeysExpiryInvalid"));
        return;
      }
      expiresAt = new Date(ms).toISOString();
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/bunny/bunnyos/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...FETCH_OPTS,
        body: JSON.stringify({ name: trimmed, expiresAt }),
      });
      if (r.status === 401) {
        onNotConnected();
        return;
      }
      if (!r.ok) {
        setError(t("bunny.apiKeysCreateError"));
        return;
      }
      const j = (await r.json()) as { key: ApiKeyWithSecret };
      onSecret(j.key);
      setName("");
      setExpiry("");
      onCreated();
    } catch {
      setError(t("bunny.apiKeysCreateError"));
    } finally {
      setBusy(false);
    }
  }, [name, expiry, onCreated, onSecret, onNotConnected, t]);

  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="font-mono text-xs">{t("bunny.apiKeysCreateTitle")}</div>
      <div className="mt-2 flex flex-col gap-2">
        <div>
          <label className="text-[11px] text-muted-foreground">
            {t("bunny.apiKeysName")}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("bunny.apiKeysNamePlaceholder")}
            className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">
            {t("bunny.apiKeysExpiry")}
          </label>
          <input
            type="datetime-local"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("bunny.apiKeysExpiryHint")}
          </p>
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? t("bunny.apiKeysCreating") : t("bunny.apiKeysCreate")}
        </button>
      </div>
    </div>
  );
}

// Modal shell for the API-keys area. Loads the list, gates on connection, and
// owns the one-time secret reveal state.
function ApiKeysModal({
  connected,
  onConnected,
  onClose,
  t,
}: {
  connected: boolean;
  onConnected: () => void;
  onClose: () => void;
  t: TFn;
}) {
  const [keys, setKeys] = useState<ApiKeyMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jwtExpired, setJwtExpired] = useState(false);
  const [secret, setSecret] = useState<ApiKeyWithSecret | null>(null);

  const isConnected = connected && !jwtExpired;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/bunny/bunnyos/api-keys", {
        ...FETCH_OPTS,
        cache: "no-store",
      });
      if (!r.ok) {
        setError(t("bunny.apiKeysError"));
        return;
      }
      const j = (await r.json()) as { connected: boolean; keys: ApiKeyMeta[] };
      if (!j.connected) {
        setJwtExpired(true);
        return;
      }
      setKeys(j.keys ?? []);
    } catch {
      setError(t("bunny.apiKeysError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (isConnected) void load();
    else setLoading(false);
  }, [isConnected, load]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-mono text-sm font-medium lowercase">
              <KeyRound className="h-3.5 w-3.5 text-accent" />
              {t("bunny.apiKeysTitle")}
            </h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("bunny.apiKeysSubtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {!isConnected ? (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] text-muted-foreground">
                {t("bunny.apiKeysConnectPrompt")}
              </p>
              <BunnyOsConnect
                connected={false}
                onConnected={() => {
                  setJwtExpired(false);
                  onConnected();
                  void load();
                }}
                t={t}
              />
            </div>
          ) : (
            <>
              {secret && (
                <ApiKeySecretPanel
                  secret={secret}
                  onDismiss={() => setSecret(null)}
                  t={t}
                />
              )}

              <ApiKeyCreateForm
                onCreated={load}
                onSecret={setSecret}
                onNotConnected={() => setJwtExpired(true)}
                t={t}
              />

              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("bunny.apiKeysListLabel")}
              </div>

              {loading && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("bunny.apiKeysLoading")}
                </div>
              )}

              {error && !loading && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-center text-[11px]">
                  <div className="mb-2 text-destructive">{error}</div>
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="h-7 rounded-md border border-border px-3 text-[11px] hover:bg-card"
                  >
                    {t("bunny.retry")}
                  </button>
                </div>
              )}

              {!loading && !error && keys && keys.length === 0 && (
                <p className="py-4 text-center text-[11px] text-muted-foreground">
                  {t("bunny.apiKeysEmpty")}
                </p>
              )}

              {!loading && !error && keys && keys.length > 0 && (
                <div className="flex flex-col gap-2">
                  {keys.map((k) => (
                    <ApiKeyRow
                      key={k.id}
                      apiKey={k}
                      onChanged={load}
                      onSecret={setSecret}
                      onNotConnected={() => setJwtExpired(true)}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ---- bunnyOS connect (profile enrichment) -------------------------------
// Reuses the user's existing Base wallet session to sign a SIWE challenge and
// mint a bunnyOS JWT — no new wallet connection. Profiles are read anonymously
// and are purely additive, so this affordance only nudges; the list works fully
// without it. Connecting unlocks editing (bunnyOS `canEdit`) for owned bunnies.

type ConnectState =
  | { kind: "checking" }
  | { kind: "needsActivation" }
  | { kind: "activating"; url: string | null }
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "awaiting"; url: string; requestId: string | null }
  | { kind: "error"; message: string };

function BunnyOsConnect({
  connected,
  onConnected,
  t,
}: {
  connected: boolean;
  onConnected: () => void;
  t: TFn;
}) {
  const [state, setState] = useState<ConnectState>({ kind: "checking" });
  const pollRef = useRef<number | null>(null);
  const deployPollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
      if (deployPollRef.current !== null) window.clearTimeout(deployPollRef.current);
    };
  }, []);

  // On mount (and whenever we become disconnected), check whether the connected
  // Base wallet is deployed on-chain. A counterfactual Coinbase Smart Wallet
  // signs an ERC-6492 signature bunnyOS can't verify, so we surface an
  // "activate wallet" step before offering connect. Anything else (deployed
  // smart wallet, EOA, or no wallet yet) falls through to the normal connect.
  const checkStatus = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const r = await fetch("/api/bunny/bunnyos/wallet-status", {
        ...FETCH_OPTS,
      });
      if (!r.ok) {
        setState({ kind: "idle" });
        return;
      }
      const j = (await r.json()) as {
        hasWallet: boolean;
        deployed: boolean;
        address: string | null;
      };
      setState(
        j.hasWallet && !j.deployed
          ? { kind: "needsActivation" }
          : { kind: "idle" },
      );
    } catch {
      setState({ kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!connected) void checkStatus();
  }, [connected, checkStatus]);

  // After firing the activation transaction, poll wallet-status until the
  // wallet shows bytecode on-chain (deployment confirmed), then advance to the
  // normal connect step. ~2.5 min budget at 5s intervals.
  const pollDeploy = useCallback(
    (attempt: number) => {
      if (attempt > 30) {
        setState({ kind: "error", message: t("bunny.osTimeout") });
        return;
      }
      deployPollRef.current = window.setTimeout(() => {
        void (async () => {
          try {
            const r = await fetch("/api/bunny/bunnyos/wallet-status", {
              ...FETCH_OPTS,
            });
            if (r.ok) {
              const j = (await r.json()) as { deployed: boolean };
              if (j.deployed) {
                setState({ kind: "idle" });
                return;
              }
            }
            pollDeploy(attempt + 1);
          } catch {
            pollDeploy(attempt + 1);
          }
        })();
      }, 5000);
    },
    [t],
  );

  const activate = useCallback(async () => {
    setState({ kind: "activating", url: null });
    try {
      const r = await fetch("/api/bunny/bunnyos/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...FETCH_OPTS,
        body: "{}",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: j.error ?? t("bunny.osActivateError") });
        return;
      }
      const j = (await r.json()) as {
        alreadyDeployed: boolean;
        approvalUrl: string | null;
      };
      if (j.alreadyDeployed) {
        setState({ kind: "idle" });
        return;
      }
      if (!j.approvalUrl) {
        setState({ kind: "error", message: t("bunny.osNoApproval") });
        return;
      }
      openApprovalPopup(j.approvalUrl);
      setState({ kind: "activating", url: j.approvalUrl });
      pollDeploy(0);
    } catch {
      setState({ kind: "error", message: t("bunny.osActivateError") });
    }
  }, [pollDeploy, t]);

  const poll = useCallback(
    (requestId: string | null, attempt: number) => {
      // ~2.5 min budget at 5s intervals.
      if (attempt > 30) {
        setState({ kind: "error", message: t("bunny.osTimeout") });
        return;
      }
      pollRef.current = window.setTimeout(() => {
        void (async () => {
          try {
            const r = await fetch("/api/bunny/bunnyos/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              ...FETCH_OPTS,
              body: JSON.stringify(requestId ? { requestId } : {}),
            });
            if (!r.ok) {
              const j = (await r.json().catch(() => ({}))) as {
                error?: string;
                code?: string;
              };
              const message =
                j.code === "smart_wallet_undeployed"
                  ? t("bunny.osSmartWalletUndeployed")
                  : (j.error ?? t("bunny.osError"));
              setState({ kind: "error", message });
              return;
            }
            const j = (await r.json()) as { connected: boolean; pending: boolean };
            if (j.connected) {
              setState({ kind: "idle" });
              onConnected();
              return;
            }
            poll(requestId, attempt + 1);
          } catch {
            setState({ kind: "error", message: t("bunny.osError") });
          }
        })();
      }, 5000);
    },
    [onConnected, t],
  );

  const start = useCallback(async () => {
    setState({ kind: "starting" });
    try {
      const r = await fetch("/api/bunny/bunnyos/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...FETCH_OPTS,
        body: "{}",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: j.error ?? t("bunny.osError") });
        return;
      }
      const j = (await r.json()) as {
        approvalUrl: string | null;
        requestId: string | null;
      };
      if (!j.approvalUrl) {
        setState({ kind: "error", message: t("bunny.osNoApproval") });
        return;
      }
      openApprovalPopup(j.approvalUrl);
      setState({ kind: "awaiting", url: j.approvalUrl, requestId: j.requestId });
      poll(j.requestId, 0);
    } catch {
      setState({ kind: "error", message: t("bunny.osError") });
    }
  }, [poll, t]);

  if (connected) {
    return null;
  }

  // While the initial wallet-status check is in flight, render nothing to avoid
  // a button flicker between "activate" and "connect".
  if (state.kind === "checking") {
    return null;
  }

  // Smart wallet not yet deployed on Base: offer activation BEFORE connect.
  if (state.kind === "needsActivation" || state.kind === "activating") {
    const busy = state.kind === "activating";
    const url = state.kind === "activating" ? state.url : null;
    return (
      <div className="flex items-center gap-2 shrink-0">
        {busy && url && (
          <button
            type="button"
            onClick={() => openApprovalPopup(url)}
            className="h-9 px-3 rounded-md border border-border text-sm hover:bg-card"
          >
            {t("bunny.osReopen")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void activate()}
          disabled={busy}
          title={t("bunny.osActivateHint")}
          className="h-9 px-3 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/90 disabled:opacity-50 inline-flex items-center gap-2"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? t("bunny.osActivating") : t("bunny.osActivate")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {state.kind === "error" && (
        <span
          role="status"
          aria-live="polite"
          title={state.message}
          className="max-w-[10rem] truncate text-[11px] text-destructive"
        >
          {state.message}
        </span>
      )}
      {state.kind === "awaiting" && (
        <button
          type="button"
          onClick={() => openApprovalPopup(state.url)}
          className="h-9 px-3 rounded-md border border-border text-sm hover:bg-card"
        >
          {t("bunny.osReopen")}
        </button>
      )}
      <button
        type="button"
        onClick={() => void start()}
        disabled={state.kind === "starting" || state.kind === "awaiting"}
        title={state.kind === "error" ? state.message : undefined}
        className="h-9 px-3 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/90 disabled:opacity-50 inline-flex items-center gap-2"
      >
        {(state.kind === "starting" || state.kind === "awaiting") && (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
        {state.kind === "awaiting" ? t("bunny.osAwaiting") : t("bunny.osConnect")}
      </button>
    </div>
  );
}

// ---- add bunny flow -----------------------------------------------------
// A single guided flow to add a bunny, with two entry points:
//   1. create new  — launch a fresh bonding curve on-chain (registration fee +
//      optional initial keys), the existing contract flow.
//   2. register existing — pick an on-chain bunny the user already created that
//      has no bunnyOS profile yet.
// Either path advances to a shared registration step where the user fills in the
// bunnyOS profile (name/description/socials/methodology) saved via the existing
// PUT /api/bunny/:id/profile endpoint.

// Step 1a — create a fresh bonding curve owned by the caller. The contract
// charges a flat registration fee and grants a free, unsellable genesis key; an
// optional initial-keys buy is priced on top. Built as approve + createBunny
// calldata forwarded through Base MCP send_calls — same wallet-approval flow as
// a buy. Renders only the body; the flow shell provides overlay + header.
// `onConfirmed` fires once the create transaction resolves on-chain.
function CreateBunnyStep({
  config,
  onConfirmed,
  t,
}: {
  config: ExchangeConfig;
  onConfirmed: () => void;
  t: TFn;
}) {
  const [amount, setAmount] = useState(0);
  const [quote, setQuote] = useState<CreateQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const quoteSeq = useRef(0);

  // Debounced fresh quote for the current initial-keys amount (0 allowed).
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const seq = ++quoteSeq.current;
    const handle = setTimeout(async () => {
      try {
        const r = await fetch(`/api/bunny/create-quote?amount=${amount}`, {
          ...FETCH_OPTS,
          signal: ctrl.signal,
        });
        if (cancelled || seq !== quoteSeq.current) return;
        if (!r.ok) {
          setQuote(null);
          return;
        }
        const j = (await r.json()) as CreateQuote;
        if (cancelled || seq !== quoteSeq.current) return;
        setQuote(j);
      } catch (e) {
        // aborted requests are expected; drop a stale quote on real failures
        if (!cancelled && seq === quoteSeq.current && !(e instanceof DOMException && e.name === "AbortError")) {
          setQuote(null);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [amount]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setApprovalUrl(null);
    setSubmitted(false);
    try {
      const r = await fetch("/api/bunny/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...FETCH_OPTS,
        body: JSON.stringify({ additionalBuyAmount: String(amount) }),
      });
      if (r.status === 429) {
        setError(t("bunny.rateLimit"));
        return;
      }
      const j = (await r.json()) as Partial<TradeResponse> & { error?: string };
      if (!r.ok) {
        setError(j.error ?? t("bunny.createError"));
        return;
      }
      if (j.approvalUrl) setApprovalUrl(j.approvalUrl);
      else setSubmitted(true);
    } catch {
      setError(t("bunny.createError"));
    } finally {
      setBusy(false);
    }
  };

  const feePct = ((Number(config.feeBps) || 0) / (Number(config.bps) || 10000)) * 100;
  const slipPct = quote ? quote.slippageBps / 100 : 3;

  return (
    <div className="space-y-4 px-4 py-4">
      <div>
        <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {t("bunny.createInitialLabel")}
        </label>
        <input
          type="number"
          min={0}
          step={1}
          value={amount}
          onChange={(e) =>
            setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))
          }
          disabled={busy}
          className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          aria-label={t("bunny.createInitialLabel")}
        />
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
          {t("bunny.createInitialHint")}
        </p>
      </div>

      <dl className="space-y-2 rounded-md border border-border bg-background/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("bunny.createRegFee")}
          </dt>
          <dd className="font-mono text-sm truncate text-right">
            {quote ? `${fmtToken(quote.registrationFee)} ${config.tokenSymbol}` : "…"}
          </dd>
        </div>
        {amount > 0 && (
          <div className="flex items-center justify-between gap-3">
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("bunny.createBuyCost")}
            </dt>
            <dd className="font-mono text-sm truncate text-right">
              {quote ? `${fmtToken(quote.buyTotal)} ${config.tokenSymbol}` : "…"}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2">
          <dt className="font-mono text-[10px] uppercase tracking-widest text-foreground">
            {t("bunny.createTotal")}
          </dt>
          <dd className="font-mono text-base truncate text-right">
            {quote ? `${fmtToken(quote.grandTotal)} ${config.tokenSymbol}` : "…"}
          </dd>
        </div>
      </dl>

      <p className="font-mono text-[10px] text-muted-foreground">
        {t("bunny.createNote", {
          fee: String(Math.round(feePct * 100) / 100),
          slippage: String(Math.round(slipPct * 100) / 100),
        })}
      </p>

      {quote?.soldOut && (
        <div className="font-mono text-[11px] text-destructive">
          {t("bunny.createSoldOut")}
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={busy || Boolean(quote?.soldOut)}
        className="w-full h-9 rounded-md bg-accent text-accent-foreground text-xs font-medium uppercase tracking-widest hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? t("bunny.createBusy") : t("bunny.createSubmit")}
      </button>

      {error && <div className="font-mono text-[11px] text-destructive">{error}</div>}
      {submitted && !approvalUrl && (
        <div className="font-mono text-[11px] text-muted-foreground">
          {t("bunny.createDone")}
        </div>
      )}
      {approvalUrl && (
        <>
          <ApprovalRow url={approvalUrl} onConfirmed={onConfirmed} t={t} />
          <div className="font-mono text-[10px] text-center text-muted-foreground">
            {t("bunny.addCreateConfirmHint")}
          </div>
        </>
      )}
    </div>
  );
}

// Step 1b — pick one of the user's on-chain bunnies that has no bunnyOS profile
// yet. Reads GET /api/bunny/unregistered (creator == wallet, no profile). Empty
// and error states included; selecting a bunny advances to registration.
function RegisterExistingStep({
  onSelect,
  t,
}: {
  onSelect: (bunnyId: number) => void;
  t: TFn;
}) {
  const [bunnies, setBunnies] = useState<BunnyListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/bunny/unregistered", FETCH_OPTS);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? t("bunny.addSelectError"));
        return;
      }
      const j = (await r.json()) as { bunnies: BunnyListItem[] };
      setBunnies(j.bunnies);
    } catch {
      setError(t("bunny.addSelectError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-center text-[11px]">
          <div className="text-destructive">{error}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 h-8 px-3 rounded-md border border-border text-sm hover:bg-card"
          >
            {t("bunny.retry")}
          </button>
        </div>
      )}

      {!loading && !error && bunnies && bunnies.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("bunny.addSelectEmpty")}
        </p>
      )}

      {!loading && !error && bunnies && bunnies.length > 0 && (
        <>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {t("bunny.addSelectListLabel")}
          </p>
          <div className="flex flex-col gap-2">
            {bunnies.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onSelect(b.id)}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5 text-left hover:border-accent hover:bg-card"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm">{t("bunny.bunnyId", { id: String(b.id) })}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {t("bunny.addSelectSupply", { supply: b.supply })}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-accent">
                  {t("bunny.addSelectChoose")}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type AddBunnyStep =
  | { kind: "loading" }
  | { kind: "choice" }
  | { kind: "create" }
  | { kind: "select" }
  | { kind: "register"; bunnyId: number; profile: BunnyProfile | null };

function AddBunnyFlow({
  config,
  bunnyOsConnected,
  onReload,
  onClose,
  t,
}: {
  config: ExchangeConfig;
  bunnyOsConnected: boolean;
  onReload: () => void;
  onClose: () => void;
  t: TFn;
}) {
  const [step, setStep] = useState<AddBunnyStep>({ kind: "loading" });
  // Whether the user has any unregistered on-chain bunnies. Decided once on
  // mount: when there are none, "register existing" is pointless so we skip the
  // choice and open the create step directly; the choice (and the back button to
  // it) only appear when there's actually something to register.
  const [hasExisting, setHasExisting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // bunnyOS JWT can expire mid-flow even when the parent thought we were
  // connected; surface the connect step again when a save returns 401.
  const [jwtExpired, setJwtExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/bunny/unregistered", FETCH_OPTS);
        if (!r.ok) throw new Error();
        const j = (await r.json()) as { bunnies: BunnyListItem[] };
        if (cancelled) return;
        const has = j.bunnies.length > 0;
        setHasExisting(has);
        setStep(has ? { kind: "choice" } : { kind: "create" });
      } catch {
        // Can't tell (no wallet / network) — default to the primary action.
        if (cancelled) return;
        setHasExisting(false);
        setStep({ kind: "create" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // After the create tx confirms, the newly created bunny is the highest-id
  // bunny owned by the caller with no profile yet. Resolve it from the
  // unregistered endpoint and advance to the shared registration step.
  const advanceAfterCreate = useCallback(async () => {
    setResolving(true);
    setResolveError(null);
    try {
      const r = await fetch("/api/bunny/unregistered", FETCH_OPTS);
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { bunnies: BunnyListItem[] };
      const newest = j.bunnies.reduce<number>((m, b) => Math.max(m, b.id), -1);
      if (newest >= 0) {
        setStep({ kind: "register", bunnyId: newest, profile: null });
      } else {
        // Couldn't resolve (on-chain read lag) — refresh the list and close.
        onReload();
        onClose();
      }
    } catch {
      setResolveError(t("bunny.addResolveError"));
    } finally {
      setResolving(false);
    }
  }, [onClose, onReload, t]);

  const showConnect = step.kind === "register" && (!bunnyOsConnected || jwtExpired);

  let title: string;
  let subtitle: string;
  let canGoBack = false;
  if (step.kind === "loading" || step.kind === "choice") {
    title = t("bunny.addTitle");
    subtitle = t("bunny.addSubtitle");
  } else if (step.kind === "create") {
    title = t("bunny.createTitle");
    subtitle = t("bunny.createSubtitle");
    // Only offer "back" when the choice step is a meaningful destination.
    canGoBack = hasExisting;
  } else if (step.kind === "select") {
    title = t("bunny.addSelectTitle");
    subtitle = t("bunny.addSelectSubtitle");
    canGoBack = true;
  } else {
    title = t("bunny.addRegisterTitle");
    subtitle = t("bunny.profileSubtitle", { id: String(step.bunnyId) });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            {canGoBack && (
              <button
                type="button"
                onClick={() => setStep({ kind: "choice" })}
                aria-label={t("bunny.back")}
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="font-mono text-sm font-medium lowercase">{title}</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step.kind === "loading" && (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}

        {step.kind === "choice" && (
          <div className="flex flex-col gap-3 px-4 py-4">
            <button
              type="button"
              onClick={() => setStep({ kind: "create" })}
              className="rounded-md border border-border bg-background/40 px-4 py-3 text-left hover:border-accent hover:bg-card"
            >
              <div className="flex items-center gap-2 font-mono text-sm">
                <Plus className="h-3.5 w-3.5 text-accent" />
                {t("bunny.addCreateNewTitle")}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("bunny.addCreateNewDesc")}
              </p>
            </button>
            <button
              type="button"
              onClick={() => setStep({ kind: "select" })}
              className="rounded-md border border-border bg-background/40 px-4 py-3 text-left hover:border-accent hover:bg-card"
            >
              <div className="flex items-center gap-2 font-mono text-sm">
                <Check className="h-3.5 w-3.5 text-accent" />
                {t("bunny.addRegisterExistingTitle")}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("bunny.addRegisterExistingDesc")}
              </p>
            </button>
          </div>
        )}

        {step.kind === "create" && (
          <>
            <CreateBunnyStep config={config} onConfirmed={advanceAfterCreate} t={t} />
            {(resolving || resolveError) && (
              <div className="px-4 pb-4">
                {resolving && (
                  <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("bunny.addResolving")}
                  </div>
                )}
                {resolveError && (
                  <div className="text-center text-[11px] text-destructive">
                    {resolveError}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {step.kind === "select" && (
          <RegisterExistingStep
            onSelect={(bunnyId) => setStep({ kind: "register", bunnyId, profile: null })}
            t={t}
          />
        )}

        {step.kind === "register" &&
          (showConnect ? (
            <div className="flex flex-col gap-3 px-4 py-4">
              <p className="text-[11px] text-muted-foreground">
                {t("bunny.addConnectPrompt")}
              </p>
              <BunnyOsConnect
                connected={false}
                onConnected={() => {
                  setJwtExpired(false);
                  onReload();
                }}
                t={t}
              />
            </div>
          ) : (
            <BunnyProfileForm
              bunnyId={step.bunnyId}
              profile={step.profile}
              t={t}
              onSaved={() => {
                onReload();
                onClose();
              }}
              onNotConnected={() => setJwtExpired(true)}
              onCancel={onClose}
              saveLabel={t("bunny.addRegisterSubmit")}
            />
          ))}
      </motion.div>
    </div>
  );
}

// ---- view ---------------------------------------------------------------

export function BunnyExchangeView() {
  const t = useT();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Mobile master→detail navigation: the discover list and the selected bunny's
  // tabbed detail are separate screens on small viewports (both visible side by
  // side on lg+). Tapping a bunny opens the detail; the back arrow returns.
  const [mobileDetail, setMobileDetail] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/bunny/list", {
        ...FETCH_OPTS,
        // Bypass the browser's ETag/304 cache so a just-saved avatar/profile
        // edit shows on the card grid immediately instead of revalidating to a
        // stale cached list body.
        cache: "no-store",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? t("bunny.loadError"));
        return;
      }
      const j = (await r.json()) as ListResponse;
      setData(j);
      // Keep the current selection if still present, else select the first.
      const keep =
        selectedRef.current !== null &&
        j.bunnies.some((b) => b.id === selectedRef.current);
      if (!keep) setSelectedId(j.bunnies[0]?.id ?? null);
    } catch {
      setError(t("bunny.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = data?.bunnies.find((b) => b.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <PageHeader
        title={t("bunny.title")}
        subtitle={t("bunny.subtitle")}
        actions={
          <>
            {data && (
              <BunnyOsConnect
                connected={Boolean(data.bunnyos?.connected)}
                onConnected={load}
                t={t}
              />
            )}
            {data && (
              <button
                type="button"
                onClick={() => setApiKeysOpen(true)}
                className="shrink-0 h-9 px-3 rounded-md border border-border text-sm inline-flex items-center gap-2 hover:bg-card"
              >
                <KeyRound className="h-3.5 w-3.5" />
                {t("bunny.apiKeysCta")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="shrink-0 h-9 px-3 rounded-md border border-border text-sm inline-flex items-center gap-2 hover:bg-card disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              {t("bunny.refresh")}
            </button>
            {data && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="shrink-0 h-9 px-3 rounded-md border border-border bg-accent text-accent-foreground text-sm font-medium inline-flex items-center gap-2 hover:bg-accent/90"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("bunny.addCta")}
              </button>
            )}
          </>
        }
      />

      {addOpen && data && (
        <AddBunnyFlow
          config={data.config}
          bunnyOsConnected={Boolean(data.bunnyos?.connected)}
          onReload={load}
          onClose={() => setAddOpen(false)}
          t={t}
        />
      )}

      {apiKeysOpen && data && (
        <ApiKeysModal
          connected={Boolean(data.bunnyos?.connected)}
          onConnected={load}
          onClose={() => setApiKeysOpen(false)}
          t={t}
        />
      )}

      {/* states */}
      {loading && !data && (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}

      {error && (
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-center">
            <div className="text-destructive mb-2">{error}</div>
            <button
              type="button"
              onClick={() => void load()}
              className="h-8 px-3 rounded-md border border-border text-sm hover:bg-card"
            >
              {t("bunny.retry")}
            </button>
          </div>
        </div>
      )}

      {data && !error && data.bunnies.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("bunny.empty")}
        </div>
      )}

      {/* three distinct columns: discover · info · chart + trade */}
      {data && !error && data.bunnies.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {/* column 1: discover bunnies (hidden on mobile once a bunny is opened) */}
          <div
            className={cn(
              "shrink-0 flex-col border-b border-border/50 lg:flex lg:flex-1 lg:min-w-0 lg:overflow-y-auto lg:border-b-0 lg:border-r",
              mobileDetail ? "hidden" : "flex",
            )}
          >
            <div className="flex h-9 shrink-0 items-center border-b border-border/50 px-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("bunny.colDiscover")}
            </div>
            <div className="space-y-2 p-3">
              {data.bunnies.map((b) => (
                <BunnyCard
                  key={b.id}
                  bunny={b}
                  config={data.config}
                  selected={b.id === selectedId}
                  onSelect={() => {
                    setSelectedId(b.id);
                    setMobileDetail(true);
                  }}
                  t={t}
                  osPriceUsd={data.osPriceUsd}
                />
              ))}
            </div>
          </div>

          {/* columns 2 + 3: info, then chart + trade */}
          {selected ? (
            <TradePanel
              key={selected.id}
              bunny={selected}
              config={data.config}
              t={t}
              onTraded={load}
              isAdmin={data.isAdmin === true}
              mobileActive={mobileDetail}
              onBack={() => setMobileDetail(false)}
              osPriceUsd={data.osPriceUsd}
            />
          ) : (
            <div className="hidden min-h-0 flex-1 items-center justify-center p-10 text-center text-sm text-muted-foreground lg:flex">
              {t("bunny.selectPrompt")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
