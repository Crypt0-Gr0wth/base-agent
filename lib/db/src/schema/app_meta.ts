import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Tiny global key/value store for one-time, app-wide migrations and flags that
// are not scoped to any single user. Used as a durable "has this run?" guard so
// boot-time data fixups (e.g. a one-shot force-disable of native actions) run
// exactly once and don't fight a user's later toggle on every restart.
export const appMetaTable = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppMeta = typeof appMetaTable.$inferSelect;
export type InsertAppMeta = typeof appMetaTable.$inferInsert;
