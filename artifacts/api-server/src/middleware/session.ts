import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
  verifySession,
  readCookie,
  SESSION_COOKIE_NAME,
  ANON_SESSION_COOKIE_NAME,
  buildAnonCookie,
  buildClearBindCookie,
  verifyBindToken,
  LOGIN_BIND_COOKIE_NAME,
} from "../lib/session";
import { runWithRequestContext } from "../lib/request-context";
import { hydrateUserSettings } from "../lib/settings";
import { LOCAL_USER_ID, ensureLocalUser } from "../lib/user";
import { seedNativeWorkflows } from "../lib/workflows";

// Resolves the active user from the session cookie, hydrates their settings
// cache, then runs the rest of the request inside AsyncLocalStorage so
// lib/user.ts:getCurrentUserId() sees the right id.
//
// Auth model: multi-user, with Base MCP OAuth as the sign-in. A visitor with
// no session is allowed through to:
//   - public routes (/auth/*, /healthz) — handled as the local fallback user
//   - the Base MCP OAuth bootstrap (auth-url + callback) — handled as an
//     opaque `anon:<id>` until the callback derives their wallet, upserts a
//     real user, and mints a real session cookie.
// Everything else returns 401.

const PUBLIC_PREFIXES = ["/auth/", "/healthz"];
// Exact-match public paths. Kept separate from prefix matching so a route like
// "/bunny/os-price" can't accidentally make a future "/bunny/os-price/..." child
// route public via startsWith.
const PUBLIC_EXACT = new Set(["/bunny/os-price"]);

// Base-MCP endpoints that participate in the anon-OAuth bootstrap. Only the
// two endpoints that actually drive the OAuth dance are allowed anonymously;
// /status is intentionally NOT in this set so passive visitors loading the
// page don't accumulate anon entries in the OAuth provider maps.
//   POST /base-mcp/auth-url      → mint bunny_anon, start OAuth (JSON; legacy)
//   GET  /base-mcp/connect-start → mint bunny_anon, 302 to Base OAuth URL
//                                  (used by the popup; survives third-party
//                                  cookie blocking when the app is in an
//                                  iframe because it's a top-level navigation)
//   GET  /base-mcp/callback      → finish OAuth, derive wallet, mint real session
const ANON_STARTS_FLOW = new Set([
  "/base-mcp/auth-url",
  "/base-mcp/connect-start",
]);
const ANON_FINISHES_FLOW = new Set(["/base-mcp/callback"]);

function isPublicPath(p: string): boolean {
  // p is mounted under /api, so without the prefix
  return PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((pref) => p.startsWith(pref));
}

// Derive the public origin from the request itself, honoring X-Forwarded-*
// because app.ts sets `trust proxy`. This is what makes OAuth's redirect_uri
// work across preview, deployed, custom domains, localhost, Docker, etc.
// with zero env config.
function originFromReq(req: Request): string {
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = req.protocol || "http";
  return `${proto}://${host}`;
}

export function sessionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    try {
      const cookieHeader = req.headers.cookie;
      const sessionCookie = readCookie(cookieHeader, SESSION_COOKIE_NAME);
      const payload = verifySession(sessionCookie);
      const origin = originFromReq(req);

      // Telegram one-tap Base login: /telegram/connect always runs in a fresh
      // anon OAuth context (minting an anon id if absent) so the wallet binds to
      // the Telegram owner, never to whoever is logged into this phone browser.
      if (req.path === "/telegram/connect") {
        let anonId = readCookie(cookieHeader, ANON_SESSION_COOKIE_NAME);
        if (!anonId) {
          anonId = randomBytes(16).toString("hex");
          res.append("Set-Cookie", buildAnonCookie(anonId));
        }
        runWithRequestContext({ userId: `anon:${anonId}`, origin }, () =>
          next(),
        );
        return;
      }

      // Telegram one-tap callback. Only force the anon OAuth context when the
      // bind cookie is valid AND scoped to the anon flow id present — that is the
      // only signal that /telegram/connect actually started this flow. A stale or
      // mismatched bind cookie is cleared and ignored, so it can never divert an
      // ordinary (authenticated or anon) web OAuth callback into the bind path —
      // which would otherwise force the wrong context and fail OAuth state
      // validation, breaking normal web sign-in.
      if (ANON_FINISHES_FLOW.has(req.path)) {
        const bindRaw = readCookie(cookieHeader, LOGIN_BIND_COOKIE_NAME);
        if (bindRaw) {
          const bindPayload = verifyBindToken(bindRaw);
          const anonCookie = readCookie(cookieHeader, ANON_SESSION_COOKIE_NAME);
          if (bindPayload && anonCookie && bindPayload.anonId === anonCookie) {
            runWithRequestContext(
              { userId: `anon:${anonCookie}`, origin },
              () => next(),
            );
            return;
          }
          // Not a live Telegram flow — drop the stale cookie and fall through to
          // normal session / anon handling below.
          res.append("Set-Cookie", buildClearBindCookie());
        }
      }

      // Any ordinary web OAuth start clears a stale Telegram bind cookie —
      // including for an already-authenticated user — so an abandoned one-tap
      // flow can't later divert THIS flow's callback into the bind branch, which
      // forces anon context and would fail OAuth state validation. Runs before
      // the session check so the authenticated start path is covered too.
      if (
        ANON_STARTS_FLOW.has(req.path) &&
        readCookie(cookieHeader, LOGIN_BIND_COOKIE_NAME)
      ) {
        res.append("Set-Cookie", buildClearBindCookie());
      }

      if (payload) {
        await hydrateUserSettings(payload.uid);
        // Seed the native starter pack so it runs on the scheduler even if the
        // user never opens the builder. Idempotent + gated to once per process.
        await seedNativeWorkflows(payload.uid);
        runWithRequestContext({ userId: payload.uid, origin }, () => next());
        return;
      }

      // No valid session.
      if (isPublicPath(req.path)) {
        // public route — run with local user so settings/etc don't blow up
        await ensureLocalUser();
        await hydrateUserSettings(LOCAL_USER_ID);
        runWithRequestContext({ userId: LOCAL_USER_ID, origin }, () => next());
        return;
      }
      if (ANON_STARTS_FLOW.has(req.path)) {
        // Starting the ordinary web OAuth dance. Reuse existing bunny_anon
        // cookie if present, else mint a fresh one. The id is opaque — only
        // used as the key into the in-memory anon OAuth state map.
        let anonId = readCookie(cookieHeader, ANON_SESSION_COOKIE_NAME);
        if (!anonId) {
          anonId = randomBytes(16).toString("hex");
          res.append("Set-Cookie", buildAnonCookie(anonId));
        }
        // Stale Telegram bind cookies are cleared above (covers authed + anon
        // starts), so no per-branch clear is needed here.
        runWithRequestContext({ userId: `anon:${anonId}`, origin }, () => next());
        return;
      }
      if (ANON_FINISHES_FLOW.has(req.path)) {
        // Finishing the dance. We REQUIRE the anon cookie set by /auth-url
        // — without it the callback can't find any anon state to upgrade,
        // and we shouldn't mint a fresh one (no provider, no codeVerifier).
        const anonId = readCookie(cookieHeader, ANON_SESSION_COOKIE_NAME);
        if (!anonId) {
          res.status(400).send("Missing anon session — start the connect flow first");
          return;
        }
        runWithRequestContext({ userId: `anon:${anonId}`, origin }, () => next());
        return;
      }
      res.status(401).json({ error: "not authenticated" });
    } catch (err) {
      req.log.error({ err }, "session middleware failed");
      res.status(500).json({ error: "session resolution failed" });
    }
  })();
}
