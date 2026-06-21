import { logger } from "./logger";

// Telegram Bot push notifications. Each user brings their own bot: they paste
// the bot token (from @BotFather) and their numeric chat id (from @userinfobot)
// in Configure → services. Messages are sent send-only via the Bot API — no
// webhook. The token is supplied by the caller (read per-user from settings);
// this module never reads env or global config.

// Telegram chat ids are integers (negative for groups). Accept an optional
// leading "-" followed by digits; reject anything else so we never POST junk.
export function isValidChatId(raw: string): boolean {
  return /^-?\d{1,32}$/.test(raw.trim());
}

// Bot tokens look like "<digits>:<35+ url-safe chars>". Loose check to catch
// obvious paste errors without rejecting valid future formats.
export function isValidBotToken(raw: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(raw.trim());
}

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

// A tappable URL button rendered under a message (Telegram inline keyboard).
export interface TelegramButton {
  text: string;
  url: string;
}

// Send a message. Never throws — returns {ok:false, error} so callers in the
// hot action-insert path can fire-and-forget without risking the insert.
// Optional `buttons` are rendered as a single column of inline URL buttons,
// used to surface transaction approval / "view" links as tappable buttons.
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  buttons?: TelegramButton[],
): Promise<TelegramSendResult> {
  if (!token) return { ok: false, error: "no bot token" };
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (buttons && buttons.length > 0) {
      payload["reply_markup"] = {
        inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]),
      };
    }
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null;
    if (!res.ok || !body?.ok) {
      const error = body?.description ?? `telegram http ${res.status}`;
      logger.warn({ chatId, error }, "telegram send failed");
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown error";
    logger.warn({ chatId, error }, "telegram send threw");
    return { ok: false, error };
  }
}

// Send a photo (PNG buffer) via multipart upload — used to deliver charts
// rendered server-side from tool output. Optional HTML `caption` sits under the
// image; optional `buttons` render as a single column of inline URL buttons.
// Never throws — returns {ok:false, error} like sendTelegramMessage so a failed
// chart can't break the text reply path.
export async function sendTelegramPhoto(
  token: string,
  chatId: string,
  png: Uint8Array,
  opts?: { caption?: string; buttons?: TelegramButton[] },
): Promise<TelegramSendResult> {
  if (!token) return { ok: false, error: "no bot token" };
  try {
    const form = new FormData();
    form.set("chat_id", chatId);
    const ab = png.buffer.slice(
      png.byteOffset,
      png.byteOffset + png.byteLength,
    ) as ArrayBuffer;
    form.set("photo", new Blob([ab], { type: "image/png" }), "chart.png");
    if (opts?.caption) {
      form.set("caption", opts.caption);
      form.set("parse_mode", "HTML");
    }
    if (opts?.buttons && opts.buttons.length > 0) {
      form.set(
        "reply_markup",
        JSON.stringify({
          inline_keyboard: opts.buttons.map((b) => [{ text: b.text, url: b.url }]),
        }),
      );
    }
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      { method: "POST", body: form, signal: AbortSignal.timeout(20_000) },
    );
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null;
    if (!res.ok || !body?.ok) {
      const error = body?.description ?? `telegram http ${res.status}`;
      logger.warn({ chatId, error }, "telegram photo send failed");
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown error";
    logger.warn({ chatId, error }, "telegram photo send threw");
    return { ok: false, error };
  }
}

export interface TelegramDetectResult {
  ok: boolean;
  chatId?: string;
  error?: string;
}

