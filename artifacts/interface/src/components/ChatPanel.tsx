import { useState, useRef, useEffect, Fragment } from "react";
import { useAppStore } from "@/lib/store";
import {
  useChat,
  APPROVAL_URL_RE,
  type ChatMessage,
  type ToolEvent,
} from "./ChatContextDef";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT, type TFn } from "@/i18n";
import {
  ArrowUp,
  ChevronRight,
  Loader2,
  Plus,
  History,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

function approvalLabel(url: string, t: TFn): string {
  if (url.includes("base.app") || url.includes("base.org"))
    return t("chat.approveTransactionInBaseApp");
  return t("chat.openBaseAppToApprove");
}

// Open the wallet approval URL as a centered popup window instead of a new
// browser tab. Falls back to a normal window.open if the browser blocks the
// popup (some engines ignore size hints and just open a tab — that's fine).
function openApprovalPopup(url: string): void {
  const width = 480;
  const height = 720;
  const screenLeft = window.screenLeft ?? window.screenX ?? 0;
  const screenTop = window.screenTop ?? window.screenY ?? 0;
  const viewportW =
    window.innerWidth ?? document.documentElement.clientWidth ?? width;
  const viewportH =
    window.innerHeight ?? document.documentElement.clientHeight ?? height;
  const left = Math.max(0, screenLeft + (viewportW - width) / 2);
  const top = Math.max(0, screenTop + (viewportH - height) / 2);
  const features = [
    "popup=yes",
    `width=${width}`,
    `height=${height}`,
    `left=${Math.round(left)}`,
    `top=${Math.round(top)}`,
    "resizable=yes",
    "scrollbars=yes",
    "noopener",
    "noreferrer",
  ].join(",");
  const win = window.open(url, "bunny-approval", features);
  if (!win) {
    // Popup blocked — fall back to a normal tab so the user can still approve.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// Wallet approval URLs use a few different path formats depending on the
// host (account.base.app uses /wallet-requests/, wallet.base.org uses
// /requests/, some Coinbase wallet flows use /calls/ or /approve/). We need
// the ID to poll status — without it the auto-poll + "check now" controls
// get suppressed and the user just sees a bare approve button.
function extractRequestId(url: string): string | null {
  const m = url.match(/\/(?:wallet-requests|wallet-request|requests|request|calls|approve)\/([a-zA-Z0-9_-]+)/);
  return m?.[1] ?? null;
}

type ApprovalState = "pending" | "confirmed" | "failed";

function classifyStatus(content: string): ApprovalState {
  const lower = content.toLowerCase();
  // Failure FIRST — "rejected" / "failed" can co-occur with words like
  // "completed" in a status envelope, and we never want to mis-mark a
  // rejection as confirmed.
  if (
    /"status"\s*:\s*"(?:failed|reverted|rejected|cancell?ed|expired|denied)"/i.test(
      content,
    ) ||
    /\b(?:reverted|rejected|cancelled|canceled|expired|denied|user[_ ]rejected)\b/i.test(
      lower,
    )
  ) {
    return "failed";
  }
  // Confirmed — explicit status tags, or evidence the chain accepted the tx
  // (a 0x… 64-hex transaction hash field, or wording the wallet uses once
  // the user has approved and the bundler/relayer has submitted it).
  if (
    /"status"\s*:\s*"(?:confirmed|success|completed|complete|submitted|broadcast|broadcasted|approved|done|executed|mined|included)"/i.test(
      content,
    ) ||
    /"(?:transactionhash|txhash|tx_hash|transaction_hash|hash|userophash|userop_hash)"\s*:\s*"0x[0-9a-f]{16,}"/i.test(
      content,
    ) ||
    /\b(?:transaction\s+(?:confirmed|submitted|broadcast|broadcasted|sent|executed|mined|included)|approved\s+by\s+user|user\s+approved|successfully\s+(?:submitted|broadcast|sent|executed))\b/i.test(
      lower,
    )
  ) {
    return "confirmed";
  }
  return "pending";
}

// Best-effort tx-hash extraction from a get_request_status payload. The
// MCP returns a JSON blob whose exact shape varies, but a successful
// receipt always carries a 0x… hex hash under one of these field names.
function extractTxHash(content: string): string | null {
  const m = content.match(
    /"(?:transactionHash|txHash|tx_hash|transaction_hash|userOpHash|userop_hash|hash)"\s*:\s*"(0x[0-9a-fA-F]{16,})"/,
  );
  return m?.[1] ?? null;
}

type DoneState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirmed"; txHash: string | null }
  | { kind: "pending" }
  | { kind: "failed"; reason: string }
  | { kind: "unknown" }; // marked done but the MCP wouldn't tell us

function ApprovalLink({ url }: { url: string }) {
  // We don't auto-poll (the MCP `get_request_status` is inconsistent across
  // wallets) — instead the user clicks "done" themselves, and on that click
  // we fire one status check and surface a congrats / failure / unknown
  // message based on what the MCP returns.
  const t = useT();
  const requestId = extractRequestId(url);
  const [state, setState] = useState<DoneState>({ kind: "idle" });

  const markDone = async () => {
    if (!requestId) {
      setState({ kind: "unknown" });
      return;
    }
    setState({ kind: "checking" });
    try {
      const r = await fetch("/api/base-mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "get_request_status",
          args: { requestId },
        }),
      });
      if (!r.ok) {
        setState({ kind: "unknown" });
        return;
      }
      const j = (await r.json()) as { content?: string; isError?: boolean };
      const raw = j.content ?? "";
      console.log("[approval status] mark done →", raw);
      const cls = classifyStatus(raw);
      if (cls === "confirmed") {
        setState({ kind: "confirmed", txHash: extractTxHash(raw) });
      } else if (cls === "failed") {
        // Try to surface a short reason from the payload.
        const m = raw.match(/"(?:error|message|reason)"\s*:\s*"([^"]{1,160})"/i);
        setState({ kind: "failed", reason: m?.[1] ?? t("chat.transactionFailed") });
      } else {
        setState({ kind: "pending" });
      }
    } catch {
      setState({ kind: "unknown" });
    }
  };

  const interacted = state.kind !== "idle";

  return (
    <div className="block mt-2 mb-2 space-y-1">
      <button
        type="button"
        onClick={() => openApprovalPopup(url)}
        disabled={interacted}
        className="block w-full px-3 py-2 bg-accent text-accent-foreground rounded-md text-xs font-sans font-medium hover:bg-accent/90 transition-colors text-center disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {approvalLabel(url, t)}
      </button>
      <div className="flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-widest text-center">
        {state.kind === "idle" && (
          <button
            type="button"
            onClick={markDone}
            className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
          >
            {t("chat.clickHereOnceDone")}
          </button>
        )}
        {state.kind === "checking" && (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">{t("chat.checkingOnChain")}</span>
          </>
        )}
        {state.kind === "confirmed" && (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-green" />
              <span className="text-green">{t("chat.transactionConfirmed")}</span>
            </div>
            {state.txHash && (
              <a
                href={`https://basescan.org/tx/${state.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline normal-case tracking-normal"
              >
                {t("chat.viewOnBasescan")}
              </a>
            )}
          </div>
        )}
        {state.kind === "pending" && (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">
                {t("chat.stillPendingCheckWallet")}
              </span>
            </div>
            <button
              type="button"
              onClick={markDone}
              className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 normal-case tracking-normal"
            >
              {t("chat.checkAgain")}
            </button>
          </div>
        )}
        {state.kind === "failed" && (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              <span className="text-destructive">
                {state.reason || t("chat.transactionFailed")}
              </span>
            </div>
          </div>
        )}
        {state.kind === "unknown" && (
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-green" />
            <span className="text-green">{t("chat.markedDone")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function parseMessageText(text: string) {
  const parts = text.split(APPROVAL_URL_RE);
  return parts.map((part, i) => {
    if (APPROVAL_URL_RE.test(part)) {
      // .test() consumed the lastIndex on the global regex; reset for next part
      APPROVAL_URL_RE.lastIndex = 0;
      const clean = part.replace(/[.,;:]+$/, "");
      return <ApprovalLink key={i} url={clean} />;
    }
    APPROVAL_URL_RE.lastIndex = 0;
    return <span key={i}>{part}</span>;
  });
}

// --- markdown table support -------------------------------------------------
// The agent sometimes replies with GitHub-style pipe tables. Detect them and
// render real <table>s; everything else stays terminal-style pre-wrap text.

type CellAlign = "left" | "center" | "right";

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // split on unescaped pipes, then unescape \| inside cells
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function parseAlign(sepLine: string): CellAlign[] {
  return splitRow(sepLine).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

type MsgBlock =
  | { type: "text"; text: string }
  | { type: "table"; header: string[]; rows: string[][]; align: CellAlign[] };

function parseMessageBlocks(text: string): MsgBlock[] {
  const lines = text.split("\n");
  const blocks: MsgBlock[] = [];
  let textBuf: string[] = [];
  const flushText = () => {
    const joined = textBuf.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined !== "") blocks.push({ type: "text", text: joined });
    textBuf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (
      line.includes("|") &&
      next !== undefined &&
      isSeparatorRow(next) &&
      !isSeparatorRow(line)
    ) {
      flushText();
      const header = splitRow(line);
      const align = parseAlign(next);
      const rows: string[][] = [];
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--; // for-loop re-increments
      blocks.push({ type: "table", header, rows, align });
      continue;
    }
    textBuf.push(line);
  }
  flushText();
  return blocks;
}

function alignClass(a: CellAlign | undefined): string {
  return a === "center" ? "text-center" : a === "right" ? "text-right" : "text-left";
}

function CellInlines({ text }: { text: string }) {
  const parts = text.split("**");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-foreground">
            {p}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function MarkdownTable({
  header,
  rows,
  align,
}: {
  header: string[];
  rows: string[][];
  align: CellAlign[];
}) {
  return (
    <div className="my-2 overflow-x-auto rounded border border-border">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-foreground/5">
            {header.map((h, i) => (
              <th
                key={i}
                className={cn(
                  "px-2.5 py-1.5 font-mono text-[11px] font-semibold text-foreground whitespace-nowrap",
                  alignClass(align[i]),
                )}
              >
                <CellInlines text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-border/40 last:border-b-0">
              {header.map((_, ci) => (
                <td
                  key={ci}
                  className={cn(
                    "px-2.5 py-1.5 font-mono text-[11px] text-foreground/90 align-top",
                    alignClass(align[ci]),
                  )}
                >
                  <CellInlines text={r[ci] ?? ""} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = parseMessageBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1;
        if (b.type === "table") {
          return (
            <Fragment key={i}>
              <MarkdownTable header={b.header} rows={b.rows} align={b.align} />
              {streaming && isLast && (
                <span className="animate-pulse text-green">▋</span>
              )}
            </Fragment>
          );
        }
        return (
          <div key={i} className="whitespace-pre-wrap">
            {parseMessageText(b.text)}
            {streaming && isLast && (
              <span className="animate-pulse text-green">▋</span>
            )}
          </div>
        );
      })}
    </>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
  } catch {
    return "";
  }
}

function ToolCallChip({ tool }: { tool: ToolEvent }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-border bg-foreground/5 overflow-hidden">
      <button
        onClick={() => tool.done && setOpen((v) => !v)}
        disabled={!tool.done}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-foreground/5 disabled:cursor-default"
      >
        {tool.done ? (
          <ChevronRight
            className={cn("h-3 w-3 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        ) : (
          <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
        )}
        <span
          className={cn(
            "font-mono text-[11px]",
            tool.isError ? "text-destructive" : "text-foreground",
          )}
        >
          {tool.name}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground truncate flex-1">
          {summarizeArgs(tool.args)}
        </span>
        {tool.done && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {tool.isError ? t("chat.toolErr") : t("chat.toolOk")}
          </span>
        )}
      </button>
      {open && tool.done && (
        <div className="px-2 pb-2 space-y-1">
          {tool.args !== undefined && (
            <pre className="font-mono text-[10px] text-muted-foreground bg-background/50 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(tool.args, null, 2)}
            </pre>
          )}
          {tool.result && (
            <pre className="font-mono text-[10px] text-foreground/80 bg-background/50 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Persistent status line under every bunny message so the user always sees
// whether the agent is still working or has stopped — instead of having to
// infer it from the disabled input box or a transient cursor blink.
function BunnyStatusLine({ message }: { message: ChatMessage }) {
  const t = useT();
  const activeTool = (message.tools ?? []).find((tool) => !tool.done);
  if (message.streaming) {
    let label: string;
    if (activeTool) label = t("chat.runningTool", { name: activeTool.name });
    else if (message.thinking || !message.text) label = t("chat.thinking");
    else label = t("chat.responding");
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 pt-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{label}</span>
      </div>
    );
  }
  const text = message.text ?? "";
  const errored =
    text.startsWith("error:") ||
    text.includes("(stream ended unexpectedly)") ||
    text.includes("(bunnyOS is quiet");
  if (errored) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-destructive flex items-center gap-1.5 pt-1">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        <span>{t("chat.stopped")}</span>
      </div>
    );
  }
  if (!text && (message.tools ?? []).length === 0) {
    // Empty bunny message with no tools and not streaming — odd, but mark it
    // so the user knows it's not still spinning.
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 pt-1">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
        <span>{t("chat.stopped")}</span>
      </div>
    );
  }
  return (
    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 pt-1">
      <span className="h-1.5 w-1.5 rounded-full bg-green" />
      <span>{t("chat.statusDone")}</span>
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const chatInput = useAppStore((state) => state.chatInput);
  const setChatInput = useAppStore((state) => state.setChatInput);
  const {
    messages,
    sessionId,
    isStreaming,
    chatList,
    handleSubmit,
    startNewChat,
    loadChat,
    deleteChat,
  } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-4 py-3 border-b border-border/50 shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-sans text-xs font-medium text-muted-foreground uppercase tracking-widest">
            {t("chat.title")}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={startNewChat}
            className="h-7 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3 mr-1" />
            {t("chat.newChat")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              >
                <History className="h-3 w-3 mr-1" />
                {t("chat.history")}
                {chatList && chatList.length > 0 && (
                  <span className="ml-1 text-muted-foreground/60">
                    ({chatList.length})
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 max-h-96 overflow-y-auto">
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("chat.savedChats")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(!chatList || chatList.length === 0) && (
                <div className="px-2 py-3 font-mono text-[11px] text-muted-foreground text-center">
                  {t("chat.noSavedChatsYet")}
                </div>
              )}
              {chatList?.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  onSelect={() => void loadChat(c.id)}
                  className={cn(
                    "font-mono text-[11px] flex items-start gap-2 group cursor-pointer",
                    c.id === sessionId && "bg-accent/30",
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-foreground">{c.title}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={(e) => void deleteChat(c.id, e)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 -m-1"
                    aria-label={t("chat.deleteChat")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center px-6">
            <p className="font-mono text-xs text-muted-foreground text-center max-w-sm leading-relaxed">
              {t("chat.emptyState")}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex flex-col">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs text-muted-foreground">
                {m.timestamp}
              </span>
            </div>
            {m.role === "user" ? (
              <div className="font-mono text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                {`> ${m.text}`}
              </div>
            ) : (
              <div className="space-y-1">
                {(m.tools ?? []).map((tl) => (
                  <ToolCallChip key={tl.id} tool={tl} />
                ))}
                {m.text && (
                  <div className="font-mono text-sm leading-relaxed text-green">
                    <MessageBody text={m.text} streaming={m.streaming} />
                  </div>
                )}
                <BunnyStatusLine message={m} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-border shrink-0 bg-background">
        <div className="flex items-end gap-2 border border-border rounded-lg p-2 focus-within:border-accent transition-colors">
          <textarea
            id="chat-input"
            ref={inputRef}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            placeholder={t("chat.inputPlaceholder")}
            className="flex-1 min-w-0 min-h-[3.75rem] max-h-[160px] bg-transparent px-1 py-1.5 font-mono text-xs leading-5 resize-none focus:outline-none disabled:opacity-50"
            rows={3}
          />
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!chatInput.trim() || isStreaming}
            aria-label={t("chat.send")}
            className={cn(
              "shrink-0 h-9 w-9 rounded-md p-0 grid place-items-center",
              "bg-accent text-accent-foreground shadow-sm",
              "transition-all duration-150",
              "hover:scale-105 hover:shadow active:scale-95",
              "disabled:bg-foreground/10 disabled:text-muted-foreground/60",
              "disabled:hover:scale-100 disabled:shadow-none disabled:cursor-not-allowed",
            )}
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
