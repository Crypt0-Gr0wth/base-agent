import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userSettingsTable = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  openrouterApiKey: text("openrouter_api_key"),
  surplusApiKey: text("surplus_api_key"),
  veniceApiKey: text("venice_api_key"),
  economyosApiKey: text("economyos_api_key"),
  moralisApiKey: text("moralis_api_key"),
  coingeckoApiKey: text("coingecko_api_key"),
  gmgnApiKey: text("gmgn_api_key"),
  zerionApiKey: text("zerion_api_key"),
  coinstatsApiKey: text("coinstats_api_key"),
  bunnyosJwt: text("bunnyos_jwt"),
  // Per-user bunnyDS gateway wallet session token (minted via gateway
  // nonce -> Base-wallet sign -> verify). Encrypted at rest. Replaces the old
  // operator/tenant key: ALL /v1/* gateway calls authenticate as the wallet.
  bunnydsSessionToken: text("bunnyds_session_token"),
  // The Base address the session token is bound to. If the connected wallet
  // changes we re-mint rather than send a token for the wrong payer.
  bunnydsSessionWallet: text("bunnyds_session_wallet"),
  llmProvider: text("llm_provider").notNull().default("openrouter"),
  model: text("model"),
  lang: text("lang").default("zh"),
  memoryMd: text("memory_md").notNull().default(""),
  baseMcpSession: jsonb("base_mcp_session"),
  telegramBotToken: text("telegram_bot_token"),
  telegramChatId: text("telegram_chat_id"),
  telegramEnabled: boolean("telegram_enabled").notNull().default(false),
  // bunnyDS = the bunnyOS managed data + inference gateway. When true (the
  // default), data tool calls + inference route through the gateway with our
  // operator tenant key, so the user needs no keys of their own. When false,
  // everything falls back to the user's own keys (open-source / BYO mode).
  bunnyDsEnabled: boolean("bunny_ds_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserSettings = typeof userSettingsTable.$inferSelect;
export type InsertUserSettings = typeof userSettingsTable.$inferInsert;
