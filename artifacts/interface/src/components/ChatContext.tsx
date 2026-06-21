import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/lib/store";
import { playSound } from "@/lib/sound";
import { useT, useLang } from "@/i18n";
import {
  ChatContext,
  APPROVAL_URL_RE,
  type ChatMessage,
  type ChatSummary,
  type ChatContextValue,
  type StoredSession,
  type ToolEvent,
} from "./ChatContextDef";

type StreamEvent =
  | { type: "model"; model: string }
  | { type: "thinking" }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError?: boolean }
  | { type: "content"; delta: string }
  | { type: "done"; model: string; response: string }
  | { type: "error"; message: string };

// Holds the single, app-wide chat conversation so every surface that renders
// the chat UI (the desktop home column, the mobile chat tab, and the floating
// launcher available on every other page) shares one session, one message
// list and one in-flight stream.
export function ChatProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const { lang } = useLang();
  const queryClient = useQueryClient();
  const chatInput = useAppStore((state) => state.chatInput);
  const setChatInput = useAppStore((state) => state.setChatInput);
  const addFeedEntry = useAppStore((state) => state.addFeedEntry);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [, setLastStatus] = useState<"done" | "error" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const lastUserTextRef = useRef<string>("");
  // Hard lock against a same-tick double submit (e.g. Enter + send-button, or
  // two chat surfaces) firing before `isStreaming` has committed to state.
  const submitLockRef = useRef(false);

  const { data: chatList } = useQuery({
    queryKey: ["/api/chats"],
    queryFn: async () => {
      const r = await fetch("/api/chats");
      if (!r.ok) return [] as ChatSummary[];
      const j = (await r.json()) as unknown;
      return Array.isArray(j) ? (j as ChatSummary[]) : ([] as ChatSummary[]);
    },
    refetchInterval: 30_000,
  });

  const saveCurrentSession = useCallback(
    async (msgs: ChatMessage[], explicitId?: string) => {
      const id = explicitId ?? sessionIdRef.current;
      if (!id || msgs.length === 0) return;
      const payload = {
        messages: msgs.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          ...(m.tools ? { tools: m.tools } : {}),
        })),
      };
      try {
        const r = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`save ${id} failed: HTTP ${r.status}`);
        queryClient.invalidateQueries({ queryKey: ["/api/chats"] });
      } catch (err) {
        console.warn("[chat] persist failed", err);
      }
    },
    [queryClient],
  );

  const ensureSessionId = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const r = await fetch("/api/chats", { method: "POST" });
    const created = (await r.json()) as StoredSession;
    sessionIdRef.current = created.id;
    setSessionId(created.id);
    queryClient.invalidateQueries({ queryKey: ["/api/chats"] });
    return created.id;
  }, [queryClient]);

  const startNewChat = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    sessionIdRef.current = null;
    setSessionId(null);
    setMessages([]);
  }, []);

  const loadChat = useCallback(async (id: string) => {
    if (abortRef.current) abortRef.current.abort();
    try {
      const r = await fetch(`/api/chats/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const s = (await r.json()) as StoredSession;
      sessionIdRef.current = s.id;
      setSessionId(s.id);
      setMessages(
        s.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          ...(m.tools ? { tools: m.tools as ToolEvent[] } : {}),
        })),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const deleteChat = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
        queryClient.invalidateQueries({ queryKey: ["/api/chats"] });
        if (sessionIdRef.current === id) startNewChat();
      } catch {
        /* ignore */
      }
    },
    [queryClient, startNewChat],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const updateBunny = useCallback(
    (id: string, updater: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
    },
    [],
  );

  const handleSubmit = useCallback(
    async (overrideText?: string) => {
      if (isStreaming || submitLockRef.current) return;
      const sourceText = overrideText ?? chatInput;
      if (!sourceText.trim()) return;
      submitLockRef.current = true;

      playSound("confirm");
      const userText = sourceText.trim();
      lastUserTextRef.current = userText;
      const ts = new Date().toTimeString().split(" ")[0] ?? "";
      const userMessage: ChatMessage = {
        id: Math.random().toString(36).substring(7),
        role: "user",
        text: userText,
        timestamp: ts,
      };
      const bunnyId = Math.random().toString(36).substring(7);
      const bunnyMessage: ChatMessage = {
        id: bunnyId,
        role: "bunny",
        text: "",
        timestamp: new Date().toTimeString().split(" ")[0] ?? "",
        tools: [],
        thinking: true,
        streaming: true,
      };

      const priorMessages = messages.slice();
      setMessages((prev) => [...prev, userMessage, bunnyMessage]);
      setChatInput("");
      setIsStreaming(true);
      setLastStatus(null);

      let activeSessionId = "";
      try {
        activeSessionId = await ensureSessionId();
      } catch {
        activeSessionId = sessionIdRef.current ?? "";
      }

      // Local mirror of the bunny message — survives abort / session switch and
      // is the source of truth for the single final save.
      let localBunny: ChatMessage = { ...bunnyMessage };
      const mutateBunny = (updater: (m: ChatMessage) => ChatMessage) => {
        localBunny = updater(localBunny);
        updateBunny(bunnyId, updater);
      };

      const abort = new AbortController();
      abortRef.current = abort;
      let sawDone = false;
      let sawError = false;
      let finalResponse = "";

      const processChunk = (chunk: string) => {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) return;
        const data = dataLine.slice(5).trim();
        if (!data) return;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(data) as StreamEvent;
        } catch {
          return;
        }
        if (ev.type === "thinking") {
          mutateBunny((m) => ({ ...m, thinking: true }));
        } else if (ev.type === "tool_call") {
          mutateBunny((m) => ({
            ...m,
            thinking: false,
            tools: [
              ...(m.tools ?? []),
              { id: ev.id, name: ev.name, args: ev.args, done: false },
            ],
          }));
        } else if (ev.type === "tool_result") {
          mutateBunny((m) => ({
            ...m,
            tools: (m.tools ?? []).map((tl) =>
              tl.id === ev.id
                ? { ...tl, result: ev.content, isError: ev.isError, done: true }
                : tl,
            ),
          }));
        } else if (ev.type === "content") {
          mutateBunny((m) => ({
            ...m,
            thinking: false,
            text: m.text + ev.delta,
          }));
        } else if (ev.type === "done") {
          sawDone = true;
          finalResponse = ev.response;
          mutateBunny((m) => ({
            ...m,
            text: ev.response || m.text,
            thinking: false,
            streaming: false,
          }));
        } else if (ev.type === "error") {
          sawError = true;
          mutateBunny((m) => ({
            ...m,
            text: `error: ${ev.message}`,
            thinking: false,
            streaming: false,
          }));
        }
      };

      try {
        const history = messages
          .filter((m) => m.text && m.text.trim() && !m.text.startsWith("error:"))
          .slice(-20)
          .map((m) => ({
            role: m.role === "user" ? ("user" as const) : ("assistant" as const),
            content: m.text,
          }));
        const resp = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userText, history, lang }),
          signal: abort.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buf += decoder.decode();
            if (buf.trim()) processChunk(buf);
            break;
          }
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            processChunk(chunk);
          }
        }

        if (sawError) {
          setLastStatus("error");
          addFeedEntry({ message: t("chat.feedFailedToRespond"), status: "error" });
        } else if (sawDone) {
          setLastStatus("done");
          let status: "success" | "pending" | "error" = "success";
          const hasApproval = APPROVAL_URL_RE.test(finalResponse);
          APPROVAL_URL_RE.lastIndex = 0;
          if (hasApproval) status = "pending";
          else if (/error|failed/i.test(finalResponse)) status = "error";
          addFeedEntry({ message: t("chat.feedRespondedToUser"), status });
        } else {
          setLastStatus("error");
          mutateBunny((m) => ({
            ...m,
            text: m.text || "(stream ended unexpectedly)",
            thinking: false,
            streaming: false,
          }));
          addFeedEntry({ message: t("chat.feedStreamInterrupted"), status: "error" });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastStatus("error");
        mutateBunny((m) => ({
          ...m,
          text: m.text || `error: ${msg}`,
          thinking: false,
          streaming: false,
        }));
        if (!sawError) addFeedEntry({ message: "Failed to respond", status: "error" });
      } finally {
        // Single, terminal save using a snapshot we own — immune to user
        // switching/clearing chats mid-stream, and only fires once per turn so
        // no out-of-order overwrites are possible. We save on errors too so the
        // failed turn (tool chips + partial text) stays in chat history.
        if (activeSessionId) {
          const finalMessages: ChatMessage[] = [
            ...priorMessages,
            userMessage,
            { ...localBunny, streaming: false, thinking: false },
          ];
          void saveCurrentSession(finalMessages, activeSessionId);
        }
        setIsStreaming(false);
        abortRef.current = null;
        submitLockRef.current = false;
      }
    },
    [
      isStreaming,
      chatInput,
      messages,
      setChatInput,
      ensureSessionId,
      updateBunny,
      saveCurrentSession,
      addFeedEntry,
      t,
      lang,
    ],
  );

  const value: ChatContextValue = {
    messages,
    sessionId,
    isStreaming,
    chatList,
    handleSubmit,
    startNewChat,
    loadChat,
    deleteChat,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
