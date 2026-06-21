import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// HMAC-signed session cookie. Format: "<payload-b64url>.<sig-b64url>"
// Payload is JSON { uid, addr, exp } where exp is unix-seconds.
// The HMAC key is derived from SESSION_SECRET separately from the at-rest
// encryption key, so leaking session cookies cannot reveal stored data.

const COOKIE_NAME = "bunny_session";
const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function getSigningKey(): Buffer {
  const s = process.env["SESSION_SECRET"];
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET is required (>=16 chars) for session cookies.");
  }
  // Domain-separated from at-rest key
  return Buffer.from(`session/v1/${s}`, "utf8");
}

export interface SessionPayload {
  uid: string;
  addr: string;
  exp: number;
}

export function signSession(uid: string, addr: string): string {
  const payload: SessionPayload = {
    uid,
    addr,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(
    createHmac("sha256", getSigningKey()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifySession(cookie: string | undefined): SessionPayload | null {
  if (!cookie) return null;
  const idx = cookie.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  const expected = createHmac("sha256", getSigningKey()).update(body).digest();
  let actual: Buffer;
  try {
    actual = fromB64url(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) {
    return null;
  }
  if (typeof payload.uid !== "string" || typeof payload.addr !== "string") {
    return null;
  }
  return payload;
}

// Minimal Cookie header parser — avoids the cookie-parser dep. Returns
// the value of `name` or undefined. Tolerates spaces and quotes.
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

export function buildSetCookie(value: string, maxAgeSec: number): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function buildClearCookie(): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_TTL_SECONDS = TTL_SECONDS;

// Short-lived anon session cookie. Issued when an unauthenticated visitor
// starts the Base OAuth flow; cleared once the callback upgrades them to a
// real session keyed on their wallet address. Plain random id, not signed —
// it only buys time to complete the OAuth dance, no privilege attached.
const ANON_COOKIE_NAME = "bunny_anon";
const ANON_TTL_SECONDS = 60 * 15;

export function buildAnonCookie(id: string): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${ANON_COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ANON_TTL_SECONDS}${secure}`;
}

export function buildClearAnonCookie(): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${ANON_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export const ANON_SESSION_COOKIE_NAME = ANON_COOKIE_NAME;

// ---------- Telegram one-tap Base login token ----------
// Short-lived, HMAC-signed token that encodes the target userId so a Telegram
// user can complete Base wallet OAuth by tapping a bot-sent link. The link
// grants account access, so the token is single-use (jti tracked in the DB by
// lib/telegram-login.ts) and expires fast. Signed with a key domain-separated
// from both the session-cookie key and the at-rest key.
const LOGIN_TOKEN_TTL_SECONDS = 60 * 10; // 10 min
const LOGIN_BIND_COOKIE = "bunny_tg_bind";

function getLoginKey(): Buffer {
  const s = process.env["SESSION_SECRET"];
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET is required (>=16 chars) for login tokens.");
  }
  return Buffer.from(`tg-login/v1/${s}`, "utf8");
}

export interface LoginTokenPayload {
  uid: string;
  jti: string;
  exp: number;
}

export function signLoginToken(uid: string): string {
  const payload: LoginTokenPayload = {
    uid,
    jti: randomBytes(12).toString("hex"),
    exp: Math.floor(Date.now() / 1000) + LOGIN_TOKEN_TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", getLoginKey()).update(body).digest());
  return `${body}.${sig}`;
}

// Verify the HMAC + expiry of a "<body>.<sig>" token and return its decoded
// JSON object, or null if the signature/exp is bad. Field-shape validation is
// left to the typed callers below.
function parseSignedToken(
  token: string | undefined,
): Record<string, unknown> | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = createHmac("sha256", getLoginKey()).update(body).digest();
  let actual: Buffer;
  try {
    actual = fromB64url(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  try {
    const obj = JSON.parse(fromB64url(body).toString("utf8")) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const rec = obj as Record<string, unknown>;
    const exp = rec["exp"];
    if (typeof exp !== "number" || exp < Date.now() / 1000) return null;
    return rec;
  } catch {
    return null;
  }
}

export function verifyLoginToken(
  token: string | undefined,
): LoginTokenPayload | null {
  const rec = parseSignedToken(token);
  if (!rec) return null;
  if (typeof rec["uid"] !== "string" || typeof rec["jti"] !== "string") {
    return null;
  }
  return {
    uid: rec["uid"] as string,
    jti: rec["jti"] as string,
    exp: rec["exp"] as number,
  };
}

// Bind token stored in the bunny_tg_bind cookie. Distinct from the link token:
// it is minted by the /telegram/connect landing route AFTER the single-use jti
// has been consumed, and it is tied to the anon OAuth flow id that the landing
// route started. The callback only honors a bind cookie whose anonId matches
// the flow it's completing — so a valid signed link token can't be replayed
// straight to the callback to bypass single-use, and a stale bind cookie can't
// be transplanted onto a different OAuth flow.
export interface BindTokenPayload {
  uid: string;
  anonId: string;
  exp: number;
}

export function signBindToken(uid: string, anonId: string): string {
  const payload: BindTokenPayload = {
    uid,
    anonId,
    exp: Math.floor(Date.now() / 1000) + LOGIN_TOKEN_TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", getLoginKey()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyBindToken(
  token: string | undefined,
): BindTokenPayload | null {
  const rec = parseSignedToken(token);
  if (!rec) return null;
  if (typeof rec["uid"] !== "string" || typeof rec["anonId"] !== "string") {
    return null;
  }
  return {
    uid: rec["uid"] as string,
    anonId: rec["anonId"] as string,
    exp: rec["exp"] as number,
  };
}

export function buildBindCookie(value: string): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${LOGIN_BIND_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TOKEN_TTL_SECONDS}${secure}`;
}

export function buildClearBindCookie(): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${LOGIN_BIND_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export const LOGIN_BIND_COOKIE_NAME = LOGIN_BIND_COOKIE;
