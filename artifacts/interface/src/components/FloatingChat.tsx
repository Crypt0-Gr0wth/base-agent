import { X } from "lucide-react";
import { ChatPanel } from "./ChatPanel";
import { useChat } from "./ChatContextDef";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

// A floating chat launcher available on every terminal page. It reuses the
// single app-wide conversation (via ChatProvider), so opening it on any page
// picks up exactly where the chat left off. It is the only entry point to the
// chat — there is no dedicated chat column or tab anymore.
export function FloatingChat() {
  const open = useAppStore((s) => s.chatOpen);
  const setOpen = useAppStore((s) => s.setChatOpen);
  const { isStreaming } = useChat();
  const t = useT();

  const button = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-label={open ? t("chat.close") : t("chat.title")}
      className={cn(
        "pointer-events-auto relative inline-flex h-10 items-center gap-2 px-3.5 transition-colors",
        open
          ? "rounded-lg border border-border bg-background/90 backdrop-blur text-foreground hover:bg-muted active:bg-muted"
          : "rounded-[7px] bg-background text-foreground hover:bg-muted active:bg-muted",
      )}
    >
      {open ? (
        <X className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}favicon.png`}
          alt=""
          aria-hidden
          className="h-5 w-5 rounded-sm object-contain"
        />
      )}
      <span className="text-sm">
        {open ? t("chat.close") : t("chat.openAgent")}
      </span>
    </button>
  );

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3 pointer-events-none">
      {open && (
        <div className="pointer-events-auto w-[min(520px,calc(100vw-2rem))] h-[min(760px,calc(100dvh-7rem))] rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
          <ChatPanel />
        </div>
      )}
      {open ? (
        button
      ) : (
        <div className="pointer-events-auto relative">
          {/* spinning rainbow border */}
          <div className="relative rounded-[9px] p-[2px] overflow-hidden">
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[170%] -translate-x-1/2 -translate-y-1/2 animate-spin [animation-duration:3s] bg-[conic-gradient(from_0deg,#ff0040,#ff8c00,#ffd500,#00d26a,#00b3ff,#7a5cff,#ff0040)]"
            />
            {button}
          </div>
          {isStreaming && (
            <span className="absolute -top-1 -right-1 z-10 h-2.5 w-2.5 rounded-full bg-green border-2 border-background animate-pulse" />
          )}
        </div>
      )}
    </div>
  );
}
