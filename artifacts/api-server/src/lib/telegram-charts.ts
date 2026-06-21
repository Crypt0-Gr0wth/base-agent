import { Resvg } from "@resvg/resvg-js";
import { logger } from "./logger";
import type { ToolInvocation } from "./bunny-agent";
import { parseToolContent } from "./toon";

// Auto-charting for the Telegram bot. Given the tool calls bunny executed during
// a run, we parse each tool result as JSON and recursively look for two generic,
// tool-agnostic shapes:
//   1. a time series  → line chart  (price history, TVL/APY over time, …)
//   2. a category set → bar chart   (portfolio holdings, top markets, …)
// Anything that matches is hand-rendered to an SVG and rasterized to PNG locally
// (no external chart service — keeps already-fetched market data in-house). The
// whole module is best-effort: every entry point swallows errors and falls back
// to "no charts" so a malformed tool result can never break the text reply.

const MAX_CHARTS = 2;
const W = 900;
const H = 460;
const PAD = { top: 64, right: 36, bottom: 64, left: 84 };

// Theme — bunnyOS dark.
const BG = "#0b0b0f";
const PANEL = "#14141b";
const GRID = "#26262f";
const TEXT = "#e7e7ea";
const MUTED = "#8b8b96";
const ACCENT = "#a78bfa";
const ACCENT2 = "#f472b6";

const TIME_KEYS = new Set([
  "timestamp",
  "time",
  "date",
  "t",
  "ts",
  "unixtime",
  "datetime",
]);
// Numeric value to plot against time, in rough priority order.
const SERIES_VALUE_KEYS = [
  "price",
  "value",
  "close",
  "c",
  "tvl",
  "apy",
  "totalliquidityusd",
  "usd",
];
const LABEL_KEYS = ["symbol", "name", "label", "ticker", "coin", "token", "id"];
// Numeric magnitude for a category bar, in rough priority order.
const AMOUNT_KEYS = [
  "market_cap",
  "marketcap",
  "value_usd",
  "valueusd",
  "usd_value",
  "usdvalue",
  "balance_usd",
  "balanceusd",
  "total_value_usd",
  "usd",
  "tvl",
  "volume24h",
  "volume",
  "current_price",
  "price",
  "amount",
  "total",
  "value",
];

interface LineSpec {
  kind: "line";
  title: string;
  source: string;
  usd: boolean;
  points: { x: number; y: number }[];
}
interface BarSpec {
  kind: "bar";
  title: string;
  source: string;
  usd: boolean;
  bars: { label: string; value: number }[];
}
type ChartSpec = LineSpec | BarSpec;

// Does this metric key represent a USD amount? Used to pick $ vs plain number
// formatting. APY/percentage-ish keys are explicitly not USD.
function isUsdKey(k: string): boolean {
  const n = lc(k);
  if (n.includes("apy") || n.includes("apr") || n.includes("percent")) return false;
  return /usd|price|cap|tvl|volume|liquidity|value|close|c$/.test(n) || n === "c";
}

