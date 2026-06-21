import { Router, type IRouter } from "express";
import {
  getTelegramBotToken,
  getTelegramChatId,
  getTelegramEnabled,
  setTelegramBotToken,
  clearTelegramBotToken,
  setTelegramChatId,
  setTelegramEnabled,
} from "../lib/settings";
import {
  isValidChatId,
  isValidBotToken,
  sendTelegramMessage,
  detectChatId,
  escapeHtml,
} from "../lib/telegram";
import { startAuthFlow } from "../lib/base-mcp";
import { verifyLoginToken, signBindToken, buildBindCookie } from "../lib/session";
import { getActiveUserId } from "../lib/request-context";
import { consumeLoginJti, pruneLoginTokens } from "../lib/telegram-login";

const router: IRouter = Router();

function status() {
  const token = getTelegramBotToken();
  const chatId = getTelegramChatId();
  const enabled = getTelegramEnabled();
  return {
    botConfigured: Boolean(token),
    enabled,
    chatId,
    connected: Boolean(enabled && chatId && token),
  };
}

// Current connection state for the Configure → services Telegram section.
// The token itself is never returned — only whether one is saved.
router.get("/telegram", (_req, res): void => {
  res.json(status());
});

// Update bot token, chat id, and/or the enabled toggle. Each field is optional
// so the UI can save them independently. Pass an empty string / null to clear
// the token or chat id.
router.post("/telegram", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    botToken?: unknown;
    chatId?: unknown;
    enabled?: unknown;
  };

  if (body.botToken !== undefined) {
    if (body.botToken === null || body.botToken === "") {
      await clearTelegramBotToken();
    } else if (
      typeof body.botToken === "string" &&
      isValidBotToken(body.botToken)
    ) {
      await setTelegramBotToken(body.botToken.trim());
    } else {
      res.status(400).json({ error: "invalid bot token" });
      return;
    }
  }

  if (body.chatId !== undefined) {
    if (body.chatId === null || body.chatId === "") {
      await setTelegramChatId(null);
    } else if (typeof body.chatId === "string" && isValidChatId(body.chatId)) {
      await setTelegramChatId(body.chatId.trim());
    } else {
      res.status(400).json({ error: "invalid chat id" });
      return;
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "invalid enabled flag" });
      return;
    }
    await setTelegramEnabled(body.enabled);
  }

  res.json(status());
});

// Auto-detect the user's chat id from recent bot updates so they don't have to
// hunt for it. Uses the saved token, or an optional just-pasted token in the
// body so detection works before the first save. The user must have messaged
// their bot first.
router.post("/telegram/detect", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { botToken?: unknown };
  let token = getTelegramBotToken();
  if (
    typeof body.botToken === "string" &&
    isValidBotToken(body.botToken)
  ) {
    token = body.botToken.trim();
  }
  if (!token) {
    res.status(400).json({ error: "no bot token saved" });
    return;
  }
  const result = await detectChatId(token);
  if (!result.ok || !result.chatId) {
    // These failures are user-actionable (no message sent yet, bad token), so
    // 400 rather than 502 — the UI shows a "send your bot a message" hint.
    res.status(400).json({ error: result.error ?? "no chat id found" });
    return;
  }
  res.json({ chatId: result.chatId });
});

// Send a test message so the user can verify their bot token + chat id.
router.post("/telegram/test", async (_req, res): Promise<void> => {
  const token = getTelegramBotToken();
  if (!token) {
    res.status(400).json({ error: "no bot token saved" });
    return;
  }
  const chatId = getTelegramChatId();
  if (!chatId) {
    res.status(400).json({ error: "no chat id saved" });
    return;
  }
  const result = await sendTelegramMessage(
    token,
    chatId,
    "🐰 <b>bunnyOS connected</b>\nyou'll get your actions inbox here.",
  );
  if (!result.ok) {
    res.status(502).json({ error: result.error ?? "send failed" });
    return;
  }
  res.json({ ok: true });
});

// HTML page shown when a one-tap connect link can't be used (expired, already
// used, or malformed). Minimal and self-contained.
function connectErrorPage(message: string): string {
  return `<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 24px;color:#111"><h2>connect link unavailable</h2><p>${escapeHtml(message)}</p><p>open Telegram and send <b>/connect</b> to your bunny bot for a fresh link.</p></body></html>`;
}

// Telegram one-tap Base login landing route. The bot DMs the owner a link here
// carrying a short-lived, single-use signed token that names their userId. We
// validate + consume the token, set a signed bind cookie carrying the userId,
// then 302 into the normal Base OAuth dance. The callback reads the bind cookie
// and stores the resulting Base session under that exact userId.
//
// The session middleware forces this route to run under a fresh anon OAuth
// context (even if the phone browser already has a session cookie), so
// startAuthFlow() stashes PKCE/state under an anon id and the wallet binds to
// the Telegram owner, not whoever is logged into this browser.
router.get("/telegram/connect", async (req, res): Promise<void> => {
  const token =
    typeof req.query["token"] === "string" ? req.query["token"] : "";
  const payload = verifyLoginToken(token);
  if (!payload) {
    res
      .status(400)
      .send(connectErrorPage("this link is invalid or has expired."));
    return;
  }
  // Single-use: the first open consumes the jti; a replay is rejected. Fail
  // CLOSED on a DB error — a login link is account access, so we'd rather make
  // the user request a fresh one than risk honoring a replayed link.
  let fresh: boolean;
  try {
    fresh = await consumeLoginJti(payload.jti);
  } catch (err) {
    req.log.error({ err }, "telegram connect: jti consume failed");
    res
      .status(500)
      .send(connectErrorPage("something went wrong. request a new link."));
    return;
  }
  if (!fresh) {
    res.status(410).send(connectErrorPage("this link was already used."));
    return;
  }
  void pruneLoginTokens();

  // The session middleware forces this route into an anon OAuth context, so the
  // active user is "anon:<id>". Bind the cookie to THAT anon id so the callback
  // only honors it for the exact flow we're about to start (no replay onto a
  // separately-started flow, no transplant).
  const activeUserId = getActiveUserId();
  const anonId =
    activeUserId && activeUserId.startsWith("anon:")
      ? activeUserId.slice("anon:".length)
      : null;
  if (!anonId) {
    req.log.error({ activeUserId }, "telegram connect: no anon context");
    res
      .status(500)
      .send(connectErrorPage("something went wrong. request a new link."));
    return;
  }

  try {
    const result = await startAuthFlow();
    res.append("Set-Cookie", buildBindCookie(signBindToken(payload.uid, anonId)));
    res.redirect(302, result.authUrl);
  } catch (err) {
    req.log.error({ err }, "telegram connect: startAuthFlow failed");
    res
      .status(500)
      .send(
        connectErrorPage("couldn't start the wallet connection. try again."),
      );
  }
});

export default router;