// Auto-detect the user's chat id from recent bot updates. The user creates a
// bot, sends it any message, then we read getUpdates and pull the chat id off
// the most recent message — so they never have to hunt for it via @userinfobot.
// Send-only bots have no webhook, so getUpdates returns the pending messages.
// Never throws.
export async function detectChatId(
  token: string,
): Promise<TelegramDetectResult> {
  if (!token) return { ok: false, error: "no bot token" };
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?limit=10&allowed_updates=["message"]`,
    );
    type Chat = { id?: number; type?: string };
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: Array<{
        message?: { chat?: Chat };
        my_chat_member?: { chat?: Chat };
      }>;
    } | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.description ?? `telegram http ${res.status}` };
    }
    const updates = body.result ?? [];
    // Action alerts are DMs, so prefer the most recent *private* chat. Only fall
    // back to the latest chat of any type if the user never DM'd the bot — this
    // avoids silently routing notifications into a group the bot also sits in.
    let fallback: string | undefined;
    for (let i = updates.length - 1; i >= 0; i--) {
      const chat = updates[i]?.message?.chat ?? updates[i]?.my_chat_member?.chat;
      if (typeof chat?.id !== "number") continue;
      if (chat.type === "private") return { ok: true, chatId: String(chat.id) };
      fallback ??= String(chat.id);
    }
    if (fallback) return { ok: true, chatId: fallback };
    return { ok: false, error: "no messages found" };
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown error";
    logger.warn({ error }, "telegram getUpdates threw");
    return { ok: false, error };
  }
}

// Show a "typing…" indicator in the chat while the agent works. Best-effort,
// never throws — a missing indicator is cosmetic.
export async function sendChatAction(
  token: string,
  chatId: string,
  action = "typing",
): Promise<void> {
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // ignore — typing indicator is non-essential
  }
}

export interface TelegramIncomingMessage {
  updateId: number;
  chatId: string;
  chatType: string;
  text: string;
}

export interface TelegramUpdatesResult {
  ok: boolean;
  messages: TelegramIncomingMessage[];
  error?: string;
}

// Long-poll a bot for new text messages. `offset` is the next update id to
// fetch (last seen + 1); pass 0 to read whatever is pending. Returns parsed
// text messages only — non-text updates are skipped but still advance the
// offset (the caller reads the max updateId). Never throws.
export async function getTelegramUpdates(
  token: string,
  offset: number,
  timeoutSec = 0,
): Promise<TelegramUpdatesResult> {
  if (!token) return { ok: false, messages: [], error: "no bot token" };
  try {
    const params = new URLSearchParams({
      timeout: String(timeoutSec),
      allowed_updates: '["message"]',
    });
    if (offset > 0) params.set("offset", String(offset));
    // Abort budget must exceed the long-poll window so the request itself isn't
    // killed mid-wait; a hung connection still resolves and can't freeze the loop.
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`,
      { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) },
    );
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: Array<{
        update_id?: number;
        message?: {
          text?: string;
          chat?: { id?: number; type?: string };
        };
      }>;
    } | null;
    if (!res.ok || !body?.ok) {
      return {
        ok: false,
        messages: [],
        error: body?.description ?? `telegram http ${res.status}`,
      };
    }
    const messages: TelegramIncomingMessage[] = [];
    for (const u of body.result ?? []) {
      const updateId = u.update_id;
      const chatId = u.message?.chat?.id;
      const text = u.message?.text;
      if (
        typeof updateId === "number" &&
        typeof chatId === "number" &&
        typeof text === "string" &&
        text.trim() !== ""
      ) {
        messages.push({
          updateId,
          chatId: String(chatId),
          chatType: u.message?.chat?.type ?? "private",
          text: text.trim(),
        });
      } else if (typeof updateId === "number") {
        // Non-text update — keep it so the caller can still advance the offset.
        messages.push({ updateId, chatId: "", chatType: "", text: "" });
      }
    }
    return { ok: true, messages };
  } catch (err) {
    const error = err instanceof Error ? err.message : "unknown error";
    return { ok: false, messages: [], error };
  }
}

// Escape user/agent text for Telegram HTML parse mode.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Render inline markdown spans into Telegram-supported HTML tags. Escapes HTML
// first, then converts links, **bold**, `code`, and *italic*/_italic_. Telegram
// only allows a small tag set (b, i, u, s, a, code, pre, blockquote), so block
// constructs are handled by markdownToTelegramHtml, not here.
function inlineMarkdownToHtml(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) => {
      // `url` is already HTML-escaped (& < >). Only allow http(s) links so a
      // javascript:/data: URL can't ship; percent-encode quotes so the URL
      // can't break out of the href attribute. Unsafe links degrade to text.
      if (!/^https?:\/\//i.test(url)) return text;
      const safe = url.replace(/"/g, "%22").replace(/'/g, "%27");
      return `<a href="${safe}">${text}</a>`;
    },
  );
  t = t.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/`([^`]+?)`/g, "<code>$1</code>");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>");
  t = t.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<i>$2</i>");
  return t;
}

// Convert a markdown string (as authored for the actions feed) into the limited
// HTML subset Telegram's parse_mode="HTML" accepts. Headings render as a bold
// line, bullets as "• …", and inline emphasis/links/code are converted. Tags
// Telegram does not support (ul/li/h1) are intentionally avoided.
export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      out.push("");
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inlineMarkdownToHtml(heading[2].trim())}</b>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`• ${inlineMarkdownToHtml(bullet[1].trim())}`);
      continue;
    }
    out.push(inlineMarkdownToHtml(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
