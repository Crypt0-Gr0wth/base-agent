import { Router, type IRouter } from "express";
import { take } from "../lib/rate-limit";
import { getCurrentUserId } from "../lib/user";
import { callTool } from "../lib/base-mcp";
import { extractApprovalUrls } from "../lib/bunny-agent";
import {
  startBunnydsConnect,
  finalizeBunnydsConnect,
} from "../lib/bunnyds-session";
import {
  getBillingStatus,
  buildAllowanceApproveCalls,
} from "../lib/bunnyds-billing";

const router: IRouter = Router();

// bunnyDS wallet-billed gateway routes. The gateway is metered per wallet:
// the user mints a wallet session token (connect/finalize) and grants a USDC
// allowance to the gateway Collector (allowance). Billing + token live per-user.

// POST /api/bunnyds/connect — start the wallet sign to mint a session token.
// Returns the wallet approval URL (and request id) for the UI to surface, same
// pattern as the bunnyOS connect + buy/sell flows.
router.post("/bunnyds/connect", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  try {
    res.json(await startBunnydsConnect());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /no connected wallet|no active user/i.test(message)
      ? 409
      : 502;
    res.status(status).json({ error: message });
  }
});

// POST /api/bunnyds/finalize { requestId? } — poll the sign request; once
// signed, verify with the gateway and store the wallet session token. Returns
// { pending: true } while the user hasn't approved yet so the UI can re-poll.
router.post("/bunnyds/finalize", async (req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const body = (req.body ?? {}) as { requestId?: unknown };
  const requestId =
    typeof body.requestId === "string" ? body.requestId : undefined;
  try {
    res.json(await finalizeBunnydsConnect(requestId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /no connected wallet|no active user|no pending/i.test(message)
      ? 409
      : 502;
    res.status(status).json({ error: message });
  }
});

// GET /api/bunnyds/billing — the active wallet's billing snapshot (allowance /
// balance / owed / credit + the USDC + Collector addresses). Returns an
// unconfigured snapshot (never 502) when no session token / wallet / billing
// record exists yet.
router.get("/bunnyds/billing", async (_req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  try {
    res.json(await getBillingStatus());
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/bunnyds/allowance { amount } — build + submit an ERC-20
// approve(Collector, amount USDC) batch via Base MCP send_calls. Returns the
// wallet approval URL for the UI to surface (same pattern as buy/sell).
router.post("/bunnyds/allowance", async (req, res): Promise<void> => {
  const rate = take(getCurrentUserId(), "chat");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res
      .status(429)
      .json({ error: "rate limited", retryAfterSec: rate.retryAfterSec });
    return;
  }
  const body = (req.body ?? {}) as { amount?: unknown };
  const amount =
    typeof body.amount === "string"
      ? body.amount
      : typeof body.amount === "number"
        ? String(body.amount)
        : "";
  if (!amount || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    res.status(400).json({ error: "`amount` must be a positive USDC number" });
    return;
  }
  try {
    const calls = await buildAllowanceApproveCalls(amount);
    const result = await callTool("send_calls", { chain: "base", calls });
    if (result.isError) {
      res.status(502).json({ error: result.content || "send_calls failed" });
      return;
    }
    const approvalUrls = extractApprovalUrls(result.content);
    res.json({
      approvalUrl: approvalUrls[0] ?? null,
      approvalUrls,
      content: result.content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /no connected wallet|isn't available|isn't enabled|connect your wallet/i.test(
      message,
    )
      ? 409
      : 502;
    res.status(status).json({ error: message });
  }
});

export default router;
