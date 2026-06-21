import {
  db,
  userSettingsTable,
  telegramProcessedUpdatesTable,
} from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { tryDecrypt } from "./crypto";
import { hydrateUserSettings, getLang } from "./settings";
import { getActiveApiKey } from "./llm-provider";
import { runWithUser } from "./request-context";
import {
  runBunny,
  extractApprovalUrls,
  type ChatHistoryTurn,
} from "./bunny-agent";
import { take } from "./rate-limit";
import { getStatus as getMcpStatus } from "./base-mcp";
import { signLoginToken } from "./session";
import { resolvePublicBaseUrl } from "./app-meta";
import {
  getTelegramUpdates,
  sendTelegramMessage,
  sendTelegramPhoto,
  sendChatAction,
  escapeHtml,
  type TelegramButton,
} from "./telegram";
import {
  renderChartsFromTools,
  friendlyToolLabel,
} from "./telegram-charts";
import type { ToolInvocation } from "./bunny-agent";

// Two-way Telegram bot. Each user brings their own bot (token stored encrypted
// on user_settings). We long-poll every enabled bot, route the owner's DMs into
// the same bunny agent the web chat uses, and reply — surfacing any transaction
// approval link as a tappable inline button.
//
// State is in-memory and process-local (single instance): a multi-instance
// deploy would need a shared offset/lock store or a webhook.

const POLL_INTERVAL_MS = 2500;
// Telegram clears the "typing…" indicator ~5s after a chat action, so refresh
// it a little faster than that to keep it visible for the whole agent run.
const TYPING_REFRESH_MS = 4000;
// Keep the last N turns (a turn = one user msg + one assistant reply) so
// follow-ups have context. Ephemeral — resets on restart.
const MAX_HISTORY_TURNS = 8;
// Overall ceiling on a single reply (in plain chars, before HTML-escaping) so a
// runaway agent answer can't flood the chat with dozens of messages. Long
// replies under this are split into multiple Telegram messages, not truncated.
const MAX_REPLY_CHARS = 8000;
// Per-message limit. Telegram hard-caps at 4096 chars; escaping (& < >) can grow
// the string, so chunk below the cap.
const TELEGRAM_MSG_LIMIT = 3800;

// next update id to fetch per user (last seen + 1)
const offsets = new Map<string, number>();
// per-user lock: process one message at a time, no overlapping polls
const busy = new Set<string>();
// per-user rolling conversation history
const histories = new Map<string, ChatHistoryTurn[]>();

let started = false;

const WELCOME =
  "🐰 <b>bunnyOS</b>\n" +
  "ask me anything about base defi — prices, tokens, your portfolio, swaps. " +
  "when i prepare a transaction i'll send an approval button you can tap to sign.\n\n" +
  "to enable wallet actions (swaps, sends, portfolio) tap /connect to link your base wallet — one tap, right from your phone.";

// Build the one-tap Base login URL for a user. Returns null when we can't
// resolve a public origin (e.g. local dev with no domain env) so callers can
// skip offering a dead link.
function buildConnectUrl(userId: string): string | null {
  const base = resolvePublicBaseUrl();
  if (!base) return null;
  return `${base}/api/telegram/connect?token=${encodeURIComponent(signLoginToken(userId))}`;
}

function connectButton(userId: string): TelegramButton | null {
  const url = buildConnectUrl(userId);
  return url ? { text: "🔗 connect base wallet", url } : null;
}

// Heuristic: did the agent's reply steer the user to connect their wallet? Used
// to auto-attach a connect button only when relevant (not on plain price
// reads). The telegram status note instructs the model to keep these words.
function replySuggestsConnect(text: string): boolean {
  return /connect/i.test(text) && /\b(?:base|wallet)\b/i.test(text);
}

interface EnabledBot {
  userId: string;
  token: string;
  chatId: string;
}