function lc(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Parse a time-ish field to an epoch-ms number, or null. Accepts numeric epochs
// (seconds or ms) and ISO/date strings.
function asTime(v: unknown): number | null {
  const n = asNumber(v);
  if (n !== null) {
    // Heuristic: < 1e12 is almost certainly seconds, scale to ms.
    return n < 1e12 ? n * 1000 : n;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function findKey(obj: Record<string, unknown>, wanted: Set<string>): string | null {
  for (const k of Object.keys(obj)) if (wanted.has(lc(k))) return k;
  return null;
}

function findFirstKey(
  obj: Record<string, unknown>,
  ordered: string[],
): string | null {
  const map = new Map(Object.keys(obj).map((k) => [lc(k), k]));
  for (const want of ordered) {
    const hit = map.get(want);
    if (hit) return hit;
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function prettyTitle(s: string): string {
  const after = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
  const cleaned = after.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "chart";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Try to read an array as a time series of {x: epochMs, y: value}. Returns the
// plotted value key too (null for pair arrays) so callers can pick formatting.
function asLinePoints(
  arr: unknown[],
): { points: { x: number; y: number }[]; valueKey: string | null } | null {
  const pts: { x: number; y: number }[] = [];
  let valueKey: string | null = null;
  // array-of-pairs: [[ts, value], …]. The x column has no named key to vouch
  // for it, so require every x to land in a plausible epoch window (~2001 →
  // ~1yr ahead) — otherwise a generic [number, number] array would be charted
  // as a time series with garbage dates.
  if (Array.isArray(arr[0]) && (arr[0] as unknown[]).length >= 2) {
    const minEpoch = 1_000_000_000_000; // ~2001-09 in ms
    const maxEpoch = Date.now() + 366 * 24 * 60 * 60 * 1000;
    for (const row of arr) {
      if (!Array.isArray(row) || row.length < 2) return null;
      const x = asTime(row[0]);
      const y = asNumber(row[1]);
      if (x === null || y === null) return null;
      if (x < minEpoch || x > maxEpoch) return null;
      pts.push({ x, y });
    }
  } else if (isObj(arr[0])) {
    const sample = arr[0];
    const tk = findKey(sample, TIME_KEYS);
    const vk = findFirstKey(sample, SERIES_VALUE_KEYS);
    if (!tk || !vk) return null;
    valueKey = vk;
    for (const row of arr) {
      if (!isObj(row)) return null;
      const x = asTime(row[tk]);
      const y = asNumber(row[vk]);
      if (x === null || y === null) return null;
      pts.push({ x, y });
    }
  } else {
    return null;
  }
  if (pts.length < 5) return null;
  pts.sort((a, b) => a.x - b.x);
  return { points: pts, valueKey };
}

// Try to read an array as a category breakdown of {label, value}. Returns the
// chosen amount key too so callers can title / format from it.
function asBars(
  arr: unknown[],
): { bars: { label: string; value: number }[]; amountKey: string } | null {
  if (!isObj(arr[0])) return null;
  const sample = arr[0];
  const lk = findFirstKey(sample, LABEL_KEYS);
  const ak = findFirstKey(sample, AMOUNT_KEYS);
  if (!lk || !ak) return null;
  const bars: { label: string; value: number }[] = [];
  for (const row of arr) {
    if (!isObj(row)) continue;
    const value = asNumber(row[ak]);
    const labelRaw = row[lk];
    const label =
      typeof labelRaw === "string" || typeof labelRaw === "number"
        ? String(labelRaw)
        : null;
    if (value === null || label === null || value <= 0) continue;
    bars.push({ label: label.slice(0, 14), value });
  }
  if (bars.length < 2) return null;
  bars.sort((a, b) => b.value - a.value);
  return { bars: bars.slice(0, 12), amountKey: ak };
}

// Recursively walk a parsed tool result collecting chart candidates. `keyHint`
// is the property name that led here, used to title the chart.
function collect(
  value: unknown,
  keyHint: string,
  source: string,
  depth: number,
  out: ChartSpec[],
): void {
  if (out.length >= MAX_CHARTS || depth > 6) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    const line = asLinePoints(value);
    if (line) {
      const title = prettyTitle(keyHint || line.valueKey || "price");
      const usd = line.valueKey ? isUsdKey(line.valueKey) : true;
      out.push({ kind: "line", title, source, usd, points: line.points });
      return;
    }
    const bars = asBars(value);
    if (bars) {
      const title = prettyTitle(keyHint || bars.amountKey || "breakdown");
      out.push({
        kind: "bar",
        title,
        source,
        usd: isUsdKey(bars.amountKey),
        bars: bars.bars,
      });
      return;
    }
    // Not directly chartable — descend into object elements (e.g. nested data).
    for (const item of value) {
      if (out.length >= MAX_CHARTS) return;
      if (isObj(item)) collect(item, keyHint, source, depth + 1, out);
    }
    return;
  }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (out.length >= MAX_CHARTS) return;
      collect(v, k, source, depth + 1, out);
    }
  }
}

// Map a raw tool name to a short human label for captions / activity lines.
export function friendlyToolLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("portfolio")) return "portfolio";
  if (n.includes("wallet_tokens")) return "wallet tokens";
  if (n.includes("wallet_history")) return "wallet history";
  if (n.includes("wallet")) return "wallet";
  if (n.includes("prices_chart") || n.includes("pool_chart")) return "price history";
  if (n.includes("markets")) return "markets";
  if (n.includes("trending")) return "trending tokens";
  if (n.includes("token_price") || n === "coingecko_price") return "price";
  if (n.includes("holders")) return "holders";
  if (n.includes("protocols") || n.includes("protocol")) return "protocols";
  if (n.includes("pools") || n.includes("pool")) return "pools";
  if (n.includes("stablecoins")) return "stablecoins";
  if (n.includes("global")) return "market overview";
  if (n.includes("search")) return "token search";
  if (n.includes("security")) return "security";
  // Fallback: drop the lib prefix and prettify.
  const tail = name.replace(/^[a-z]+_/, "").replace(/_/g, " ");
  return tail || name;
}

// ---- SVG rendering -------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(2)}`;
}

