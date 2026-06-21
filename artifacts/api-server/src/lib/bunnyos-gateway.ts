// bunnyOS Data Gateway — a credential-injecting reverse proxy, billed per wallet.
//
// Auth is a PER-USER WALLET SESSION TOKEN — there is no operator/tenant key.
// The token is minted by signing a gateway-issued nonce with the user's Base
// wallet (see bunnyds-session.ts) and stored encrypted in the DB. We send it as
// `Authorization: Wallet <token>` on every /v1/* call (data + inference). Usage
// is metered against a USDC allowance the wallet grants the gateway's Collector
// on Base (see bunnyds-billing.ts). A user can still bring their own provider
// key in the Configure screen — when they do, their key takes priority and we
// call the upstream directly, bypassing the gateway entirely.
//
// Data:      <base>/cloud/<full upstream url>   (CoinGecko, GMGN, CoinStats)
// Inference: <base>/v1/inference               (OpenAI-compatible)
// Auth:      <base>/v1/auth/{nonce,verify}     (mint a wallet session token)
// Billing:   <base>/v1/billing/wallet          (allowance / balance / owed)
// Auth header: Authorization: Wallet <wallet session token>
//
// The upstream provider key is injected by the gateway — never send upstream
// provider headers (X-API-Key / x-cg-*-api-key / X-APIKEY) when routing through.

import { getBunnydsSessionToken } from "./settings";

// Real gateway host. Overridable with BUNNYOS_GATEWAY_URL (e.g. to point at a
// staging gateway) without a code change.
const DEFAULT_GATEWAY_URL = "https://data.bunnyos.ai";

function clean(v: string | null | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

export function getGatewayBaseUrl(): string {
  const url = clean(process.env.BUNNYOS_GATEWAY_URL) ?? DEFAULT_GATEWAY_URL;
  return url.replace(/\/+$/, "");
}

// The active user's wallet session token (sync read from the settings cache).
// Undefined when the user hasn't minted one — callers then degrade to the
// user's own provider keys.
export function getGatewaySessionToken(): string | undefined {
  return clean(getBunnydsSessionToken());
}

// "Configured" now means the active user has minted a wallet session token.
// No token => no gateway access for this user (fall back to their own keys).
export function isGatewayConfigured(): boolean {
  return Boolean(getGatewaySessionToken());
}

export function gatewayAuthHeaders(): Record<string, string> {
  const token = getGatewaySessionToken();
  return token ? { Authorization: `Wallet ${token}` } : {};
}

// OpenAI-compatible inference base, e.g. "<base>/v1/inference".
export function gatewayInferenceBaseUrl(): string {
  return `${getGatewayBaseUrl()}/v1/inference`;
}

// Auth: fetch a fresh nonce + the exact message to sign for `address`.
//   GET <base>/v1/auth/nonce?address=<0x...>  ->  { nonce, message, expiresAt }
export function gatewayAuthNonceUrl(address: string): string {
  return `${getGatewayBaseUrl()}/v1/auth/nonce?address=${encodeURIComponent(address)}`;
}

// Auth: exchange a signed nonce for a wallet session token.
//   POST <base>/v1/auth/verify  { nonce, signature }  ->  { token, expiresAt }
export function gatewayAuthVerifyUrl(): string {
  return `${getGatewayBaseUrl()}/v1/auth/verify`;
}

// Billing: read the wallet's allowance / balance / owed / credit and the live
// USDC + Collector addresses to approve against.
//   GET <base>/v1/billing/wallet?wallet=<0x...>
export function gatewayBillingWalletUrl(wallet: string): string {
  return `${getGatewayBaseUrl()}/v1/billing/wallet?wallet=${encodeURIComponent(wallet)}`;
}

// Billing discovery (UNAUTHENTICATED): whether the operator has provisioned
// metering, plus the live Collector + USDC addresses and the enabled flags.
// Readable before a wallet session token exists, so the UI can show the
// approve() flow instead of a false "billing unavailable".
//   GET <base>/v1/billing/config
//     -> { configured, chainId, network, collector, usdc, inferenceEnabled, dataEnabled }
export function gatewayBillingConfigUrl(): string {
  return `${getGatewayBaseUrl()}/v1/billing/config`;
}

// Wrap a full upstream URL (incl. query) in the gateway's pass-through proxy:
//   <base>/cloud/<full upstream url>
// The gateway parses everything after "/cloud/" as the target, injects the
// upstream provider credentials, and forwards. It normalizes the collapsed
// "//" with a same-origin 307 redirect, which fetch follows while preserving
// the Authorization header — so callers just fetch the returned URL.
//
//   https://data.bunnyos.ai/cloud/https://api.coingecko.com/api/v3/...
export function gatewayCloudUrl(directUrl: string): string {
  return `${getGatewayBaseUrl()}/cloud/${directUrl}`;
}