async function loadEnabledBots(): Promise<EnabledBot[]> {
  const rows = await db
    .select({
      userId: userSettingsTable.userId,
      token: userSettingsTable.telegramBotToken,
      chatId: userSettingsTable.telegramChatId,
    })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.telegramEnabled, true));
  const bots: EnabledBot[] = [];
  for (const r of rows) {
    // Guard each row: a single corrupt/tampered token must not throw out of the
    // loop and stop polling for everyone else.
    let token: string | null = null;
    try {
      token = tryDecrypt(r.token);
    } catch (err) {
      logger.warn({ err, userId: r.userId }, "telegram: token decrypt failed");
      continue;
    }
    if (!token || !r.chatId) continue;
    bots.push({ userId: r.userId, token, chatId: r.chatId });
  }
  return bots;
}

// Strip approval URLs out of the reply body (they become buttons) and trim
// dangling "approve here:" labels, then escape + truncate for Telegram HTML.
function formatReply(response: string, urls: string[]): string {
  let text = response;
  for (const u of urls) text = text.split(u).join("");
  text = text
    .replace(/^\s*approve here:?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) text = "transaction ready — tap below to review & sign.";
  if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS)}…`;
  return escapeHtml(text);
}

// Build a compact "what bunny did" line from the tools it ran this turn — a
// dedup'd, friendly list of the (non-error) tools used, returned as ready HTML
// (already escaped). Empty string when no tools ran, so plain chat answers stay
// clean. Capped so a tool-heavy run can't produce a giant header.
function toolActivityLine(invocations: ToolInvocation[]): string {
  const seen = new Set<string>();
  for (const inv of invocations) {
    if (inv.isError) continue;
    const label = friendlyToolLabel(inv.name);
    if (label) seen.add(label);
  }
  if (seen.size === 0) return "";
  const labels = [...seen].slice(0, 6);
  return `🔧 <i>${escapeHtml(labels.join(" · "))}</i>\n\n`;
}

// Split an already-escaped string into Telegram-sized chunks without ever
// cutting inside an HTML entity (e.g. &amp;). Prefers a newline boundary near
// the limit so chunks read cleanly.
function chunkForTelegram(escaped: string, limit = TELEGRAM_MSG_LIMIT): string[] {
  if (escaped.length <= limit) return [escaped];
  const chunks: string[] = [];
  let rest = escaped;
  while (rest.length > limit) {
    let cut = limit;
    const nl = rest.lastIndexOf("\n", limit);
    if (nl > limit - 600 && nl > 0) cut = nl;
    // If an HTML entity straddles the cut (an unclosed "&…" just before it),
    // back up to before the "&" so we never split the entity.
    const amp = rest.lastIndexOf("&", cut - 1);
    const semi = rest.lastIndexOf(";", cut - 1);
    if (amp > semi && cut - amp <= 10) cut = amp;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function runAgent(
  userId: string,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  await hydrateUserSettings(userId);
  await runWithUser(userId, async () => {
    const rc = take(userId, "chat");
    if (!rc.allowed) {
      await sendTelegramMessage(
        token,
        chatId,
        `rate limited — try again in ${rc.retryAfterSec}s.`,
      );
      return;
    }
    if (!getActiveApiKey()) {
      await sendTelegramMessage(
        token,
        chatId,
        "no model api key set. open bunnyOS → configure and add your llm provider key first.",
      );
      return;
    }

    // Show "typing…" immediately, then keep re-sending it on an interval — a
    // single chat action expires after ~5s, so without this the indicator dies
    // partway through a long agent run and the bot looks stuck. Cleared in the
    // finally so it stops the moment the run settles (success or error).
    await sendChatAction(token, chatId, "typing");
    const typing = setInterval(() => {
      void sendChatAction(token, chatId, "typing").catch(() => {});
    }, TYPING_REFRESH_MS);

    const history = histories.get(userId) ?? [];
    let response: string;
    let invocations: ToolInvocation[] = [];
    try {
      const result = await runBunny(text, history, getLang(), "telegram");
      response = result.response ?? "";
      invocations = result.toolInvocations ?? [];
    } catch (err) {
      logger.warn({ err, userId }, "telegram agent run failed");
      await sendTelegramMessage(
        token,
        chatId,
        "something went wrong handling that. try again in a moment.",
      );
      return;
    } finally {
      clearInterval(typing);
    }

    const nextHistory = [
      ...history,
      { role: "user" as const, content: text },
      { role: "assistant" as const, content: response },
    ];
    histories.set(userId, nextHistory.slice(-MAX_HISTORY_TURNS * 2));

    const urls = extractApprovalUrls(response);
    const buttons: TelegramButton[] = urls.map((u, i) => ({
      text: urls.length > 1 ? `review & sign #${i + 1}` : "review & sign",
      url: u,
    }));

    // If the user isn't connected to Base and the reply is steering them to
    // connect, attach a one-tap connect button so they can link their wallet
    // without leaving Telegram. Owner-DM-only, so the link only reaches the
    // owner. Skipped when there are approval buttons (already connected).
    let finalButtons: TelegramButton[] | undefined =
      buttons.length > 0 ? buttons : undefined;
    if (!finalButtons && replySuggestsConnect(response)) {
      try {
        const status = await getMcpStatus();
        if (!status.connected) {
          const btn = connectButton(userId);
          if (btn) finalButtons = [btn];
        }
      } catch (err) {
        logger.warn({ err, userId }, "telegram: mcp status check failed");
      }
    }

    // Prepend a compact "what bunny did" line so tool runs read nicely instead
    // of a bare answer. Plain chat answers (no tools) skip it.
    const activity = toolActivityLine(invocations);
    const body = activity + formatReply(response, urls);

    // Split long replies into Telegram-sized messages; attach buttons only to
    // the final chunk so they sit under the full answer.
    const chunks = chunkForTelegram(body);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await sendTelegramMessage(
        token,
        chatId,
        chunks[i] ?? "",
        isLast && finalButtons ? finalButtons : undefined,
      );
      if (!sent.ok) {
        logger.warn(
          { userId, error: sent.error, chunk: i },
          "telegram: reply send failed",
        );
        break;
      }
    }

    // Auto-detect chartable tool output (price history, holdings, top markets)
    // and deliver it as rendered chart images after the text. Best-effort: chart
    // failures are logged inside the renderer/sender and never block the reply.
    try {
      const charts = renderChartsFromTools(invocations);
      for (const chart of charts) {
        const sent = await sendTelegramPhoto(token, chatId, chart.png, {
          caption: chart.caption,
        });
        if (!sent.ok) {
          logger.warn(
            { userId, error: sent.error },
            "telegram: chart send failed",
          );
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, "telegram: chart pipeline failed");
    }
  });
}

