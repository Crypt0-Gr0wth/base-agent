import { getAddress } from "viem";
import { logger } from "./logger";
import { callTool, listTools } from "./base-mcp";
import { getActiveUserId } from "./request-context";
import { getCurrentUserWallet } from "./user";

// Definitive Flash — non-custodial, intent-based DEX execution on Base (and
// many other chains). https://flash.definitive.fi/docs/for-agents
//
// Flow per swap is Quote -> Sign -> Submit:
//   1. POST /quote returns a quoteId, pricing legs, fees, and EVM signing
//      payloads (evm.approveTx, evm.permitTypedData, evm.orderTypedData).
//   2. The funder wallet (the user's connected Base account) approves the
//      one-time ERC-20 -> Permit2 allowance (if needed), then signs the
//      Permit2 typed data (if needed) and the order typed data — all via the
//      Base MCP `sign` / `send_calls` approval tools. Bunny never holds a key.
//   3. POST /order echoes the quoteId, the signed typed data, and the order
//      signature back to Flash, which fills the order.
//
// Because each on-chain approval / signature is an interactive Base wallet
// approval (the user clicks an approval URL), execution is split across two
// agent tools: `definitive_swap` starts the flow and returns the first
// approval URL; `definitive_finalize` is called after each approval to advance
// the state machine (capture the result, kick off the next step, and finally
// submit the order). Read tools (quote / orders / status) are single-shot.

const API_BASE = "https://ddp.definitive.fi/v2/flash";
// bunnyOS integrator key, baked in so open-source users can trade Flash with
// zero setup (fees/rate limits attribute to this integrator account). Operators
// can override it without a code change via the DEFINITIVE_API_KEY env/secret.
const DEFAULT_INTEGRATOR_KEY = "dpka_12f24bf5_c310_450a_af0b_ae826c4c3af5";

const SUPPORTED_CHAINS = [
  "base",
  "ethereum",
  "arbitrum",
  "optimism",
  "polygon",
  "avalanche",
  "blast",
  "bsc",
  "hyperevm",
  "plasma",
  "monad",
] as const;

const ORDER_TYPES = [
  "market",
  "limit",
  "twap",
  "stop",
  "stop-loss",
  "take-profit",
  "bracket",
] as const;

type Json = Record<string, unknown>;

export interface DefinitiveTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function apiKey(): string {
  return process.env["DEFINITIVE_API_KEY"]?.trim() || DEFAULT_INTEGRATOR_KEY;
}

