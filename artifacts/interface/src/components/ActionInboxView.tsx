import { useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { playSound } from "@/lib/sound";
import { ActionsPanel } from "./ActionsPanel";
import { ActionsHistoryView } from "./ActionsHistoryView";
import { ActionsBuilderView } from "./ActionsBuilderView";

type View = "inbox" | "builder" | "history";

const VIEW_LABELS: Record<View, string> = {
  inbox: "tabs.inbox",
  builder: "tabs.builder",
  history: "tabs.history",
};

// Action inbox page: the live signal feed (ActionsPanel), the action builder
// (ActionsBuilderView), and the historical log (ActionsHistoryView) merged
// behind a single segmented toggle so they live on one page instead of
// separate tabs.
export function ActionInboxView() {
  const t = useT();
  const [view, setView] = useState<View>("inbox");
  const select = (v: View) => {
    if (v === view) return;
    playSound("click");
    setView(v);
  };
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      <div className="px-4 py-2 border-b border-border/50 shrink-0 flex items-center gap-1.5">
        {(["inbox", "builder", "history"] as const).map((v) => (
          <button
            key={v}
            onClick={() => select(v)}
            className={cn(
              "font-mono text-[11px] px-3 py-1 rounded border transition-colors",
              view === v
                ? "bg-foreground/10 border-foreground/30 text-foreground"
                : "bg-transparent border-border/40 text-muted-foreground/70 hover:text-foreground",
            )}
          >
            {t(VIEW_LABELS[v])}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {view === "inbox" && <ActionsPanel />}
        {view === "builder" && <ActionsBuilderView />}
        {view === "history" && <ActionsHistoryView />}
      </div>
    </div>
  );
}
