import {
  pgTable,
  uuid,
  bigint,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Cross-instance claim ledger for Telegram updates. Before any process replies
// to a Telegram message it atomically claims that update's id here (INSERT ...
// ON CONFLICT DO NOTHING). Only the winner replies, so when dev + the deployed
// app (or multiple autoscale instances) poll the same bot token from the shared
// DB, each message is answered exactly once. Old rows are pruned on a timer.
export const telegramProcessedUpdatesTable = pgTable(
  "telegram_processed_updates",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.updateId] })],
);

export type TelegramProcessedUpdate =
  typeof telegramProcessedUpdatesTable.$inferSelect;
export type InsertTelegramProcessedUpdate =
  typeof telegramProcessedUpdatesTable.$inferInsert;
