import { db, apiCacheTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";
import { logger } from "./logger";

// Durable response cache for bunnyOS data-gateway (bunnyDS) reads. Two layers:
//   1. an in-process map (hot path, also coalesces concurrent identical calls)
//   2. the `api_cache` Postgres table (survives restarts, shared across
//      instances) so a warm entry answers WITHOUT hitting bunnyDS at all.
//
// Only successful results are cached; errors stay immediately retryable. The
// caller owns the key (provider + transport mode + exact request) and the TTL.

export type CacheableResult = { content: string; isError: boolean };

const MEM_MAX = 1000;
const mem = new Map<string, { value: CacheableResult; expires: number }>();
const inflight = new Map<string, Promise<CacheableResult>>();

function pruneMem(): void {
  const now = Date.now();
  for (const [k, v] of mem) {
    if (v.expires <= now) mem.delete(k);
  }
  while (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

async function readDb(
  key: string,
): Promise<{ content: string; expiresAt: number } | null> {
  try {
    const rows = await db
      .select()
      .from(apiCacheTable)
      .where(eq(apiCacheTable.cacheKey, key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const expiresAt = row.expiresAt.getTime();
    if (expiresAt <= Date.now()) return null;
    return { content: row.value, expiresAt };
  } catch (err) {
    logger.warn({ err, key }, "api-cache db read failed");
    return null;
  }
}

async function writeDb(
  key: string,
  content: string,
  expiresAt: number,
): Promise<void> {
  try {
    await db
      .insert(apiCacheTable)
      .values({ cacheKey: key, value: content, expiresAt: new Date(expiresAt) })
      .onConflictDoUpdate({
        target: apiCacheTable.cacheKey,
        set: {
          value: content,
          expiresAt: new Date(expiresAt),
          createdAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err, key }, "api-cache db write failed");
  }
}

// Return a cached result for `key` if one is fresh (memory first, then DB),
// otherwise run `fetcher`, cache a successful result for `ttlMs`, and return it.
// Concurrent callers for the same key share a single in-flight fetch.
export async function withApiCache(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<CacheableResult>,
): Promise<CacheableResult> {
  const now = Date.now();
  const m = mem.get(key);
  if (m && m.expires > now) return m.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<CacheableResult> => {
    const dbHit = await readDb(key);
    if (dbHit) {
      const value: CacheableResult = { content: dbHit.content, isError: false };
      mem.set(key, { value, expires: dbHit.expiresAt });
      pruneMem();
      return value;
    }
    const result = await fetcher();
    if (!result.isError) {
      const expires = Date.now() + ttlMs;
      mem.set(key, { value: result, expires });
      pruneMem();
      await writeDb(key, result.content, expires);
    }
    return result;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

// Sweep expired DB rows so the table doesn't grow without bound. The in-memory
// layer self-prunes on write; this only handles the durable rows.
setInterval(
  () => {
    db.delete(apiCacheTable)
      .where(lt(apiCacheTable.expiresAt, new Date()))
      .catch((err) => logger.warn({ err }, "api-cache db prune failed"));
  },
  10 * 60 * 1000,
).unref();
