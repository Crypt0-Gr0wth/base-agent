import { logger } from "./logger";
import { callGmgnTool } from "./gmgn";
import { isProtocolEnabled } from "./settings";

// Contract-security enrichment for the token report, sourced from the GMGN
// Token Security endpoint (GET /v1/token/security). It returns a set of
// contract-safety signals — honeypot, blocked sells, blacklist, trading taxes,
// open-source/verified status, and ownership-renounced — which we normalize into
// a severity-ranked list of findings. GMGN does NOT expose a single 0-100 safety
// score, so `score` is always null here. This is NOT an agent tool (not in the
// dispatcher) — it's report enrichment only. It requires GMGN to be connected
// (bunnyDS gateway OR a user-supplied GMGN key) and the `gmgn` protocol enabled;
// when it isn't, lookups return null and the report simply omits the section.

export type Severity = "critical" | "high" | "medium" | "low" | "minor";

export interface SecurityFinding {
  key: string;
  title: string;
  note: string | null;
  description: string | null;
  severity: Severity;
}

export interface TokenSecurity {
  address: string;
  // GMGN has no single safety score, so this is always null (kept for shape
  // compatibility with downstream consumers).
  score: number | null;
  // GMGN has no "market endorsed" concept; always null.
  marketEndorsed: boolean | null;
  ownershipRenounced: boolean | null;
  // Only risks that are actually present, severity-ranked.
  findings: SecurityFinding[];
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  minor: 4,
};

// GMGN's token-security data object (the `data` envelope is already unwrapped by
// callGmgnTool). Fields are GoPlus-style: booleans plus parallel numeric flags
// where -1 / null means "unknown" (not a risk).
interface RawGmgnSecurity {
  address?: string;
  is_show_alert?: boolean;
  is_open_source?: boolean;
  open_source?: number;
  is_blacklist?: boolean | null;
  blacklist?: number;
  is_honeypot?: boolean;
  honeypot?: number;
  is_renounced?: boolean;
  renounced?: number;
  can_not_sell?: number;
  buy_tax?: string | number;
  sell_tax?: string | number;
  high_tax?: string | number;
  flags?: unknown;
}

// Truthy when the boolean is true OR the parallel numeric flag is exactly 1.
// A numeric -1 (or null/0) means unknown / not-a-risk and must NOT trip.
function flagged(b: unknown, n: unknown): boolean {
  if (b === true) return true;
  if (typeof n === "number" && n === 1) return true;
  return false;
}

// Ownership-renounced is a good signal, so resolve it explicitly to a tri-state.
function renouncedFrom(raw: RawGmgnSecurity): boolean | null {
  if (typeof raw.is_renounced === "boolean") return raw.is_renounced;
  if (raw.renounced === 1) return true;
  if (raw.renounced === 0) return false;
  return null;
}

