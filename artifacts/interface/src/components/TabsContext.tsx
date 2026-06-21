import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Tab = {
  id: string;
  title: string;
  // i18n key for static/seeded tab titles (e.g. "tabs.research" or
  // "common.configure"). When present, the TabBar renders the translated
  // string and falls back to `title` otherwise. Dynamic tabs (protocol tabs
  // titled from live data) leave this undefined.
  titleKey?: string;
  kind:
    | "home"
    | "protocol"
    | "settings"
    | "chat"
    | "actions-inbox"
    | "tokens"
    | "perps"
    | "bunny"
    | "bunnyds";
  payload?: { protocolId: string };
  // false → no close button in TabBar and closeTab is a no-op.
  // Defaults to true for backward compatibility; `home` is always non-closable
  // regardless (legacy hard-coded behavior in closeTab).
  closable?: boolean;
  // true → not rendered in TabBar while kept in state.
  hidden?: boolean;
};

type TabsContextValue = {
  tabs: Tab[];
  activeId: string;
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  // Reorder by dragging: move `fromId` so it lands immediately before
  // `toId`. No-op if either id is missing or they're already adjacent
  // in the requested direction.
  moveTab: (fromId: string, toId: string) => void;
  // Rewrite the order of visible tabs from a Framer Motion Reorder list.
  // Hidden tabs keep their positions; visible slots are refilled from the
  // new id order. Used by the draggable TabBar.
  reorderVisible: (orderedVisibleIds: string[]) => void;
};

const HOME_TAB: Tab = {
  id: "home",
  title: "main",
  titleKey: "tabs.main",
  kind: "home",
};
const SETTINGS_TAB: Tab = {
  id: "settings",
  title: "configure",
  titleKey: "common.configure",
  kind: "settings",
  closable: false,
};
const ACTION_INBOX_TAB: Tab = {
  id: "actions-inbox",
  title: "action inbox",
  titleKey: "tabs.actionInbox",
  kind: "actions-inbox",
  closable: false,
};
const TOKENS_TAB: Tab = {
  id: "tokens",
  title: "research",
  titleKey: "tabs.research",
  kind: "tokens",
  closable: false,
};
const PERPS_TAB: Tab = {
  id: "perps",
  title: "perps",
  titleKey: "tabs.perps",
  kind: "perps",
  closable: false,
};
const BUNNY_TAB: Tab = {
  id: "bunny",
  title: "bunnyEX",
  titleKey: "tabs.bunny",
  kind: "bunny",
  closable: false,
};
const BUNNYDS_TAB: Tab = {
  id: "bunnyds",
  title: "bunnyDS",
  titleKey: "tabs.bunnyds",
  kind: "bunnyds",
  closable: false,
};
const TabsContext = createContext<TabsContextValue | null>(null);

export function TabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([
    HOME_TAB,
    ACTION_INBOX_TAB,
    TOKENS_TAB,
    BUNNY_TAB,
    BUNNYDS_TAB,
    SETTINGS_TAB,
  ]);
  // First-time sign-ups arrive at /terminal?welcome=1 (set by the OAuth opener
  // for brand-new users). Land them on the bunnyDS tab instead of home, then
  // strip the flag so a later refresh doesn't re-trigger it.
  const [activeId, setActiveId] = useState<string>(() => {
    if (typeof window === "undefined") return "home";
    return new URLSearchParams(window.location.search).has("welcome")
      ? "bunnyds"
      : "home";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("welcome")) return;
    params.delete("welcome");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, []);

  const openTab = useCallback((tab: Tab) => {
    setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    if (id === "home") return;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      if (prev[idx]?.closable === false) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveId((curr) => {
        if (curr !== id) return curr;
        const neighbor = prev[idx + 1] ?? prev[idx - 1] ?? HOME_TAB;
        return neighbor.id;
      });
      return next;
    });
  }, []);

  const setActive = useCallback((id: string) => setActiveId(id), []);

  const moveTab = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === fromId);
      const to = prev.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      // After removing `from`, the original `to` index shifts left by one
      // if it was after `from`. Insert before the (now-adjusted) target.
      const insertAt = from < to ? to - 1 : to;
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  const reorderVisible = useCallback((orderedVisibleIds: string[]) => {
    setTabs((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      let cursor = 0;
      // Walk the original list. Hidden tabs stay put; each visible slot is
      // refilled in turn from the new id order. Unknown ids are skipped, and
      // any leftover visible slots fall back to the original tab so we never
      // drop one on the floor.
      return prev.map((t) => {
        if (t.hidden) return t;
        while (
          cursor < orderedVisibleIds.length &&
          !byId.has(orderedVisibleIds[cursor]!)
        ) {
          cursor++;
        }
        const nextId = orderedVisibleIds[cursor++];
        return nextId ? byId.get(nextId) ?? t : t;
      });
    });
  }, []);

  const value = useMemo(
    () => ({
      tabs,
      activeId,
      openTab,
      closeTab,
      setActive,
      moveTab,
      reorderVisible,
    }),
    [
      tabs,
      activeId,
      openTab,
      closeTab,
      setActive,
      moveTab,
      reorderVisible,
    ],
  );

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("useTabs must be used inside <TabsProvider>");
  return ctx;
}
