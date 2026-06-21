import { formatUnits } from "viem";
import { getCurrentUserId, getCurrentUserWallet } from "./user";
import {
  fetchPortfolioPnl,
  fetchBunnyTransactions,
  BunnyOsNotConnectedError,
} from "./bunnyos";
import { getExchangeConfig } from "./bunny-exchange";
import { logger } from "./logger";

// Dynamic "live" half of the agent's memory: the user's connected wallet plus
// their most recent bunnyOS key trades. Injected into every prompt alongside
// the user-authored memory blob so the agent always knows who it's acting for
// and what they've been trading — without spending a tool call.
//
// Built per-request but cached per user (short TTL) so the chat hot path and the
// background scanner don't refetch the bunnyOS feeds on every message. Always
// returns a string; every fetch is best-effort and degrades to a "not
// connected / unavailable" note rather than throwing.

const TTL_MS = 3 * 60_000;
const MAX_BUNNIES = 6;
const MAX_TX = 10;
const PER_BUNNY_TX_LIMIT = 200;
// Hard ceiling so a slow/hung bunnyOS upstream can never stall prompt assembly
// (this runs on every chat message). On timeout we degrade to "unavailable".
const FETCH_TIMEOUT_MS = 4_000;

interface CacheEntry {
  text: string;
  at: number;
}
const cache = new Map<string, CacheEntry>();
// Coalesce concurrent cache misses for the same user (e.g. a chat message and a
// scanner pass landing together) so we don't run the bunnyOS fan-out twice.
const inflight = new Map<string, Promise<string>>();

class LiveContextTimeoutError extends Error {
  constructor() {
    super("live-context fetch timed out");
    this.name = "LiveContextTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LiveContextTimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function weiToToken(wei: string | null | undefined, decimals: number): string {
  if (wei == null) return "0";
  try {
    return formatUnits(BigInt(wei), decimals);
  } catch {
    return "0";
  }
}

interface UserTrade {
  bunnyId: string;
  side: "buy" | "sell";
  amount: string;
  price: string;
  tokenSymbol: string;
  createdAt: string;
}

async function recentTransactions(wallet: string): Promise<UserTrade[]> {
  const me = wallet.toLowerCase();
  const [config, pnl] = await Promise.all([
    getExchangeConfig(),
    fetchPortfolioPnl(),
  ]);
  const dec = config.tokenDecimals;
  // Only bunnies the user has actually traded (non-zero cost basis or balance);
  // cap the fan-out so we never make a request per bunny in the market.
  const held = pnl.bunnies
    .filter((b) => b.costBasis !== "0" || b.balance !== "0")
    .slice(0, MAX_BUNNIES);

  const perBunny = await Promise.all(
    held.map(async (b): Promise<UserTrade[]> => {
      try {
        const data = await fetchBunnyTransactions(b.bunnyId, {
          limit: PER_BUNNY_TX_LIMIT,
        });
        return data.transactions
          .filter((t) => t.trader.toLowerCase() === me)
          .map((t) => ({
            bunnyId: b.bunnyId,
            side: t.side.toLowerCase() === "sell" ? "sell" : "buy",
            amount: t.amount,
            price: weiToToken(t.total, dec),
            tokenSymbol: config.tokenSymbol,
            createdAt: t.timestamp,
          }));
      } catch {
        return [];
      }
    }),
  );

  return perBunny
    .flat()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_TX);
}

async function build(): Promise<string> {
  let wallet: string | null = null;
  try {
    wallet = await getCurrentUserWallet();
  } catch {
    wallet = null;
  }

  const lines: string[] = ["=== LIVE CONTEXT ===", ""];
  lines.push(wallet ? `Connected wallet: ${wallet}` : "Connected wallet: none");

  lines.push("");
  if (!wallet) {
    lines.push("Recent bunnyOS transactions: none (no connected wallet)");
  } else {
    try {
      const trades = await withTimeout(
        recentTransactions(wallet),
        FETCH_TIMEOUT_MS,
      );
      if (trades.length === 0) {
        lines.push("Recent bunnyOS transactions: none");
      } else {
        lines.push("Recent bunnyOS transactions (newest first):");
        for (const t of trades) {
          lines.push(
            `- ${t.createdAt} ${t.side} ${t.amount} key(s) of bunny #${t.bunnyId} for ${t.price} ${t.tokenSymbol}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof BunnyOsNotConnectedError) {
        lines.push("Recent bunnyOS transactions: none (bunnyOS not connected)");
      } else {
        logger.warn({ err }, "live-context: bunnyOS transactions fetch failed");
        lines.push(
          "Recent bunnyOS transactions: unavailable (could not reach bunnyOS)",
        );
      }
    }
  }

  lines.push("====================");
  return lines.join("\n") + "\n";
}

export async function getLiveContext(): Promise<string> {
  let uid: string;
  try {
    uid = getCurrentUserId();
  } catch {
    return "";
  }
  const now = Date.now();
  const hit = cache.get(uid);
  if (hit && now - hit.at < TTL_MS) return hit.text;

  // Coalesce concurrent misses for this user so the bunnyOS fan-out runs once.
  const pending = inflight.get(uid);
  if (pending) return pending;

  const work = (async () => {
    try {
      const text = await build();
      cache.set(uid, { text, at: Date.now() });
      pruneExpired();
      return text;
    } finally {
      inflight.delete(uid);
    }
  })();
  inflight.set(uid, work);
  return work;
}

// Drop stale cache rows so the map doesn't grow unbounded with every visitor.
function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= TTL_MS) cache.delete(key);
  }
}
