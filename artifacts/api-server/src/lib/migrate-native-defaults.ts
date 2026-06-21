import { db, workflowsTable, appMetaTable } from "@workspace/db";
import { and, eq, like, or } from "drizzle-orm";
import { NATIVE_ACTIONS } from "./native-actions";
import { logger } from "./logger";

// One-time, app-wide fixup: native actions used to ship enabled for everyone.
// They now default off (except the read-only daily summary). This force-disables
// the off-by-default native actions for users who already have them enabled, so
// the new default applies to existing users too — not just new sign-ups.
//
// Guarded by an app_meta flag so it runs exactly once. Running it every boot
// would fight a user who re-enables one of these actions (it'd flip back off on
// the next restart); the flag ensures a re-enable sticks.
//
// Only actions flagged enabledByDefault === false are touched. The set is read
// from NATIVE_ACTIONS so it stays in sync with the code definitions, and the
// per-user row id is nv:<key>:<userId>, so we match by id prefix per key.
const FLAG_KEY = "native_force_off_v1";

export async function migrateNativeDefaults(): Promise<void> {
  try {
    const existing = await db
      .select({ key: appMetaTable.key })
      .from(appMetaTable)
      .where(eq(appMetaTable.key, FLAG_KEY))
      .limit(1);
    if (existing.length > 0) return;

    const offKeys = NATIVE_ACTIONS.filter(
      (d) => d.enabledByDefault === false,
    ).map((d) => d.key);

    if (offKeys.length > 0) {
      const idMatchers = offKeys.map((key) =>
        like(workflowsTable.id, `nv:${key}:%`),
      );
      const result = await db
        .update(workflowsTable)
        .set({ enabled: false })
        .where(
          and(
            eq(workflowsTable.source, "native"),
            eq(workflowsTable.enabled, true),
            or(...idMatchers),
          ),
        );
      logger.info(
        { offKeys, rowCount: result.rowCount ?? null },
        "Force-disabled off-by-default native actions for existing users",
      );
    }

    await db
      .insert(appMetaTable)
      .values({ key: FLAG_KEY, value: new Date().toISOString() })
      .onConflictDoNothing({ target: appMetaTable.key });
  } catch (err) {
    // Never let this break boot. If it fails the flag is not written, so it
    // retries on the next start.
    logger.warn({ err }, "native defaults migration failed");
  }
}
