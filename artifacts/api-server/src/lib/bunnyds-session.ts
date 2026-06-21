// bunnyDS wallet session token mint flow.
//
// The gateway is billed per wallet, not per operator. To call any /v1/* gateway
// endpoint a user must prove control of their Base wallet and exchange that
// proof for a session token:
//
//   1. GET  <gateway>/v1/auth/nonce?address=<0x...>  -> { nonce, message }
//   2. sign the EXACT `message` with the user's Base wallet via the Base MCP
//      sign tool (same approval-URL + poll dance as the bunnyOS SIWE flow)
//   3. POST <gateway>/v1/auth/verify { nonce, signature } -> { token }
//   4. store the token encrypted in the DB, bound to the signing wallet
//
// The token is then sent as `Authorization: Wallet <token>` on every gateway
// call (see bunnyos-gateway.ts). This mirrors lib/bunnyos.ts exactly, reusing
// its sign helpers; the only differences are the nonce/verify endpoints and
// that we sign the gateway-issued message verbatim rather than building SIWE.

import { getAddress } from "viem";
import { logger } from "./logger";
import { callTool } from "./base-mcp";
import { extractApprovalUrls } from "./bunny-agent";
import { getActiveUserId } from "./request-context";
import { getCurrentUserWallet } from "./user";
import { setBunnydsSession } from "./settings";
import {
  resolveSignTool,
  buildSignArgs,
  extractSignature,
  extractRequestId,
} from "./bunnyos";
import {
  gatewayAuthNonceUrl,
  gatewayAuthVerifyUrl,
} from "./bunnyos-gateway";

// Transient, in-process scratch for an in-flight sign. Keyed by userId so
// finalize can rebuild the verify request from the exact nonce that was signed.
// Single-process only, matching the rest of the app's in-memory state. Cleared
// on finalize and TTL-pruned so an abandoned flow can't linger forever.
interface PendingSign {
  requestId: string;
  nonce: string;
  message: string;
  address: string;
  at: number;
}
const pending = new Map<string, PendingSign>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function prunePending(): void {
  const now = Date.now();
  for (const [userId, entry] of pending) {
    if (now - entry.at > PENDING_TTL_MS) pending.delete(userId);
  }
}

async function fetchGatewayNonce(
  address: string,
): Promise<{ nonce: string; message: string }> {
  const res = await fetch(gatewayAuthNonceUrl(address), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`bunnyDS nonce request failed (${res.status})`);
  }
  const json = (await res.json()) as { nonce?: unknown; message?: unknown };
  const nonce = typeof json.nonce === "string" ? json.nonce : "";
  const message = typeof json.message === "string" ? json.message : "";
  if (!nonce || !message) {
    throw new Error("bunnyDS nonce response missing nonce/message");
  }
  return { nonce, message };
}

async function verifyGateway(
  nonce: string,
  signature: string,
): Promise<string> {
  const res = await fetch(gatewayAuthVerifyUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ nonce, signature }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `bunnyDS verify failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const json = (await res.json()) as {
    token?: unknown;
    sessionToken?: unknown;
    accessToken?: unknown;
  };
  const token =
    typeof json.token === "string"
      ? json.token
      : typeof json.sessionToken === "string"
        ? json.sessionToken
        : typeof json.accessToken === "string"
          ? json.accessToken
          : "";
  if (!token) {
    throw new Error("bunnyDS verify response missing a token");
  }
  return token;
}

export interface BunnydsConnectResult {
  approvalUrl: string | null;
  requestId: string | null;
  content: string;
}

// Step 1 of connect: fetch a nonce, hand the gateway-issued message to the Base
// MCP sign tool, and return the wallet approval URL for the UI to surface (same
// pattern as buy/sell + the bunnyOS connect flow). The user approves the
// signature in their Base wallet, then the UI calls finalizeBunnydsConnect.
export async function startBunnydsConnect(): Promise<BunnydsConnectResult> {
  const userId = getActiveUserId();
  if (!userId) throw new Error("no active user");
  const rawWallet = await getCurrentUserWallet();
  if (!rawWallet) {
    throw new Error("no connected wallet — sign in with your Base wallet first");
  }
  const address = getAddress(rawWallet);
  const { nonce, message } = await fetchGatewayNonce(address);

  const signTool = await resolveSignTool();
  const signArgs = buildSignArgs(signTool.inputSchema, message);
  const result = await callTool(signTool.name, signArgs);
  if (result.isError) {
    throw new Error(result.content || "sign request failed");
  }
  const approvalUrl = extractApprovalUrls(result.content)[0] ?? null;
  const requestId = approvalUrl ? extractRequestId(approvalUrl) : null;

  prunePending();
  pending.set(userId, {
    requestId: requestId ?? "",
    nonce,
    message,
    address,
    at: Date.now(),
  });
  return { approvalUrl, requestId, content: result.content };
}

export interface BunnydsFinalizeResult {
  connected: boolean;
  pending: boolean;
}

// Step 2 of connect: poll the signing request. Once the signature is ready,
// POST nonce+signature to the gateway verify endpoint and store the returned
// token (encrypted, bound to the signing wallet). If the signature isn't ready
// yet, return { pending: true } and let the UI re-poll.
export async function finalizeBunnydsConnect(
  requestIdFromClient?: string,
): Promise<BunnydsFinalizeResult> {
  const userId = getActiveUserId();
  if (!userId) throw new Error("no active user");
  const entry = pending.get(userId);
  if (!entry) {
    throw new Error("no pending bunnyDS sign-in — start the connect flow first");
  }
  const requestId = entry.requestId || requestIdFromClient || "";
  if (!requestId) {
    throw new Error("missing request id for the pending sign-in");
  }

  const status = await callTool("get_request_status", { requestId });
  if (status.isError) {
    throw new Error(status.content || "failed to read request status");
  }
  const signature = extractSignature(status.content);
  if (!signature) {
    return { connected: false, pending: true };
  }

  const token = await verifyGateway(entry.nonce, signature);
  await setBunnydsSession(token, entry.address);
  pending.delete(userId);
  logger.info({ userId }, "bunnyDS: wallet session token minted");
  return { connected: true, pending: false };
}