// Taxes come back as decimal-ratio strings (0.05 = 5%). Returns the ratio or
// null when absent/unparseable.
function taxRatio(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function humanizeFlag(f: string): string {
  return f.replace(/[_-]+/g, " ").trim();
}

function normalize(address: string, raw: RawGmgnSecurity): TokenSecurity {
  const findings: SecurityFinding[] = [];
  const add = (key: string, title: string, severity: Severity): void => {
    findings.push({ key, title, note: null, description: null, severity });
  };

  if (flagged(raw.is_honeypot, raw.honeypot)) {
    add("honeypot", "honeypot — cannot sell after buying", "critical");
  }
  if (raw.can_not_sell === 1) {
    add("cannot_sell", "sells are blocked (honeypot-like)", "critical");
  }
  if (flagged(raw.is_blacklist, raw.blacklist)) {
    add("blacklist", "contract can blacklist holders", "high");
  }

  const tax = Math.max(
    taxRatio(raw.buy_tax) ?? 0,
    taxRatio(raw.sell_tax) ?? 0,
    taxRatio(raw.high_tax) ?? 0,
  );
  if (tax >= 0.5) {
    add("high_tax", `very high trading tax (~${Math.round(tax * 100)}%)`, "critical");
  } else if (tax >= 0.1) {
    add("high_tax", `high trading tax (~${Math.round(tax * 100)}%)`, "high");
  }

  if (raw.is_open_source === false || raw.open_source === 0) {
    add("not_open_source", "contract source not verified / open", "medium");
  }

  const ownershipRenounced = renouncedFrom(raw);
  if (ownershipRenounced === false) {
    add("not_renounced", "ownership not renounced", "medium");
  }

  // GMGN's own free-form risk tags (rare, but real signal when present).
  if (Array.isArray(raw.flags)) {
    for (const f of raw.flags) {
      if (typeof f === "string" && f.trim()) {
        add(`flag:${f}`, humanizeFlag(f), "medium");
      }
    }
  }

  // Generic alert only when nothing more specific was flagged, so we don't
  // double-count a risk we already named.
  if (raw.is_show_alert === true && findings.length === 0) {
    add("alert", "flagged by gmgn risk alert", "medium");
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    address,
    score: null,
    marketEndorsed: null,
    ownershipRenounced,
    findings,
  };
}

// True when GMGN actually returned a security record for the contract (vs. an
// empty / not-indexed payload).
function hasGmgnData(raw: unknown): raw is RawGmgnSecurity {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as RawGmgnSecurity;
  return (
    typeof r.is_open_source === "boolean" ||
    typeof r.open_source === "number" ||
    typeof r.is_honeypot === "boolean" ||
    typeof r.honeypot === "number" ||
    typeof r.is_renounced === "boolean" ||
    typeof r.renounced === "number" ||
    typeof r.is_blacklist === "boolean" ||
    typeof r.blacklist === "number" ||
    typeof r.can_not_sell === "number" ||
    typeof r.buy_tax === "string" ||
    typeof r.buy_tax === "number" ||
    typeof r.sell_tax === "string" ||
    typeof r.sell_tax === "number" ||
    typeof r.high_tax === "string" ||
    typeof r.high_tax === "number" ||
    typeof r.is_show_alert === "boolean" ||
    Array.isArray(r.flags)
  );
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: TokenSecurity | null }>();

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of cache) {
    if (v.at < cutoff) cache.delete(k);
  }
}, TTL_MS).unref();

// Returns normalized security info for a token, or null when GMGN has no data
// for the contract OR is not connected / the protocol is disabled. Never throws
// on "not configured" / upstream errors — those degrade to null so the report
// section just omits itself.
export async function getTokenSecurity(
  address: string,
  chain = "base",
): Promise<TokenSecurity | null> {
  let enabled = false;
  try {
    enabled = isProtocolEnabled("gmgn");
  } catch {
    enabled = false;
  }
  if (!enabled) return null;

  const cacheKey = `${chain}:${address.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const res = await callGmgnTool("gmgn_token_security", { chain, address });
  if (res.isError) {
    // Not configured or transient upstream error — treat as "no data" and do
    // NOT cache, so a later call retries once GMGN becomes available.
    logger.warn(
      { address, chain, detail: res.content.slice(0, 200) },
      "gmgn token-security unavailable",
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    logger.warn({ address, chain }, "gmgn token-security: invalid JSON");
    return null;
  }

  const data = hasGmgnData(parsed)
    ? normalize(address.toLowerCase(), parsed)
    : null;
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// Short, terminal-style block injected into the AI report prompt so the model
// can factor contract security into its risk assessment.
export function summarizeSecurity(s: TokenSecurity): string {
  const yn = (b: boolean | null): string =>
    b === null ? "unknown" : b ? "yes" : "no";
  const lines = [
    `security (gmgn):`,
    `- ownership renounced: ${yn(s.ownershipRenounced)}`,
  ];
  if (s.findings.length === 0) {
    lines.push(`- findings: none flagged`);
  } else {
    lines.push(`- findings (severity-ranked):`);
    for (const f of s.findings) {
      lines.push(`  - [${f.severity}] ${f.title}${f.note ? ` — ${f.note}` : ""}`);
    }
  }
  return lines.join("\n");
}

// Best-effort wrapper that never throws — for use in the report hot path where
// missing security data should not fail the whole report.
export async function getTokenSecuritySafe(
  address: string,
  chain = "base",
): Promise<TokenSecurity | null> {
  try {
    return await getTokenSecurity(address, chain);
  } catch (err) {
    logger.warn({ err, address }, "gmgn security lookup failed");
    return null;
  }
}