function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function frame(title: string, source: string, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="20" fill="${BG}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="16" fill="${PANEL}"/>
  <text x="${PAD.left}" y="40" fill="${TEXT}" font-family="Arial, sans-serif" font-size="24" font-weight="700">${esc(title)}</text>
  <text x="${W - PAD.right}" y="40" fill="${MUTED}" font-family="Arial, sans-serif" font-size="14" text-anchor="end">🐰 bunnyOS · ${esc(source)}</text>
  ${inner}
</svg>`;
}

function renderLine(spec: LineSpec): string {
  const { points } = spec;
  const x0 = PAD.left;
  const x1 = W - PAD.right;
  const y0 = PAD.top;
  const y1 = H - PAD.bottom;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || Math.abs(maxY) || 1;
  const sx = (x: number): number => x0 + ((x - minX) / spanX) * (x1 - x0);
  const sy = (y: number): number => y1 - ((y - minY) / spanY) * (y1 - y0);

  const fmtY = spec.usd ? fmtUsd : fmtNum;
  let gridlines = "";
  let yLabels = "";
  const ROWS = 4;
  for (let i = 0; i <= ROWS; i++) {
    const gy = y0 + ((y1 - y0) * i) / ROWS;
    const val = maxY - (spanY * i) / ROWS;
    gridlines += `<line x1="${x0}" y1="${gy}" x2="${x1}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>`;
    yLabels += `<text x="${x0 - 12}" y="${gy + 4}" fill="${MUTED}" font-family="Arial, sans-serif" font-size="13" text-anchor="end">${esc(fmtY(val))}</text>`;
  }

  const path = points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const area = `${x0},${y1} ${path} ${x1},${y1}`;
  const up = (points[points.length - 1]?.y ?? 0) >= (points[0]?.y ?? 0);
  const stroke = up ? "#34d399" : ACCENT2;

  const xLabels =
    `<text x="${x0}" y="${y1 + 28}" fill="${MUTED}" font-family="Arial, sans-serif" font-size="13" text-anchor="start">${esc(fmtDate(minX))}</text>` +
    `<text x="${x1}" y="${y1 + 28}" fill="${MUTED}" font-family="Arial, sans-serif" font-size="13" text-anchor="end">${esc(fmtDate(maxX))}</text>`;

  const last = points[points.length - 1];
  const lastDot = last
    ? `<circle cx="${sx(last.x).toFixed(1)}" cy="${sy(last.y).toFixed(1)}" r="5" fill="${stroke}"/>`
    : "";

  const inner = `
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${stroke}" stop-opacity="0.30"/>
    <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
  </linearGradient></defs>
  ${gridlines}
  <polygon points="${area}" fill="url(#g)"/>
  <polyline points="${path}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${lastDot}
  ${yLabels}
  ${xLabels}`;
  return frame(spec.title, spec.source, inner);
}

function renderBar(spec: BarSpec): string {
  const { bars } = spec;
  const x0 = PAD.left;
  const x1 = W - PAD.right;
  const y0 = PAD.top;
  const y1 = H - PAD.bottom;
  const maxV = Math.max(...bars.map((b) => b.value)) || 1;
  const n = bars.length;
  const slot = (x1 - x0) / n;
  const bw = Math.min(slot * 0.62, 70);
  const usd = spec.usd;

  let body = "";
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (!b) continue;
    const cx = x0 + slot * i + slot / 2;
    const h = ((b.value / maxV) * (y1 - y0));
    const by = y1 - h;
    const color = i % 2 === 0 ? ACCENT : ACCENT2;
    body += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="${color}"/>`;
    body += `<text x="${cx.toFixed(1)}" y="${(by - 8).toFixed(1)}" fill="${TEXT}" font-family="Arial, sans-serif" font-size="13" text-anchor="middle">${esc(usd ? fmtUsd(b.value) : fmtNum(b.value))}</text>`;
    body += `<text x="${cx.toFixed(1)}" y="${(y1 + 22).toFixed(1)}" fill="${MUTED}" font-family="Arial, sans-serif" font-size="13" text-anchor="middle">${esc(b.label)}</text>`;
  }
  const baseline = `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${GRID}" stroke-width="1.5"/>`;
  return frame(spec.title, spec.source, baseline + body);
}

function toSvg(spec: ChartSpec): string {
  return spec.kind === "line" ? renderLine(spec) : renderBar(spec);
}

export interface RenderedChart {
  png: Uint8Array;
  caption: string;
}

// Detect + render charts from a run's tool invocations. Never throws.
export function renderChartsFromTools(
  invocations: ToolInvocation[],
): RenderedChart[] {
  const specs: ChartSpec[] = [];
  try {
    for (const inv of invocations) {
      if (specs.length >= MAX_CHARTS) break;
      if (inv.isError || !inv.result) continue;
      let parsed: unknown;
      try {
        parsed = parseToolContent(inv.result);
      } catch {
        continue; // non-structured tool result (plain text) — nothing to chart
      }
      const source = friendlyToolLabel(inv.name);
      collect(parsed, "", source, 0, specs);
    }
  } catch (err) {
    logger.warn({ err }, "telegram chart detection failed");
    return [];
  }

  const out: RenderedChart[] = [];
  for (const spec of specs) {
    try {
      const svg = toSvg(spec);
      const png = new Resvg(svg, {
        background: BG,
        fitTo: { mode: "width", value: W },
      })
        .render()
        .asPng();
      out.push({
        png,
        caption: `📊 <b>${esc(spec.title)}</b> · <i>${esc(spec.source)}</i>`,
      });
    } catch (err) {
      logger.warn({ err, title: spec.title }, "telegram chart render failed");
    }
  }
  return out;
}
