import { db, actionsTable, type ActionRow, type TokenRef } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getCurrentUserId } from "./user";
import {
  getTelegramBotToken,
  getTelegramChatId,
  getTelegramEnabled,
} from "./settings";
import {
  sendTelegramMessage,
  escapeHtml,
  markdownToTelegramHtml,
} from "./telegram";
import { logger } from "./logger";
import { screenAction } from "./action-security";

// Feed module: persistence + read/hide/execute helpers for the actions
// inbox. Workflows (lib/workflows.ts) emit into this feed via insertAction.
//
// All rows are retained forever as history. Status transitions:
//   pending  → user has not acted on it; shown in the live inbox
//   executed → user clicked Execute (recommendations)
//   dismissed→ user clicked Hide (the row is hidden from the live inbox but
//              remains in /api/actions/history)
//
// Re-emission: insertAction de-duplicates only against existing *pending*
// rows for the same (source, title). A previously-hidden item CAN fire
// again later — it just creates a fresh pending row, leaving the old
// hidden row in history.

export type ActionKind = "alert" | "recommendation";
export type ActionStatus = "pending" | "executed" | "dismissed";

export type { TokenRef };

export interface BunnyAction {
  id: string;
  kind: ActionKind;
  title: string;
  description: string;
  source: string;
  push: boolean;
  executeInstructions: string;
  tokens: TokenRef[];
  createdAt: string;
  status: ActionStatus;
}

function coerceKind(r: ActionRow): ActionKind {
  if (r.kind === "recommendation" || r.kind === "alert") return r.kind;
  return r.severity === "opportunity" ? "recommendation" : "alert";
}

function rowToAction(r: ActionRow): BunnyAction {
  return {
    id: r.id,
    kind: coerceKind(r),
    title: r.title,
    description: r.body,
    source: r.source,
    push: r.push,
    executeInstructions: r.suggestedPrompt,
    tokens: Array.isArray(r.tokens) ? r.tokens : [],
    createdAt: r.createdAt.toISOString(),
    status: r.status as ActionStatus,
  };
}

export async function listActions(): Promise<BunnyAction[]> {
  const userId = getCurrentUserId();
  const rows = await db
    .select()
    .from(actionsTable)
    .where(eq(actionsTable.userId, userId))
    .orderBy(desc(actionsTable.createdAt));
  return rows.map(rowToAction);
}

// The most-recent N actions emitted by a single source (e.g. one action's
// `action:<id>` feed), newest first, regardless of status. Used to feed an
// action runner its own recent history so the agent can avoid re-posting the
// same/similar findings on every run.
export async function listRecentActionsBySource(
  source: string,
  limit = 10,
): Promise<BunnyAction[]> {
  const userId = getCurrentUserId();
  const rows = await db
    .select()
    .from(actionsTable)
    .where(
      and(eq(actionsTable.userId, userId), eq(actionsTable.source, source)),
    )
    .orderBy(desc(actionsTable.createdAt))
    .limit(limit);
  return rows.map(rowToAction);
}

// List the most-recent pushed actions emitted for a SPECIFIC user (not the
// current request's user), newest first. Used to surface a bunny's action push
// history on its public details page: the bunny's creator wallet maps to a
// userId, and the actions that user pushes are the bunny's pushed actions. Only
// `push` rows are included (the same set that surfaces in the live inbox /
// Telegram), and dismissed rows are kept since this is a historical log.
export async function listPushedActionsForUser(
  userId: string,
  limit = 30,
): Promise<BunnyAction[]> {
  const rows = await db
    .select()
    .from(actionsTable)
    .where(and(eq(actionsTable.userId, userId), eq(actionsTable.push, true)))
    .orderBy(desc(actionsTable.createdAt))
    .limit(limit);
  return rows.map(rowToAction);
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Serialize ALL mutations of the actions set per-process so a workflow run
// can't race with a concurrent dismiss/execute/clear.
let mutationChain: Promise<unknown> = Promise.resolve();
function withMutation<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutationChain.then(() => fn());
  mutationChain = next.catch(() => undefined);
  return next;
}

export function setActionStatus(
  id: string,
  status: ActionStatus,
): Promise<BunnyAction | null> {
  return withMutation(async () => {
    const userId = getCurrentUserId();
    const [row] = await db
      .update(actionsTable)
      .set({ status })
      .where(and(eq(actionsTable.id, id), eq(actionsTable.userId, userId)))
      .returning();
    return row ? rowToAction(row) : null;
  });
}

