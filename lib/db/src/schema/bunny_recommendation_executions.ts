import { pgTable, uuid, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Per-user record that a from-bunnies recommendation has been executed. The
// from-bunnies feed lives in bunnyOS (not the local actions table), so "mark as
// done" can't flip a local row — instead we remember, per user, which
// recommendation inbox ids ("bunnyos:<actionId>") that user executed and filter
// them out of GET /api/bunny/recommendations. Execution itself just pastes the
// recommendation body into the chat composer.
export const bunnyRecommendationExecutionsTable = pgTable(
  "bunny_recommendation_executions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The inbox item id, "bunnyos:<actionId>".
    recommendationId: text("recommendation_id").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.recommendationId] })],
);

export type BunnyRecommendationExecution =
  typeof bunnyRecommendationExecutionsTable.$inferSelect;
