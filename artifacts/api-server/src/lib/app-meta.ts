// Static identifiers for outbound third-party headers (currently OpenRouter's
// HTTP-Referer / X-Title used for app analytics + ranking). These are NOT
// the public origin of this deployment — OpenRouter just wants a stable
// identifier for the app making the call. Keeping it static makes the code
// domain-agnostic: a fork running on any host reports the same identifier
// unless the operator overrides it.
export const OPENROUTER_HTTP_REFERER =
  process.env["OPENROUTER_HTTP_REFERER"] ?? "https://bunnyos.ai";
export const OPENROUTER_APP_TITLE =
  process.env["OPENROUTER_APP_TITLE"] ?? "bunnyOS";

// Best-effort externally-reachable origin of this deployment, used to build
// absolute links that must work outside the browser (e.g. the Telegram one-tap
// Base login link, which the bot poller sends with no incoming request to
// derive an origin from). Set PUBLIC_BASE_URL to the deployment's public origin;
// returns "" when it is unset so callers can degrade gracefully. No trailing slash.
export function resolvePublicBaseUrl(): string {
  const explicit = process.env["PUBLIC_BASE_URL"]?.replace(/\/+$/, "");
  if (explicit) return explicit;
  return "";
}