// Atomically claim a single update for this process via the shared DB ledger.
// INSERT ... ON CONFLICT DO NOTHING returns the row only to the winner, so when
// several instances (dev + the deployed app, or multiple autoscale workers) poll
// the same bot, exactly one of them handles+replies and the rest skip. On a DB
// error we fail OPEN (return true) so a transient DB blip can't make the bot go
// silent — a rare double-reply beats dropping the user's message entirely.
async function claimUpdate(userId: string, updateId: number): Promise<boolean> {
  try {
    const won = await db
      .insert(telegramProcessedUpdatesTable)
      .values({ userId, updateId })
      .onConflictDoNothing()
      .returning({ updateId: telegramProcessedUpdatesTable.updateId });
    return won.length > 0;
  } catch (err) {
    logger.warn({ err, userId, updateId }, "telegram: claim failed, processing anyway");
    return true;
  }
}

// Prune claim rows older than a day so the ledger doesn't grow without bound.
// Offsets normally keep us from refetching old updates, so a short retention is
// plenty to cover the dedup race window across instances.
let lastClaimPrune = 0;
const CLAIM_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
async function pruneOldClaims(): Promise<void> {
  const now = Date.now();
  if (now - lastClaimPrune < CLAIM_PRUNE_INTERVAL_MS) return;
  lastClaimPrune = now;
  try {
    await db
      .delete(telegramProcessedUpdatesTable)
      .where(lt(telegramProcessedUpdatesTable.createdAt, sql`now() - interval '1 day'`));
  } catch (err) {
    logger.warn({ err }, "telegram: claim prune failed");
  }
}

