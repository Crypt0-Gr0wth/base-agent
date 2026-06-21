import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Moon, Sun } from "lucide-react";
import logo from "@assets/logo.png";
import logoWhite from "@assets/logo-white.png";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/theme";
import WaveBackground from "@/components/WaveBackground";
import { Footer } from "@/components/Footer";
import { playSound } from "@/lib/sound";

export default function Landing() {
  const [, setLocation] = useLocation();
  const auth = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [connecting, setConnecting] = useState(false);
  const [osPrice, setOsPrice] = useState<number | null>(null);

  // Public OS token price for the hero "$OS" pill. Best-effort: the endpoint
  // needs no auth and degrades to null (price hidden) when market data is off.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/bunny/os-price");
        if (!r.ok) return;
        const j = (await r.json()) as { priceUsd?: number | null };
        if (!cancelled && typeof j.priceUsd === "number" && j.priceUsd > 0) {
          setOsPrice(j.priceUsd);
        }
      } catch {
        /* ignore — pill just shows "$OS" with no price */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const osPriceLabel =
    osPrice != null
      ? `$${osPrice < 0.01 ? osPrice.toFixed(6) : osPrice < 1 ? osPrice.toFixed(4) : osPrice.toFixed(2)}`
      : null;

  // The public landing page is always English for SEO, regardless of the
  // visitor's saved UI language (DEFAULT_LANG is zh). Force the document title
  // and <html lang> to English while this page is mounted. The rAF re-assert
  // runs after LanguageProvider's own mount effect (child effects fire before
  // parent effects) so the provider can't clobber <html lang> back to zh.
  useEffect(() => {
    const prevTitle = document.title;
    const prevLang = document.documentElement.lang;
    document.title = "The first open-source @base agent.";
    document.documentElement.lang = "en";
    const raf = requestAnimationFrame(() => {
      document.documentElement.lang = "en";
    });
    return () => {
      cancelAnimationFrame(raf);
      document.title = prevTitle;
      document.documentElement.lang = prevLang || "en";
    };
  }, []);

  // Note: we intentionally do NOT auto-redirect authenticated visitors away
  // from the landing page. A signed-in user can still browse "/" and click
  // the CTA (which becomes "open terminal") to jump back in.

  // When the OAuth popup posts a success message back, do a hard navigation
  // to /terminal so every query (including /api/base-mcp/status) refetches
  // with the freshly-minted session cookie. A client-side setLocation would
  // keep the cached "not connected" status until the 10s refetch interval.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { type?: string; ok?: boolean; isNew?: boolean }
        | undefined;
      if (data?.type !== "base-mcp-auth" || data.ok !== true) return;
      // First-time sign-ups land on the bunnyDS page; returning users go to
      // their usual home tab. The query flag is consumed + stripped by the
      // terminal's TabsProvider.
      window.location.assign(data.isNew ? "/terminal?welcome=1" : "/terminal");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const handleConnect = () => {
    playSound("confirm");
    if (auth.authenticated) {
      setLocation("/terminal");
      return;
    }
    setConnecting(true);
    // Open the top-level start endpoint directly in the popup so the
    // bunny_anon cookie is set during a top-level navigation (works even
    // when the app is inside a cross-site preview iframe). The endpoint
    // 302-redirects to Base's OAuth URL.
    const popup = window.open(
      "/api/base-mcp/connect-start",
      "base-mcp-auth",
      "width=520,height=720",
    );
    if (!popup) {
      setConnecting(false);
    }
  };

  const ctaLabel = connecting
    ? "connecting…"
    : auth.authenticated
      ? "open terminal"
      : "connect to base";

  return (
    <main className="relative min-h-[100dvh] md:h-[100dvh] w-full text-foreground flex flex-col md:overflow-hidden">
      <WaveBackground />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, hsl(var(--accent) / 0.4), transparent)",
        }}
      />
      <header className="relative z-10 h-16 w-full px-4 flex items-center justify-between border-b border-border/60 bg-background/70 backdrop-blur shrink-0">
        <div className="flex items-center gap-2">
          <img src={logo} alt="logo" className="h-12 w-auto block dark:hidden" />
          <img src={logoWhite} alt="logo" className="h-12 w-auto hidden dark:block" />
        </div>
        <button
          onClick={toggleTheme}
          aria-pressed={theme === "dark"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="p-2 border border-border/70 text-foreground bg-background/70 hover:bg-foreground/5 rounded transition-colors cursor-pointer inline-flex items-center justify-center"
          data-testid="button-theme-toggle-landing"
        >
          {theme === "dark" ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </button>
      </header>
      <section className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center px-6 py-8 text-center">
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-semibold tracking-tight max-w-4xl">
          The human-agent
          <br />
          terminal on{" "}
          <a
            href="https://base.org"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:opacity-90"
          >
            @base
          </a>
          .
        </h1>

        <p className="mt-6 max-w-xl text-base md:text-lg text-muted-foreground leading-relaxed">built open source and in public for the agentic future</p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting}
            className="px-3 py-1.5 rounded-md bg-accent text-accent-foreground font-sans text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            data-testid="button-connect-base-body"
          >
            {ctaLabel}
          </button>
          <a
            href="https://dexscreener.com/base/0x525A1f4DB6384434A9C9d413C6D86eBbF432a47b"
            target="_blank"
            rel="noreferrer"
            onClick={() => playSound("confirm")}
            className="px-3 py-1.5 rounded-md border border-border/70 font-sans text-sm font-medium hover:bg-foreground/5 transition-colors inline-flex items-center gap-1.5"
            data-testid="link-dexscreener"
          >
            $OS
            {osPriceLabel && (
              <span className="font-mono text-muted-foreground">
                {osPriceLabel}
              </span>
            )}
          </a>
          <a
            href="https://github.com/bunnyos/base-agent"
            target="_blank"
            rel="noreferrer"
            onClick={() => playSound("confirm")}
            className="px-3 py-1.5 rounded-md border border-border/70 font-sans text-sm font-medium hover:bg-foreground/5 transition-colors"
            data-testid="link-github"
          >
            github
          </a>
        </div>
      </section>
      <section className="relative z-10 w-full px-6 pb-8 shrink-0">
        <div className="max-w-5xl mx-auto grid gap-px md:grid-cols-4 border border-border/60 rounded-xl overflow-hidden bg-border/60">
          <Pillar
            index="01"
            title="chat & execute"
            body="chat with protocols and execute transactions directly."
          />
          <Pillar
            index="02"
            title="research"
            body="in-built data sources for research and analysis."
          />
          <Pillar
            index="03"
            title="action system"
            body="create and share actions that run 24/7."
          />
          <Pillar
            index="04"
            title="build"
            body="fork it, add features, and support the community."
          />
        </div>
      </section>
      <Footer />
    </main>
  );
}

function Pillar({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-background p-6 flex flex-col gap-2 hover:bg-background/80 transition-colors">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {index}
      </span>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}
