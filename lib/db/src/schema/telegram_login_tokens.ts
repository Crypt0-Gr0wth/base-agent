import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Single-use ledger for Telegram one-tap Base login links. Each login token
// carries a random jti; the first time its link is opened we INSERT the jti
// here (ON CONFLICT DO NOTHING), so a reused/replayed link finds the row
// already present and is rejected. Shared DB → works across instances. Rows
// are pruned on a timer (tokens expire in minutes; an hour of retention more
// than covers the redirect round-trip).
export const telegramLoginTokensTable = pgTable("telegram_login_tokens", {
  jti: text("jti").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TelegramLoginToken = typeof telegramLoginTokensTable.$inferSelect;
export type InsertTelegramLoginToken =
  typeof telegramLoginTokensTable.$inferInsert;
