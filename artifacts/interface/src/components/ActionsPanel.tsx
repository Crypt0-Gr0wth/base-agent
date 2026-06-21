import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { playSound } from "@/lib/sound";
import { useT, type TFn } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { ActionMarkdown } from "./ActionMarkdown";
import { useTabs } from "./TabsContext";
const BUNNY_TAB: {
  id: "bunny";
  title: string;
  titleKey: string;
  kind: "bunny";
  closable: boolean;
} = {
  id: "bunny",
  title: "bunnyEX",
  titleKey: "tabs.bunny",
  kind: "bunny",
  closable: false,
};
import { Check, Copy, EyeOff, Play, X } from "lucide-react";
import { useState } from "react";

type ActionKind = "alert" | "recommendation";
type Status = "pending" | "executed" | "dismissed";

interface TokenRef {
  symbol: string;
  address: string;
  chain?: string;
}

interface BunnyAction {
  id: string;
  kind: ActionKind;
  title: string;
  description: string;
  source: string;
  push: boolean;
  executeInstructions: string;
  tokens?: TokenRef[];
  createdAt: string;
  status: Status;
}

function shortAddress(addr: string): string {
  if (addr.length <= 13) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function TokensMentioned({ tokens }: { tokens: TokenRef[] }) {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  if (!tokens || tokens.length === 0) return null;

  const copy = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(addr);
      setTimeout(() => setCopied((c) => (c === addr ? null : c)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="space-y-1">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
        {t("actions.tokensMentioned")}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tokens.map((tok, i) => (
          <button
            key={`${tok.address}-${i}`}
            onClick={() => void copy(tok.address)}
            title={t("actions.copyTokenTitle", {
              address: tok.address,
              chain: tok.chain ? ` · ${tok.chain}` : "",
            })}
            className="group/token flex items-center gap-1.5 font-mono text-[10px] border border-border/50 rounded px-1.5 py-0.5 bg-background/40 hover:border-foreground/30 transition-colors"
          >
            <span className="text-foreground">{tok.symbol}</span>
            <span className="text-muted-foreground/70">
              {shortAddress(tok.address)}
            </span>
            {copied === tok.address ? (
              <Check className="h-2.5 w-2.5 text-green" />
            ) : (
              <Copy className="h-2.5 w-2.5 text-muted-foreground/50 group-hover/token:text-foreground" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ActionsState {
  actions: BunnyAction[];
}

function relativeTime(iso: string | null, t: TFn): string {
  if (!iso) return t("actions.never");
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t("actions.justNow");
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t("actions.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("actions.hoursAgo", { n: hours });
  return t("actions.daysAgo", { n: Math.floor(hours / 24) });
}

const KIND_DOT: Record<ActionKind, string> = {
  alert: "text-yellow",
  recommendation: "text-green",
};

export function ActionsPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const setChatInput = useAppStore((s) => s.setChatInput);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const { setActive, openTab } = useTabs();

  const { data } = useQuery({
    queryKey: ["/api/actions"],
    queryFn: async (): Promise<ActionsState> => {
      const r = await fetch("/api/actions");
      if (!r.ok) return { actions: [] };
      return (await r.json()) as ActionsState;
    },
    refetchInterval: 30_000,
  });

  // Recommendations posted by bunnies, aggregated server-side. These ids live in
  // bunnyOS, not the local actions table: body-type recs can be executed (paste
  // into chat + mark done via the bunny endpoint), contract-call recs are
  // display-only and there's no hide control.
  const { data: bunnyData } = useQuery({
    queryKey: ["/api/bunny/recommendations"],
    queryFn: async (): Promise<{ recommendations: BunnyAction[] }> => {
      const r = await fetch("/api/bunny/recommendations");
      if (!r.ok) return { recommendations: [] };
      return (await r.json()) as { recommendations: BunnyAction[] };
    },
    refetchInterval: 60_000,
  });
  const fromBunnies = bunnyData?.recommendations ?? [];

  // Whether this user's wallet is connected to bunny exchange (has a stored
  // bunnyOS JWT). When disconnected the from-bunnies feed is always empty, so we
  // show a "connect on bunny exchange" CTA instead of the no-signals hint.
  const { data: bunnyStatus } = useQuery({
    queryKey: ["/api/bunny/bunnyos/status"],
    queryFn: async (): Promise<{ connected: boolean }> => {
      const r = await fetch("/api/bunny/bunnyos/status");
      if (!r.ok) return { connected: false };
      return (await r.json()) as { connected: boolean };
    },
    refetchInterval: 30_000,
  });
  // Only treat as disconnected once the status query resolves to false —
  // unknown/loading falls through to the normal empty hint so connected users
  // with an empty feed never flash the connect CTA.
  const bunnyDisconnected = bunnyStatus?.connected === false;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/actions"] });
  const openBunnyExchange = () => {
    openTab(BUNNY_TAB);
    setActive(BUNNY_TAB.id);
  };

  const executeAction = async (a: BunnyAction) => {
    playSound("confirm");
    setChatInput(a.executeInstructions || a.title);
    setChatOpen(true);
    queueMicrotask(() => {
      document.getElementById("chat-input")?.focus();
    });
    await fetch(`/api/actions/${a.id}/execute`, { method: "POST" });
    refresh();
  };

  // Execute a from-bunnies recommendation. Same UX as executeAction (paste the
  // body into the chat composer), but these ids live in bunnyOS, not the local
  // actions table, so we mark them done via the bunny endpoint and reconcile the
  // separate query cache. Optimistically drop the row so it disappears at once.
  const executeBunnyRecommendation = async (a: BunnyAction) => {
    playSound("confirm");
    setChatInput(a.executeInstructions || a.title);
    setChatOpen(true);
    queueMicrotask(() => {
      document.getElementById("chat-input")?.focus();
    });
    await queryClient.cancelQueries({ queryKey: ["/api/bunny/recommendations"] });
    queryClient.setQueryData<{ recommendations: BunnyAction[] }>(
      ["/api/bunny/recommendations"],
      (old) =>
        old
          ? { recommendations: old.recommendations.filter((x) => x.id !== a.id) }
          : old,
    );
    try {
      const r = await fetch(
        `/api/bunny/recommendations/${encodeURIComponent(a.id)}/execute`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`execute failed: ${r.status}`);
    } catch {
      // Reconcile below — a failed mark-done refetches and the row reappears.
    } finally {
      queryClient.invalidateQueries({
        queryKey: ["/api/bunny/recommendations"],
      });
    }
  };

  // Dismiss a from-bunnies recommendation without executing it. Reuses the same
  // per-user done-flag endpoint as execute (it only records the inbox id), so the
  // item disappears from the feed and won't reappear — the difference is purely
  // that we don't paste anything into chat. Works for any rec, including the
  // display-only contract-call ones. Optimistic: drop the row immediately.
  const dismissBunnyRecommendation = async (a: BunnyAction) => {
    playSound("click");
    await queryClient.cancelQueries({ queryKey: ["/api/bunny/recommendations"] });
    queryClient.setQueryData<{ recommendations: BunnyAction[] }>(
      ["/api/bunny/recommendations"],
      (old) =>
        old
          ? { recommendations: old.recommendations.filter((x) => x.id !== a.id) }
          : old,
    );
    try {
      const r = await fetch(
        `/api/bunny/recommendations/${encodeURIComponent(a.id)}/execute`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`dismiss failed: ${r.status}`);
    } catch {
      // Reconcile below — a failed mark-done refetches and the row reappears.
    } finally {
      queryClient.invalidateQueries({
        queryKey: ["/api/bunny/recommendations"],
      });
    }
  };

  // "hide" — soft-delete from the live inbox. The row stays in history
  // forever and can be unhidden from the history view. Optimistic: drop the
  // row from the cache immediately so the UI feels instant, then sync with
  // the server in the background and reconcile on error.
  const hideAction = async (a: BunnyAction) => {
    playSound("click");
    await queryClient.cancelQueries({ queryKey: ["/api/actions"] });
    const prev = queryClient.getQueryData<ActionsState>(["/api/actions"]);
    queryClient.setQueryData<ActionsState>(["/api/actions"], (old) =>
      old
        ? {
            ...old,
            actions: old.actions.map((x) =>
              x.id === a.id ? { ...x, status: "dismissed" } : x,
            ),
          }
        : old,
    );
    try {
      const r = await fetch(`/api/actions/${a.id}/dismiss`, { method: "POST" });
      if (!r.ok) throw new Error(`dismiss failed: ${r.status}`);
    } catch {
      // Roll back just this row (not the whole snapshot, which could clobber a
      // concurrent hide) so the failed item reappears.
      queryClient.setQueryData<ActionsState>(["/api/actions"], (old) =>
        old
          ? {
              ...old,
              actions: old.actions.map((x) =>
                x.id === a.id ? { ...x, status: "pending" } : x,
              ),
            }
          : old,
      );
    } finally {
      // Reconcile with server truth. The optimistic update already made the UI
      // feel instant; this background refetch closes the race where the 30s
      // poll could otherwise resurrect the row with pre-dismiss data.
      refresh();
    }
  };

  // "hide all" — clear every pending row from the live inbox in one shot.
  // Same optimistic pattern: empty the inbox instantly, sync in the background,
  // roll back the whole snapshot on error.
  const hideAll = async () => {
    playSound("click");
    await queryClient.cancelQueries({ queryKey: ["/api/actions"] });
    const prev = queryClient.getQueryData<ActionsState>(["/api/actions"]);
    queryClient.setQueryData<ActionsState>(["/api/actions"], (old) =>
      old
        ? {
            ...old,
            actions: old.actions.map((x) =>
              x.status === "pending" ? { ...x, status: "dismissed" } : x,
            ),
          }
        : old,
    );
    try {
      const r = await fetch("/api/actions/dismiss-all", { method: "POST" });
      if (!r.ok) throw new Error(`dismiss-all failed: ${r.status}`);
    } catch {
      if (prev) queryClient.setQueryData(["/api/actions"], prev);
    } finally {
      refresh();
    }
  };

  const pending = (data?.actions ?? []).filter(
    (a) => a.status === "pending" && a.push,
  );
  const recommendations = pending.filter((a) => a.kind === "recommendation");
  const alerts = pending.filter((a) => a.kind === "alert");

  return (
    <div className="h-full flex flex-col bg-background">
      <PageHeader
        title={t("actions.actionsInbox")}
        subtitle={t("actions.inboxSubtitle")}
        actions={
          pending.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={hideAll}
              className="h-7 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              title={t("actions.hideAllTitle")}
            >
              <EyeOff className="h-3 w-3 mr-1" />
              {t("actions.hideAll")}
            </Button>
          ) : undefined
        }
      />

      {/* Three columns on wide screens (native | bunny | alerts), each
          scrolling independently; collapses to a single scrolling stack on
          narrow screens (mobile pane). */}
      <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden p-3">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 lg:h-full lg:min-h-0">
          <div className="space-y-5 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <ActionSection
              label={t("actions.recommendations")}
              sublabel={t("actions.recommendationsSublabel")}
              items={recommendations}
              executable
              emptyHint={t("actions.recommendationsEmpty")}
              onExecute={executeAction}
              onHide={hideAction}
            />
          </div>
          <div className="space-y-5 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <ActionSection
              label={t("actions.fromBunnies")}
              sublabel={t("actions.fromBunniesSublabel")}
              items={fromBunnies}
              executable
              readOnly
              executeRequiresInstructions
              emptyHint={t("actions.fromBunniesEmpty")}
              onExecute={executeBunnyRecommendation}
              onHide={hideAction}
              onDismiss={dismissBunnyRecommendation}
              disconnected={bunnyDisconnected}
              disconnectedHint={t("actions.fromBunniesDisconnected")}
              disconnectedCta={t("actions.fromBunniesConnectCta")}
              onDisconnectedCta={openBunnyExchange}
            />
          </div>
          <div className="space-y-5 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <ActionSection
              label={t("actions.alerts")}
              sublabel={t("actions.alertsSublabel")}
              items={alerts}
              executable={false}
              emptyHint={t("actions.alertsEmpty")}
              onExecute={executeAction}
              onHide={hideAction}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionSection({
  label,
  items,
  executable,
  emptyHint,
  onExecute,
  onHide,
  onDismiss,
  readOnly = false,
  executeRequiresInstructions = false,
  disconnected = false,
  disconnectedHint,
  disconnectedCta,
  onDisconnectedCta,
}: {
  label: string;
  sublabel: string;
  items: BunnyAction[];
  executable: boolean;
  emptyHint: string;
  onExecute: (a: BunnyAction) => void;
  onHide: (a: BunnyAction) => void;
  // Optional dismiss handler for read-only (from-bunnies) items: records the
  // per-user done-flag so the rec disappears without pasting into chat. Works for
  // every rec, including the display-only contract-call ones.
  onDismiss?: (a: BunnyAction) => void;
  // Read-only items live in bunnyOS (not the local actions table), so they
  // render without a hide control — dismissing them would 404.
  readOnly?: boolean;
  // When disconnected (wallet not connected to bunny exchange) and the list is
  // empty, show a connect CTA that routes to the bunnyEX tab instead of the
  // plain no-signals hint — the feed can only ever be empty in this state.
  disconnected?: boolean;
  disconnectedHint?: string;
  disconnectedCta?: string;
  onDisconnectedCta?: () => void;
  // When set, only items that carry executeInstructions get an Execute button.
  // Used by the from-bunnies feed where contract-call recs aren't executable.
  executeRequiresInstructions?: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div className="px-1 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground">
          {label}
          <span className="ml-1.5 text-muted-foreground">({items.length})</span>
        </span>
      </div>
      {items.length === 0 && disconnected && onDisconnectedCta ? (
        <div className="border border-dashed border-border/60 rounded-md px-3 py-4 text-center space-y-2">
          <div className="font-mono text-[10px] text-muted-foreground/70 leading-relaxed">
            {disconnectedHint ?? emptyHint}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onDisconnectedCta}
            className="h-6 px-2 font-mono text-[10px]"
          >
            {disconnectedCta}
          </Button>
        </div>
      ) : (
        items.length === 0 && (
          <div className="border border-dashed border-border/60 rounded-md px-3 py-4 text-center">
            <span className="font-mono text-[10px] text-muted-foreground/70 leading-relaxed">
              {emptyHint}
            </span>
          </div>
        )
      )}
      {items.map((a) => {
        // For from-bunnies, only body-type recs (with executeInstructions) are
        // executable; contract-call recs stay display-only.
        const showExecute =
          executable && (!executeRequiresInstructions || !!a.executeInstructions);
        // Hide the "execute" preview box when it would just duplicate the body
        // (true for from-bunnies, where instructions === description).
        const showExecuteBox =
          showExecute &&
          !!a.executeInstructions &&
          a.executeInstructions !== a.description;
        return (
        <div
          key={a.id}
          className="border border-border rounded-md p-3 bg-foreground/5 space-y-2 group"
        >
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "font-mono text-sm leading-none mt-0.5",
                KIND_DOT[a.kind],
              )}
            >
              ●
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-foreground font-medium leading-snug break-words">
                {a.title}
              </div>
              <div
                className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate"
                title={a.source}
              >
                {t("actions.fromSource", { source: a.source })}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground/70 mt-0.5">
                {relativeTime(a.createdAt, t)}
              </div>
            </div>
            {!readOnly && (
              <button
                onClick={() => onHide(a)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-0.5 -m-0.5"
                aria-label={t("actions.hide")}
                title={t("actions.hideFromInbox")}
              >
                <EyeOff className="h-3 w-3" />
              </button>
            )}
            {readOnly && onDismiss && (
              <button
                onClick={() => onDismiss(a)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-0.5 -m-0.5"
                aria-label={t("actions.dismiss")}
                title={t("actions.dismissTitle")}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <ActionMarkdown
            source={a.description}
            className="font-mono text-[11px] text-foreground/80 leading-relaxed break-words"
          />
          {a.tokens && a.tokens.length > 0 && (
            <TokensMentioned tokens={a.tokens} />
          )}
          {showExecuteBox && (
            <div className="font-mono text-[10px] text-muted-foreground/80 bg-background/40 border border-border/40 rounded px-2 py-1 leading-relaxed break-words">
              <span className="text-muted-foreground">{t("actions.executeLabel")}</span>{" "}
              <span className="text-foreground/80">{a.executeInstructions}</span>
            </div>
          )}
          {(showExecute || !readOnly || (readOnly && onDismiss)) && (
            <div className="flex items-center gap-2">
              {showExecute && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onExecute(a)}
                  className="h-6 px-2 font-mono text-[10px]"
                  title={t("actions.executeInstructionsTitle")}
                >
                  <Play className="h-2.5 w-2.5 mr-1" />
                  {t("actions.execute")}
                </Button>
              )}
              {!readOnly && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onHide(a)}
                  className="h-6 px-2 font-mono text-[10px] text-muted-foreground"
                  title={t("actions.hideFromInbox")}
                >
                  {t("actions.hide")}
                </Button>
              )}
              {readOnly && onDismiss && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDismiss(a)}
                  className="h-6 px-2 font-mono text-[10px] text-muted-foreground"
                  title={t("actions.dismissTitle")}
                >
                  <X className="h-2.5 w-2.5 mr-1" />
                  {t("actions.dismiss")}
                </Button>
              )}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
