import { db, usersTable, userSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getActiveUserId } from "./request-context";

// Fallback synthetic user used for public/unauthenticated routes (/auth/me,
// /healthz) and boot-time tasks that need *some* userId. Real users are
// created on Base MCP OAuth callback via upsertUserByWallet, and
// getCurrentUserId() reads the active id from AsyncLocalStorage populated by
// the session middleware.
export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";

export async function ensureLocalUser(): Promise<void> {
  await db
    .insert(usersTable)
    .values({ id: LOCAL_USER_ID, isLocal: true })
    .onConflictDoNothing({ target: usersTable.id });

  await db
    .insert(userSettingsTable)
    .values({ userId: LOCAL_USER_ID })
    .onConflictDoNothing({ target: userSettingsTable.userId });

  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, LOCAL_USER_ID))
    .limit(1);
  if (!row) throw new Error("failed to create local user");
  logger.info({ userId: LOCAL_USER_ID }, "local user ready");
}

// Admin wallet allowlist — admins are NOT on-chain creators but may edit any
// bunny's off-chain profile. Wallet addresses are public, so this is plain
// config (not a secret). Hardcoded admins plus any in BUNNY_ADMIN_WALLETS.
const HARDCODED_ADMIN_WALLETS = [
  "0x3F0adD0299C6EA0fb9f5589EBE8DBBdab2893766",
  "0xb475ac5855afe4d2dc1f8dc37d92102f74db834b",
];

const ADMIN_WALLETS = new Set(
  [
    ...HARDCODED_ADMIN_WALLETS,
    ...(process.env.BUNNY_ADMIN_WALLETS ?? "").split(","),
  ]
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0),
);

export function isAdminWallet(wallet: string | null | undefined): boolean {
  if (!wallet) return false;
  return ADMIN_WALLETS.has(wallet.toLowerCase());
}

export function getCurrentUserId(): string {
  const uid = getActiveUserId();
  if (!uid) {
    throw new Error(
      "no active user in request context — call runWithUser(uid, fn) before reading user-scoped state",
    );
  }
  return uid;
}

// Returns the active user's connected wallet address (lowercased), or null if
// the user has no wallet (e.g. the synthetic local user). Used by on-chain
// write tools that need the trader's address to build calldata.
export async function getCurrentUserWallet(): Promise<string | null> {
  const uid = getCurrentUserId();
  const [row] = await db
    .select({ walletAddress: usersTable.walletAddress })
    .from(usersTable)
    .where(eq(usersTable.id, uid))
    .limit(1);
  return row?.walletAddress ?? null;
}

// Upsert a wallet-authenticated user. Returns the existing or new userId.
// Caller must lowercase the address; we store it lowercased and also create
// the per-user settings row so downstream reads have a default to hydrate.
export async function upsertUserByWallet(
  walletAddress: string,
): Promise<{ userId: string; isNew: boolean }> {
  const lower = walletAddress.toLowerCase();
  // Atomic upsert — two concurrent OAuth callbacks for the same wallet
  // (e.g. popup retried) would otherwise race the select/insert and fail
  // the loser on the unique constraint. ON CONFLICT DO UPDATE forces the
  // returning row to come back for both winners and losers.
  //
  // `(xmax = 0)` distinguishes a fresh INSERT (xmax 0) from an ON CONFLICT
  // UPDATE (xmax = the locking xid, non-zero), i.e. brand-new sign-up vs
  // returning wallet — used to route first-time users to bunnyDS.
  const [row] = await db
    .insert(usersTable)
    .values({ walletAddress: lower, isLocal: false })
    .onConflictDoUpdate({
      target: usersTable.walletAddress,
      set: { walletAddress: lower },
    })
    .returning({ id: usersTable.id, isNew: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error("failed to upsert user");

  await db
    .insert(userSettingsTable)
    .values({ userId: row.id })
    .onConflictDoNothing({ target: userSettingsTable.userId });

  logger.info(
    { userId: row.id, walletAddress: lower, isNew: row.isNew },
    "wallet user upserted",
  );
  return { userId: row.id, isNew: row.isNew };
}

// Look up an existing user's id by wallet address WITHOUT creating one. Returns
// null when no user has ever signed in with that wallet. Used to resolve a
// bunny's on-chain creator wallet to the userId whose actions it pushes.
export async function getUserIdByWallet(
  walletAddress: string | null | undefined,
): Promise<string | null> {
  if (!walletAddress) return null;
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.walletAddress, walletAddress.toLowerCase()))
    .limit(1);
  return row?.id ?? null;
}

// Look up a specific user's connected wallet address (lowercased at write time)
// by id, outside of any request context. Used by the Telegram one-tap login
// callback to fill the session cookie's address when binding the Base session
// to a pre-set owner userId.
export async function getWalletForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ walletAddress: usersTable.walletAddress })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.walletAddress ?? null;
}