async function handleMessage(
  userId: string,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  if (text === "/start" || text === "/help") {
    await sendTelegramMessage(token, chatId, WELCOME);
    return;
  }
  if (text === "/connect") {
    const btn = connectButton(userId);
    if (!btn) {
      await sendTelegramMessage(
        token,
        chatId,
        "couldn't build a connect link right now — try again shortly.",
      );
      return;
    }
    await sendTelegramMessage(
      token,
      chatId,
      "tap below to connect your base wallet. the link is single-use and expires in 10 minutes.",
      [btn],
    );
    return;
  }
  await runAgent(userId, token, chatId, text);
}

async function pollBot(bot: EnabledBot): Promise<void> {
  const { userId, token, chatId } = bot;
  if (busy.has(userId)) return;
  busy.add(userId);
  try {
    const offset = offsets.get(userId) ?? 0;
    const res = await getTelegramUpdates(token, offset, 0);
    if (!res.ok || res.messages.length === 0) return;

    // Advance the offset past everything fetched before doing slow work, so the
    // next poll never refetches these updates.
    const maxId = Math.max(...res.messages.map((m) => m.updateId));
    offsets.set(userId, maxId + 1);

    // No restart special-casing: the persistent claim ledger
    // (telegram_processed_updates, 1-day retention) already prevents
    // re-answering anything handled before a restart, so we just process what
    // Telegram still has pending. Messages the owner sent while we were down get
    // answered on the next boot; already-answered ones lose the claim and skip.
    for (const m of res.messages) {
      if (!m.text) continue; // non-text update, only advanced the offset
      // Two-way mode is owner-DM-only: serve only the saved chat id AND only
      // private chats, so a misconfigured/group chat id can't let other members
      // drive the agent under the owner's wallet/tools context.
      if (m.chatId !== chatId || m.chatType !== "private") continue;
      // Cross-instance dedup: only the process that wins the DB claim replies.
      // Another instance polling the same bot will lose the claim and skip, so
      // the user gets exactly one answer.
      const mine = await claimUpdate(userId, m.updateId);
      if (!mine) continue;
      // Isolate per-message: a throw here must not skip the rest of the batch
      // or escape the per-user lock.
      try {
        await handleMessage(userId, token, chatId, m.text);
      } catch (err) {
        logger.warn({ err, userId }, "telegram: handle message failed");
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, "telegram poll failed");
  } finally {
    busy.delete(userId);
  }
}

async function cycle(): Promise<void> {
  let bots: EnabledBot[] = [];
  try {
    bots = await loadEnabledBots();
  } catch (err) {
    logger.warn({ err }, "telegram poller: load enabled bots failed");
    return;
  }
  await Promise.allSettled(bots.map((b) => pollBot(b)));
  void pruneOldClaims();
}

// Start the global poll loop. Idempotent. Self-scheduling (not setInterval) so a
// slow cycle never overlaps the next one.
//
// Single-poller rule: Telegram only allows ONE getUpdates consumer per bot
// token. If both this dev workspace and the deployed app poll the same token,
// they fight (HTTP 409 "terminated by other getUpdates request") and can each
// answer the same message — the "double messages" bug. So by default we only
// poll in the deployed environment (NODE_ENV=production, set by the production
// run config). Set TELEGRAM_POLLER=1 to force-enable it in dev for testing —
// but only do that while the deployment is stopped, or the doubles come back.
export function startTelegramPoller(): void {
  if (started) return;
  const enabled =
    process.env.NODE_ENV === "production" ||
    process.env.TELEGRAM_POLLER === "1";
  if (!enabled) {
    logger.info(
      "telegram poller disabled in dev (set TELEGRAM_POLLER=1 to enable)",
    );
    return;
  }
  started = true;
  const loop = (): void => {
    void cycle().finally(() => {
      setTimeout(loop, POLL_INTERVAL_MS);
    });
  };
  loop();
  logger.info({ tickMs: POLL_INTERVAL_MS }, "telegram poller started");
}
