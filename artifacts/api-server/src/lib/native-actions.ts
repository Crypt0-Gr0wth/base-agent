// The "starter pack" of native actions, shipped in code and seeded per user.
//
// These are the source of truth for the native (built-in) actions. They are
// upserted into each user's `workflows` rows with source="native" the first
// time we see that user in-process (see seedNativeWorkflows in lib/workflows).
// Re-seeding refreshes the definition fields (name/interval/instructions/tools)
// but never the user's enabled toggle, so toggling a native off sticks while
// definition tweaks shipped in a new release still land.
//
// intervalMs must be one of ALLOWED_INTERVALS_MS (see lib/workflows). We use the
// nearest sensible allowed cadence per action. toolAllowlist is left null (all
// enabled tools) — the runner's write-tool denylist already blocks execution,
// and a null allowlist avoids brittle exact tool-name matching across protocol
// toggles.

const H6 = 6 * 60 * 60_000;
const D1 = 24 * 60 * 60_000;

export interface NativeActionDef {
  // Stable key — used to derive the per-user row id (nv:<key>:<userId>) and to
  // re-match a seeded row to its code definition. Never change a key in place;
  // changing it orphans the old seeded row and creates a new one.
  key: string;
  name: string;
  intervalMs: number;
  instructions: string;
  toolAllowlist: string[] | null;
  // Whether this action is enabled the first time it is seeded for a user.
  // Defaults to true when omitted. Discovery/trade-suggesting actions ship off
  // so nothing runs against a wallet until the user opts in; the read-only
  // daily summary ships on. Re-seeds never touch a user's existing toggle.
  enabledByDefault?: boolean;
}

// The complete built-in action set. Keep this list small and focused: the three
// jobs a user actually wants out of the box — find yields, find trending tokens
// to buy on base, and a daily summary.
export const NATIVE_ACTIONS: NativeActionDef[] = [
  {
    key: "find-yields",
    name: "yield finder",
    intervalMs: D1,
    toolAllowlist: null,
    enabledByDefault: false,
    instructions:
      "compare my best current base position apy (from my wallet's defi positions via coinstats) against the top usdc yields on base from defi llama. if a base option's apy beats my current best by more than 1.5 percentage points, emit a SEPARATE recommendation for each such opportunity — one pool per recommendation — naming source and target and citing both apys. if i am holding idle (unlent) stablecoins worth more than 5% of my total wallet value, also recommend the single best risk-adjusted base supply market for them.",
  },
  {
    key: "trending-buys",
    name: "trending tokens",
    intervalMs: H6,
    toolAllowlist: null,
    enabledByDefault: false,
    instructions:
      "pull trending tokens on base via coingecko onchain. pick the strongest candidates worth considering as buys and emit a SEPARATE recommendation for each token — never combine multiple tokens into one recommendation — citing 24h volume and 24h price change. prefer tokens with healthy depth (liquidity at least 10% of 24h volume) and skip any where the token looks unverified or has thin liquidity. top 3 at most.",
  },
  {
    key: "daily-summary",
    name: "daily summary",
    intervalMs: D1,
    toolAllowlist: null,
    instructions:
      "once a day, pull my wallet portfolio (base mcp get_portfolio) and defi positions + pnl (coinstats) and post a single info alert summarizing total deployed value, weighted apy, unclaimed rewards, and net pnl with my best and worst position. info only — do not emit recommendations.",
  },
];
