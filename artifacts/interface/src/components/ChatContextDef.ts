import { createContext, useContext } from "react";

// The chat context object and useChat hook live here, isolated from the
// ChatProvider implementation (and its @/i18n dependency), on purpose: keeping
// them in a module with no hot-reloaded deps means the context identity stays
// stable across Fast Refresh. Otherwise a locale/i18n HMR update re-evaluates
// the provider module, mints a new context object, and useChat consumers read
// null -> "useChat must be used within a ChatProvider".

export type ChatSummary = { id: string; title: string; updatedAt: string };
export type StoredSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: "user" | "bunny";
    text: string;
    timestamp: string;
    tools?: ToolEvent[];
  }>;
};

export type ToolEvent = {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  isError?: boolean;
  done: boolean;
};

export interface ChatMessage {
  id: string;
  role: "user" | "bunny";
  text: string;
  timestamp: string;
  tools?: ToolEvent[];
  thinking?: boolean;
  streaming?: boolean;
}

// Match any URL on a Base/Coinbase approval host. Server-side, the agent
// extracts these from tool results and appends them to the final reply if
// missing, so as long as the host is in this set we'll render a button.
export const APPROVAL_URL_RE =
  /(https:\/\/(?:account\.base\.app|base\.org|www\.base\.org|wallet\.base\.org|account\.base\.org|keys\.coinbase\.com|wallet\.coinbase\.com)\/[^\s)\]"']+)/g;

export interface ChatContextValue {
  messages: ChatMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  chatList: ChatSummary[] | undefined;
  handleSubmit: (overrideText?: string) => Promise<void>;
  startNewChat: () => void;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string, e: React.MouseEvent) => Promise<void>;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within a ChatProvider");
  return ctx;
}