async function flashFetch(
  method: "GET" | "POST",
  path: string,
  body?: Json,
  timeoutMs = 25_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-definitive-api-key": apiKey(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      // Flash returns a JSON ErrorResponse; surface its message when present.
      let msg = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        msg = j.message || j.error || msg;
      } catch {
        // not JSON — keep the raw text
      }
      throw new Error(`${resp.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Base MCP approval helpers ----------

// Approval landing pages returned by the Base wallet send/sign tools. Kept
// local (rather than imported from bunny-agent) to avoid an import cycle, since
// bunny-agent imports this module.
const APPROVAL_URL_RE =
  /https:\/\/(?:account\.base\.app|wallet\.base\.org|account\.base\.org|keys\.coinbase\.com|wallet\.coinbase\.com)\/(?:wallet-requests|wallet-request|requests|request|calls|approve)\/[^\s"')\]}>,]+/g;

function extractApprovalUrls(text: string): string[] {
  if (!text) return [];
  return (text.match(APPROVAL_URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, ""));
}

function extractRequestId(url: string): string | null {
  const m = url.match(
    /\/(?:wallet-requests|wallet-request|requests|request|calls|approve)\/([a-zA-Z0-9_-]+)/,
  );
  return m ? m[1]! : null;
}

// A signature is a long 0x hex string. EOA sigs are 65 bytes (132 chars);
// smart-wallet (ERC-1271/6492) sigs are longer. Require >= 130 chars so we
// don't match an address (42) or a tx hash (66).
function findSignatureInJson(node: unknown): string | null {
  if (typeof node === "string") {
    return /^0x[0-9a-fA-F]{130,}$/.test(node) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = findSignatureInJson(v);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["signature", "sig", "signedMessage", "result", "data"]) {
      const v = obj[key];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{130,}$/.test(v)) return v;
    }
    for (const v of Object.values(obj)) {
      const found = findSignatureInJson(v);
      if (found) return found;
    }
  }
  return null;
}

function extractSignature(content: string): string | null {
  try {
    const found = findSignatureInJson(JSON.parse(content));
    if (found) return found;
  } catch {
    // not JSON — fall through
  }
  const m = content.match(/0x[0-9a-fA-F]{130,}/);
  return m ? m[0] : null;
}

// True when a get_request_status payload carries an explicit failed/rejected
// status — so we can abort the flow with an actionable error rather than
// polling forever. Scoped to a status/state field value to avoid matching a
// stray "error" word in unrelated metadata.
function isFailedStatus(content: string): boolean {
  return /"?(?:status|state)"?\s*[:=]\s*"?[a-z_]*?(?:fail|reject|cancel|declin|expir|error)/i.test(
    content,
  );
}

// A labeled transaction/receipt hash (e.g. txHash, transactionHash) is a strong
// "the wallet submitted it" signal for a send_calls approval.
function findTxHashInJson(node: unknown): string | null {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string" && /hash/i.test(k) && /^0x[0-9a-fA-F]{64}$/.test(v)) {
        return v;
      }
      const found = findTxHashInJson(v);
      if (found) return found;
    }
  }
  return null;
}

// For a send_calls (on-chain) approval, "done" means the wallet submitted a
// transaction — a success status, a labeled tx hash, or (last resort) a bare
// standalone 64-hex hash in the payload.
function txSubmitted(content: string): boolean {
  if (
    /"?(?:status|state)"?\s*[:=]\s*"?[a-z_]*?(?:confirmed|success|complete|completed|mined|executed|submitted)/i.test(
      content,
    )
  ) {
    return true;
  }
  try {
    if (findTxHashInJson(JSON.parse(content))) return true;
  } catch {
    // not JSON — fall through
  }
  return /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The terminal agent is poor at re-driving a multi-step flow, so a single
// definitive_finalize call polls the wallet request for a bit instead of
// returning `pending` the instant the tx/sig hasn't landed yet. ~7.5s budget
// catches the common "user just clicked approve" case; on timeout the agent can
// simply call finalize again.
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 1500;

// Poll get_request_status until `isDone` matches (state "done"), an explicit
// failure shows up (state "failed"), or we exhaust the budget (state "timeout").
async function pollStep(
  requestId: string,
  isDone: (content: string) => boolean,
): Promise<{ state: "done" | "failed" | "timeout"; content: string }> {
  let last = "";
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (i > 0) await sleep(POLL_DELAY_MS);
    const status = await callTool("get_request_status", { requestId });
    if (status.isError) {
      if (i === POLL_ATTEMPTS - 1) {
        throw new Error(status.content || "failed to read request status");
      }
      continue;
    }
    last = status.content;
    if (isDone(last)) return { state: "done", content: last };
    if (isFailedStatus(last)) return { state: "failed", content: last };
  }
  return { state: "timeout", content: last };
}

async function resolveSignTool(): Promise<string> {
  const tools = await listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const c of ["sign", "sign_message", "personal_sign"]) {
    if (names.has(c)) return c;
  }
  throw new Error(
    "your Base wallet session doesn't expose a message-signing tool — reconnect Base and try again",
  );
}

async function resolveSendCallsTool(): Promise<string> {
  const tools = await listTools();
  const names = tools.map((t) => t.name);
  if (names.includes("send_calls")) return "send_calls";
  const m = names.find((n) => /send.?calls/i.test(n));
  if (m) return m;
  throw new Error(
    "your Base wallet session doesn't expose a batched-calls (send_calls) tool — reconnect Base and try again",
  );
}

interface StepResult {
  approvalUrl: string | null;
  requestId: string;
  content: string;
}

async function initiateSign(
  type: "typed_data" | "personal_sign",
  data: Json,
): Promise<StepResult> {
  const tool = await resolveSignTool();
  const result = await callTool(tool, { type, data });
  if (result.isError) throw new Error(result.content || "sign request failed");
  const url = extractApprovalUrls(result.content)[0] ?? null;
  return { approvalUrl: url, requestId: url ? extractRequestId(url) ?? "" : "", content: result.content };
}

async function initiateApprove(approveTx: { to: string; data: string }): Promise<StepResult> {
  const tool = await resolveSendCallsTool();
  const calls = [{ to: approveTx.to, value: "0x0", data: approveTx.data }];
  // Base MCP's send_calls requires the target chain; Flash is Base-only here.
  const result = await callTool(tool, { chain: "base", calls });
  if (result.isError) throw new Error(result.content || "approval request failed");
  const url = extractApprovalUrls(result.content)[0] ?? null;
  return { approvalUrl: url, requestId: url ? extractRequestId(url) ?? "" : "", content: result.content };
}

// ---------- pending swap / cancel state ----------

interface EvmActions {
  approveTx: { to: string; data: string } | null;
  permitTypedData: string | null;
  orderTypedData: string | null;
}

interface SwapContext {
  // Order params echoed at submit, exactly as quoted.
  order: Json;
  quoteId: string;
  funderAddress: string;
  evm: EvmActions;
  approveDone: boolean;
  permitSig: string | null;
  orderSig: string | null;
}

interface CancelContext {
  orderId: string;
  cancelMessage: string;
}

type StepKind = "approve" | "permit" | "order" | "cancel";

interface Pending {
  kind: "swap" | "cancel";
  stepKind: StepKind;
  requestId: string;
  approvalUrl: string | null;
  at: number;
  swap?: SwapContext;
  cancel?: CancelContext;
}

const PENDING_TTL_MS = 20 * 60 * 1000;
const pending = new Map<string, Pending>();

function prunePending(): void {
  const now = Date.now();
  for (const [uid, p] of pending) {
    if (now - p.at > PENDING_TTL_MS) pending.delete(uid);
  }
}

// Advance a swap to its next outstanding step. Initiates the next approval /
// signature and stores it on `pending`, or submits the order when everything
// is captured. Returns the agent-facing result object.
async function advanceSwap(uid: string, p: Pending): Promise<Json> {
  const sw = p.swap!;
  if (sw.evm.approveTx && !sw.approveDone) {
    const step = await initiateApprove(sw.evm.approveTx);
    p.stepKind = "approve";
    p.requestId = step.requestId;
    p.approvalUrl = step.approvalUrl;
    p.at = Date.now();
    return {
      pending: true,
      step: "approve",
      note: "One-time token spending approval (Permit2). Approve it in your Base wallet, then call definitive_finalize.",
      approvalUrl: step.approvalUrl,
    };
  }
  if (sw.evm.permitTypedData && !sw.permitSig) {
    const step = await initiateSign("typed_data", JSON.parse(sw.evm.permitTypedData));
    p.stepKind = "permit";
    p.requestId = step.requestId;
    p.approvalUrl = step.approvalUrl;
    p.at = Date.now();
    return {
      pending: true,
      step: "permit",
      note: "Sign the Permit2 authorization in your Base wallet, then call definitive_finalize.",
      approvalUrl: step.approvalUrl,
    };
  }
  if (!sw.orderSig) {
    if (!sw.evm.orderTypedData) {
      pending.delete(uid);
      throw new Error("quote did not return EVM order typed data to sign");
    }
    const step = await initiateSign("typed_data", JSON.parse(sw.evm.orderTypedData));
    p.stepKind = "order";
    p.requestId = step.requestId;
    p.approvalUrl = step.approvalUrl;
    p.at = Date.now();
    return {
      pending: true,
      step: "order",
      note: "Sign the order in your Base wallet, then call definitive_finalize to submit it.",
      approvalUrl: step.approvalUrl,
    };
  }
  // Everything captured — submit.
  const body: Json = {
    ...sw.order,
    quoteId: sw.quoteId,
    funderAddress: sw.funderAddress,
    userSignature: sw.orderSig,
    evmOrderTypedData: sw.evm.orderTypedData,
  };
  if (sw.evm.permitTypedData && sw.permitSig) {
    body["evmPermitTypedData"] = sw.evm.permitTypedData;
    body["evmPermitSignature"] = sw.permitSig;
  }
  const res = (await flashFetch("POST", "/order", body)) as { orderId?: string };
  pending.delete(uid);
  logger.info({ uid, orderId: res.orderId }, "Definitive Flash order submitted");
  return {
    done: true,
    orderId: res.orderId,
    status: "submitted",
    note: "Order submitted to Definitive Flash. Use definitive_order_status to track the fill.",
  };
}

// ---------- argument parsing ----------

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`missing required arg: ${key}`);
  }
  return String(v);
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

function normChain(v: string | undefined, fallback: string): string {
  const c = (v ?? fallback).toLowerCase();
  if (!(SUPPORTED_CHAINS as readonly string[]).includes(c)) {
    throw new Error(`unsupported chain "${c}". Supported: ${SUPPORTED_CHAINS.join(", ")}`);
  }
  return c;
}

// Build the shared order params from quote/swap args (used for both /quote and
// the /order echo). funderAddress is added by the caller.
function buildOrderParams(args: Record<string, unknown>): Json {
  const targetChain = normChain(optStr(args, "targetChain"), "base");
  const contraChain = normChain(optStr(args, "contraChain"), targetChain);
  const side = reqStr(args, "side").toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new Error(`side must be "buy" or "sell", got: ${side}`);
  }
  const orderType = (optStr(args, "orderType") ?? "market").toLowerCase();
  if (!(ORDER_TYPES as readonly string[]).includes(orderType)) {
    throw new Error(`orderType must be one of: ${ORDER_TYPES.join(", ")}`);
  }
  const out: Json = {
    targetChain,
    contraChain,
    targetAsset: reqStr(args, "targetAsset"),
    contraAsset: reqStr(args, "contraAsset"),
    side,
    qty: reqStr(args, "qty"),
    orderType,
  };
  const maxSlippage = optStr(args, "maxSlippage");
  if (maxSlippage) out["maxSlippage"] = maxSlippage;
  const maxPriceImpact = optStr(args, "maxPriceImpact");
  if (maxPriceImpact) out["maxPriceImpact"] = maxPriceImpact;
  const limitNotionalPrice = optStr(args, "limitNotionalPrice");
  if (limitNotionalPrice) out["limitNotionalPrice"] = limitNotionalPrice;
  const feeBps = optStr(args, "flashIntegratorFeeBps");
  if (feeBps) out["flashIntegratorFeeBps"] = feeBps;
  return out;
}

async function funderWallet(): Promise<string> {
  const raw = await getCurrentUserWallet();
  if (!raw) {
    throw new Error("no connected wallet — sign in with your Base wallet first");
  }
  return getAddress(raw);
}

interface QuoteLeg {
  asset?: string;
  amount?: string;
  notional?: string;
}
interface QuoteResponse {
  quoteId: string;
  side?: string;
  orderType?: string;
  from?: QuoteLeg;
  to?: QuoteLeg;
  fees?: { estimatedFeeNotional?: string };
  evm?: EvmActions | null;
}

function summarizeQuote(q: QuoteResponse): Json {
  return {
    quoteId: q.quoteId,
    side: q.side,
    orderType: q.orderType,
    pay: q.from ? { amount: q.from.amount, usd: q.from.notional } : undefined,
    receive: q.to ? { amount: q.to.amount, usd: q.to.notional } : undefined,
    estimatedFeeUsd: q.fees?.estimatedFeeNotional,
    needsApproval: Boolean(q.evm?.approveTx),
    needsPermitSignature: Boolean(q.evm?.permitTypedData),
  };
}

// ---------- tools ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const swapArgProps = {
  targetChain: {
    type: "string",
    description: `Chain of the target (traded) asset. Default "base". One of: ${SUPPORTED_CHAINS.join(", ")}.`,
  },
  contraChain: {
    type: "string",
    description: "Chain of the contra (counter) asset. Defaults to targetChain (same-chain swap).",
  },
  targetAsset: {
    type: "string",
    description: "Contract address of the target (traded) asset. On Base, USDC is 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 and WETH is 0x4200000000000000000000000000000000000006.",
  },
  contraAsset: {
    type: "string",
    description: "Contract address of the contra (counter) asset — spent on buys, received on sells.",
  },
  side: { type: "string", enum: ["buy", "sell"], description: "buy = acquire targetAsset; sell = dispose targetAsset." },
  qty: {
    type: "string",
    description: "Amount of the asset being SPENT, as a decimal string in normalized (human) units. For buy orders this is in contraAsset units; for sell orders this is in targetAsset units.",
  },
  orderType: { type: "string", enum: [...ORDER_TYPES], description: 'Default "market".' },
  maxSlippage: { type: "string", description: "Slippage tolerance as a decimal (0.05 = 5%). Default 0.05." },
  maxPriceImpact: { type: "string", description: "Max price impact as a decimal (0.05 = 5%). Default 0.05." },
  limitNotionalPrice: {
    type: "string",
    description: "USD limit price for the traded asset. Required for limit orders; optional for stop / stop-loss / take-profit.",
  },
} as const;

const TOOLS: ToolDef[] = [
  {
    name: "definitive_quote",
    description:
      "Get a live Definitive Flash swap quote (price, amounts, estimated fee, quoteId). READ-ONLY — does not execute anything. Use this to preview a trade before calling definitive_swap. Defaults to Base. Requires the connected wallet to set funderAddress.",
    inputSchema: {
      type: "object",
      required: ["targetAsset", "contraAsset", "side", "qty"],
      properties: { ...swapArgProps },
    },
    run: async (args) => {
      const order = buildOrderParams(args);
      const funderAddress = await funderWallet();
      const q = (await flashFetch("POST", "/quote", { ...order, funderAddress })) as QuoteResponse;
      return summarizeQuote(q);
    },
  },
  {
    name: "definitive_swap",
    description:
      "START a non-custodial swap on Definitive Flash. Fetches a fresh quote and kicks off the first wallet approval, returning an `approvalUrl` the user must approve in their Base wallet. Bunny never holds a key. A swap needs up to three sequential approvals: a one-time token approval (only the first time you trade a token), a Permit2 signature, and the order signature (already-approved tokens skip step 1, so most swaps are just 2). MULTI-STEP — YOU MUST DRIVE THE LOOP: after the user says they approved/signed (or clicked the link), immediately call definitive_finalize. If it returns `{ pending: true }`, the step hasn't landed yet — wait briefly and call definitive_finalize AGAIN; do not give up after one try. If it returns a new `approvalUrl`, show it and have the user approve the next step, then call definitive_finalize again. Repeat until it returns `{ done: true }`. Never stop after the first approval. ALWAYS confirm asset, side, and qty (and show a definitive_quote) with the user before calling. The trader is the user's own connected wallet (no wallet arg).",
    inputSchema: {
      type: "object",
      required: ["targetAsset", "contraAsset", "side", "qty"],
      properties: { ...swapArgProps },
    },
    run: async (args) => {
      const uid = getActiveUserId();
      if (!uid) throw new Error("no active user");
      const order = buildOrderParams(args);
      const funderAddress = await funderWallet();
      const q = (await flashFetch("POST", "/quote", { ...order, funderAddress })) as QuoteResponse;
      if (!q.evm) {
        throw new Error("Flash returned no EVM signing payload for this quote");
      }
      const p: Pending = {
        kind: "swap",
        stepKind: "order",
        requestId: "",
        approvalUrl: null,
        at: Date.now(),
        swap: {
          order,
          quoteId: q.quoteId,
          funderAddress,
          evm: {
            approveTx: q.evm.approveTx ?? null,
            permitTypedData: q.evm.permitTypedData ?? null,
            orderTypedData: q.evm.orderTypedData ?? null,
          },
          approveDone: false,
          permitSig: null,
          orderSig: null,
        },
      };
      prunePending();
      pending.set(uid, p);
      const next = await advanceSwap(uid, p);
      return { quote: summarizeQuote(q), ...next };
    },
  },
  {
    name: "definitive_finalize",
    description:
      "Advance the user's pending Definitive Flash swap (or cancel) after they approve a step in their Base wallet. Polls the outstanding approval; if it isn't ready yet it returns { pending: true } (wait for the user to approve, then call again). When a step completes it either returns the next `approvalUrl` to approve or, once all signatures are collected, submits the order and returns { done: true, orderId }. Call this whenever the user says they've approved / signed.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description: "Optional. The Base wallet request id, only needed if the pending step lost its request id.",
        },
      },
    },
    run: async (args) => {
      const uid = getActiveUserId();
      if (!uid) throw new Error("no active user");
      prunePending();
      const p = pending.get(uid);
      if (!p) {
        throw new Error("no pending Definitive Flash flow — start one with definitive_swap or definitive_cancel_order");
      }
      const requestId = p.requestId || optStr(args, "requestId") || "";
      if (!requestId) {
        throw new Error("missing request id for the pending step — pass requestId, or restart with definitive_swap");
      }
      if (!p.requestId) p.requestId = requestId;

      if (p.kind === "cancel") {
        const r = await pollStep(requestId, (c) => extractSignature(c) !== null);
        if (r.state === "failed") {
          pending.delete(uid);
          throw new Error("the cancel signature was rejected or expired — start over with definitive_cancel_order");
        }
        if (r.state === "timeout") {
          return {
            pending: true,
            step: "cancel",
            approvalUrl: p.approvalUrl,
            note: "Still waiting for your cancel signature. Approve it in your Base wallet, then call definitive_finalize again.",
          };
        }
        const sig = extractSignature(r.content)!;
        const res = await flashFetch(
          "POST",
          `/orders/${encodeURIComponent(p.cancel!.orderId)}/cancel`,
          { cancelMessage: p.cancel!.cancelMessage, userSignature: sig },
        );
        pending.delete(uid);
        return { done: true, cancelled: true, orderId: p.cancel!.orderId, result: res };
      }

      const sw = p.swap!;
      if (p.stepKind === "approve") {
        const r = await pollStep(requestId, txSubmitted);
        if (r.state === "failed") {
          pending.delete(uid);
          throw new Error("the token approval was rejected or expired — start over with definitive_swap");
        }
        if (r.state === "timeout") {
          return {
            pending: true,
            step: "approve",
            approvalUrl: p.approvalUrl,
            note: "Still waiting for the token approval to land on-chain. Once your wallet shows it confirmed, call definitive_finalize again.",
          };
        }
        sw.approveDone = true;
      } else {
        // permit or order signature step
        const r = await pollStep(requestId, (c) => extractSignature(c) !== null);
        if (r.state === "failed") {
          pending.delete(uid);
          throw new Error(`the ${p.stepKind} signature was rejected or expired — start over with definitive_swap`);
        }
        if (r.state === "timeout") {
          return {
            pending: true,
            step: p.stepKind,
            approvalUrl: p.approvalUrl,
            note: `Still waiting for your ${p.stepKind} signature. Approve it in your Base wallet, then call definitive_finalize again.`,
          };
        }
        const sig = extractSignature(r.content)!;
        if (p.stepKind === "permit") sw.permitSig = sig;
        else sw.orderSig = sig;
      }
      return advanceSwap(uid, p);
    },
  },
  {
    name: "definitive_orders",
    description:
      "List the connected wallet's Definitive Flash orders (status + history). Optional `statuses` filter and `pageSize`.",
    inputSchema: {
      type: "object",
      properties: {
        statuses: {
          type: "string",
          description: "Optional comma-separated status filter (e.g. ORDER_STATUS_PENDING,ORDER_STATUS_FILLED).",
        },
        pageSize: { type: "number", description: "Max orders to return." },
      },
    },
    run: async (args) => {
      const funderAddress = await funderWallet();
      const qs = new URLSearchParams({ funderAddress });
      const statuses = optStr(args, "statuses");
      if (statuses) qs.set("statuses", statuses);
      const pageSize = args["pageSize"];
      if (typeof pageSize === "number" && Number.isFinite(pageSize) && pageSize > 0) {
        qs.set("pageSize", String(Math.floor(pageSize)));
      }
      return flashFetch("GET", `/orders?${qs.toString()}`);
    },
  },
  {
    name: "definitive_order_status",
    description: "Get the status and fill detail of a single Definitive Flash order by orderId for the connected wallet.",
    inputSchema: {
      type: "object",
      required: ["orderId"],
      properties: { orderId: { type: "string", description: "The Flash orderId returned at submit time." } },
    },
    run: async (args) => {
      const funderAddress = await funderWallet();
      const orderId = reqStr(args, "orderId");
      const qs = new URLSearchParams({ funderAddress });
      return flashFetch("GET", `/orders/${encodeURIComponent(orderId)}?${qs.toString()}`);
    },
  },
  {
    name: "definitive_cancel_order",
    description:
      "START cancellation of an open Definitive Flash order. Returns an `approvalUrl` for the user to sign the cancel message in their Base wallet; after they sign, call definitive_finalize to submit the cancellation.",
    inputSchema: {
      type: "object",
      required: ["orderId"],
      properties: { orderId: { type: "string", description: "The Flash orderId to cancel." } },
    },
    run: async (args) => {
      const uid = getActiveUserId();
      if (!uid) throw new Error("no active user");
      await funderWallet();
      const orderId = reqStr(args, "orderId");
      // Exact format Flash expects for the signed cancel message.
      const cancelMessage = `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;
      const step = await initiateSign("personal_sign", { message: cancelMessage });
      prunePending();
      pending.set(uid, {
        kind: "cancel",
        stepKind: "cancel",
        requestId: step.requestId,
        approvalUrl: step.approvalUrl,
        at: Date.now(),
        cancel: { orderId, cancelMessage },
      });
      return {
        pending: true,
        step: "cancel",
        note: "Sign the cancel message in your Base wallet, then call definitive_finalize.",
        approvalUrl: step.approvalUrl,
      };
    },
  },
];

const toolIndex = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function listDefinitiveTools(): DefinitiveTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findDefinitiveTool(name: string): boolean {
  return toolIndex.has(name);
}

export function definitiveStatus(): { connected: boolean; toolCount: number } {
  // Always reachable — uses the operator's integrator key (or the public
  // fallback). No per-user key required.
  return { connected: true, toolCount: TOOLS.length };
}

export async function callDefinitiveTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = toolIndex.get(name);
  if (!tool) {
    return { isError: true, content: `Unknown Definitive tool: ${name}` };
  }
  try {
    const result = await tool.run(args ?? {});
    return { isError: false, content: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err }, "Definitive Flash tool failed");
    return { isError: true, content: `Definitive Flash request failed: ${message}` };
  }
}
