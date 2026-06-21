import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

// Durable, cross-process response cache for bunnyOS data-gateway (bunnyDS)
// reads — CoinStats (incl. token security / Hexens risk), CoinGecko, and GMGN.
// A fresh row lets the server answer without re-hitting bunnyDS, which both
// speeds up repeat lookups and keeps us well under the gateway's rate limits.
// `cache_key` encodes provider + transport mode + the exact request, so gateway
// and bring-your-own-key traffic never share an entry. Only successful
// responses are stored. Expired rows are pruned on a timer.
export const apiCacheTable = pgTable(
  "api_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    expiresIdx: index("api_cache_expires_idx").on(t.expiresAt),
  }),
);

export type ApiCacheRow = typeof apiCacheTable.$inferSelect;
export type InsertApiCache = typeof apiCacheTable.$inferInsert;