// Hide every currently-pending row for the user in one shot (the "hide all"
// inbox button). Rows move to "dismissed" and stay in history. Returns the
// number of rows hidden.
export function dismissAllPending(): Promise<number> {
  return withMutation(async () => {
    const userId = getCurrentUserId();
    const rows = await db
      .update(actionsTable)
      .set({ status: "dismissed" })
      .where(
        and(
          eq(actionsTable.userId, userId),
          eq(actionsTable.status, "pending"),
        ),
      )
      .returning({ id: actionsTable.id });
    return rows.length;
  });
}

export interface ActionDraft {
  kind: ActionKind;
  title: string;
  description: string;
  source: string;
  executeInstructions?: string;
  tokens?: TokenRef[];
}

// Remove emoji / pictographic symbols from agent-authored action text.
// Actions are presented as a clean terminal feed (and pushed to Telegram), so
// emoji are stripped at the persistence boundary regardless of what the model
// emits. Plain punctuation like ·, •, and ● (not pictographic) is left intact.
function stripEmoji(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Insert one action. De-duplicates against existing pending rows for the
// same user by (source, title) — a previously hidden/executed row does NOT
// block a fresh pending emission. Returns the inserted row, or null when
// it would have been a duplicate. History rows are retained forever; the
// frontend filters by status to separate the live inbox from history.
export function insertAction(draft: ActionDraft): Promise<BunnyAction | null> {
  return withMutation(async () => {
    const userId = getCurrentUserId();
    // Strip emoji from agent-authored text before it is persisted or pushed.
    const title = stripEmoji(draft.title);
    const description = stripEmoji(draft.description);
    // Security gate: never let a wallet-drain / unlimited-approval /
    // credential-exfiltration payload reach the user's inbox. Blocked actions
    // are dropped silently (returned as a no-op, like a duplicate) and logged.
    const screen = screenAction({
      kind: draft.kind,
      title,
      executeInstructions: draft.executeInstructions,
    });
    if (!screen.allowed) {
      logger.warn(
        { userId, source: draft.source, reason: screen.reason },
        "action blocked by security filter",
      );
      return null;
    }
    const existingPending = await db
      .select({ id: actionsTable.id })
      .from(actionsTable)
      .where(
        and(
          eq(actionsTable.userId, userId),
          eq(actionsTable.source, draft.source),
          eq(actionsTable.title, title),
          eq(actionsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (existingPending.length > 0) return null;
    const [row] = await db
      .insert(actionsTable)
      .values({
        id: randomId(),
        userId,
        title,
        body: description,
        source: draft.source,
        severity: "info",
        kind: draft.kind,
        push: true,
        suggestedPrompt:
          draft.kind === "recommendation"
            ? draft.executeInstructions || draft.title
            : draft.executeInstructions ?? "",
        tokens: draft.tokens ?? [],
        status: "pending",
      })
      .returning();
    if (!row) return null;
    const action = rowToAction(row);
    maybeNotifyTelegram(action);
    return action;
  });
}

// Best-effort push of a freshly inserted action to the user's Telegram. Reads
// the per-user settings synchronously (so the AsyncLocalStorage user context is
// captured before the network call) and fires the send without awaiting. Never
// throws — a notification failure must never break action insertion.
function maybeNotifyTelegram(action: BunnyAction): void {
  let enabled = false;
  let chatId: string | null = null;
  let token: string | null = null;
  try {
    enabled = getTelegramEnabled();
    chatId = getTelegramChatId();
    token = getTelegramBotToken();
  } catch {
    return;
  }
  if (!enabled || !chatId || !token) return;
  // Telegram rejects messages over 4096 chars; cap the (untrusted-length)
  // description well under that so the rest of the envelope always fits.
  const desc =
    action.description.length > 3500
      ? `${action.description.slice(0, 3500)}…`
      : action.description;
  const text =
    `<b>${escapeHtml(action.title)}</b>\n` +
    `${markdownToTelegramHtml(desc)}\n\n` +
    `<i>via bunnyOS · ${escapeHtml(action.source)}</i>`;
  void sendTelegramMessage(token, chatId, text).catch((err: unknown) => {
    logger.warn({ err }, "telegram action push failed");
  });
}
