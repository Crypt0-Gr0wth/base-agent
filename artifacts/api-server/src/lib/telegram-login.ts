import { db, telegramLoginTokensTable } from "@workspace/db";
import { lt, sql } from "drizzle-orm";
import { logger } from "./logger";

// Single-use enforcement for the Telegram one-tap Base login link. The token
// itself is HMAC-signed + short-lived (lib/session.ts); this adds replay
// protection by recording each jti the first time its link is opened. INSERT
// ... ON CONFLICT DO NOTHING RETURNING returns a row only to the first opener,
// so a reused link is rejected. Throws on DB error — the caller fails CLOSED
// (rejects the login) so a leaked link can't be replayed during a DB blip; the
// user just taps /connect again for a fresh link.
export async function consumeLoginJti(jti: string): Promise<boolean> {
  const won = await db
    .insert(telegramLoginTokensTable)
    .values({ jti })
    .onConflictDoNothing()
    .returning({ jti: telegramLoginTokensTable.jti });
  return won.length > 0;
}

let lastPrune = 0;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

// Drop jti rows older than an hour so the ledger doesn't grow without bound.
// Tokens expire in minutes, so an hour of retention safely covers the
// landing → Base → callback round-trip. Throttled; never throws.
export async function pruneLoginTokens(): Promise<void> {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  try {
    await db
      .delete(telegramLoginTokensTable)
      .where(
        lt(telegramLoginTokensTable.createdAt, sql`now() - interval '1 hour'`),
      );
  } catch (err) {
    logger.warn({ err }, "telegram: login token prune failed");
  }
}
