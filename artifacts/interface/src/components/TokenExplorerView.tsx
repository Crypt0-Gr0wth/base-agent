import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, Info, Loader2, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useChat } from "./ChatContextDef";
import { fmtUsd, fmtPct, ageDays, fmtAge } from "./report/format";
import { useT } from "@/i18n";
import { useTheme } from "@/theme";

type TrendingToken = {
  tokenAddress: string;
  symbol: string;
  name: string;
  logo: string | null;
  usdPrice: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  createdAt: number | null;
  pricePercentChange1h: number | null;
  pricePercentChange24h: number | null;
  totalVolume24h: number | null;
};

type SortKey =
  | "marketCap"
  | "liquidityUsd"
  | "totalVolume24h"
  | "pricePercentChange1h"
  | "pricePercentChange24h"
  | "holders"
  | "createdAt";

type SortDir = "asc" | "desc";

type Filters = {
  minLiquidity: string;
  minVolume24h: string;
  minMarketCap: string;
  minHolders: string;
  maxAgeDays: string;
  min1hChange: string;
  min24hChange: string;
};

const EMPTY_FILTERS: Filters = {
  minLiquidity: "",
  minVolume24h: "",
  minMarketCap: "",
  minHolders: "",
  maxAgeDays: "",
  min1hChange: "",
  min24hChange: "",
};

function changeColor(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "text-muted-foreground";
  if (v > 0) return "text-green";
  if (v < 0) return "text-destructive";
  return "text-muted-foreground";
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function FilterField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 font-mono text-xs"
      />
    </label>
  );
}

// Token icon with a blue default avatar (the symbol's first letter) for tokens
// that have no logo — also the fallback when a logo URL fails to load.
function TokenAvatar({
  logo,
  symbol,
  size,
}: {
  logo: string | null;
  symbol: string;
  size: "sm" | "md";
}) {
  const [broken, setBroken] = useState(false);
  const dim = size === "md" ? "h-6 w-6" : "h-5 w-5";
  const txt = size === "md" ? "text-[11px]" : "text-[9px]";
  if (logo && !broken) {
    return (
      <img
        src={logo}
        alt=""
        className={cn(dim, "rounded-full shrink-0 object-cover")}
        onError={() => setBroken(true)}
      />
    );
  }
  const letter = (symbol || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className={cn(
        dim,
        txt,
        "rounded-full shrink-0 flex items-center justify-center bg-blue-500 font-mono font-semibold text-white",
      )}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}

const COLUMNS: Array<{ key: SortKey; labelKey: string }> = [
  { key: "marketCap", labelKey: "colMktCap" },
  { key: "liquidityUsd", labelKey: "colLiquidity" },
  { key: "totalVolume24h", labelKey: "col24hVol" },
  { key: "pricePercentChange1h", labelKey: "col1h" },
  { key: "pricePercentChange24h", labelKey: "col24h" },
  { key: "createdAt", labelKey: "colAge" },
];

type Source = "coingecko" | "virtuals" | "bankr";

// Per-source data provenance shown in the header info tooltip so users know
// exactly where each list comes from and how it's filtered/enriched.
const METHODOLOGY: Record<
  Source,
  { title: string; source: string; filters: string; market: string }
> = {
  coingecko: {
    title: "methodologyCoingeckoTitle",
    source: "methodologyCoingeckoSource",
    filters: "methodologyCoingeckoFilters",
    market: "methodologyCoingeckoMarket",
  },
  virtuals: {
    title: "methodologyVirtualsTitle",
    source: "methodologyVirtualsSource",
    filters: "methodologyVirtualsFilters",
    market: "methodologyVirtualsMarket",
  },
  bankr: {
    title: "methodologyBankrTitle",
    source: "methodologyBankrSource",
    filters: "methodologyBankrFilters",
    market: "methodologyBankrMarket",
  },
};

// Side panel showing the selected token's live chart (GeckoTerminal embed) plus
// a minimalist research button that hands the token to the agent chat.
function ChartPanel({
  token,
  onClose,
  onResearch,
  t,
}: {
  token: TrendingToken;
  onClose: () => void;
  onResearch: () => void;
  t: ReturnType<typeof useT>;
}) {
  const { theme } = useTheme();
  // GeckoTerminal's embed is dark by default; `light_chart=1` forces light.
  const chartTheme = theme === "dark" ? "" : "&light_chart=1";
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <TokenAvatar logo={token.logo} symbol={token.symbol} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-foreground">
            {token.symbol || `${token.tokenAddress.slice(0, 6)}…${token.tokenAddress.slice(-4)}`}
          </div>
          {token.name && (
            <div className="truncate font-sans text-[10px] text-muted-foreground">
              {token.name}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onResearch}
          className="shrink-0 rounded border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          {t("tokens.researchAddress")}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <iframe
          key={`${token.tokenAddress}-${theme}`}
          src={`https://www.geckoterminal.com/base/tokens/${token.tokenAddress}?embed=1&info=0&swaps=0${chartTheme}`}
          title={t("tokens.chartTitle", { symbol: token.symbol || token.tokenAddress })}
          loading="lazy"
          className="h-full min-h-[420px] w-full border-0 bg-background"
        />
      </div>
    </div>
  );
}

export function TokenExplorerView() {
  const t = useT();
  const [source, setSource] = useState<Source>("coingecko");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("totalVolume24h");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const { handleSubmit } = useChat();

  // The token whose chart is shown in the side panel. Selecting a token (row
  // click, search pick, pasted CA, or deep link) opens its chart; the panel's
  // research button then hands it off to the agent chat.
  const [selected, setSelected] = useState<TrendingToken | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const selectAddress = (address: string) =>
    setSelected({
      tokenAddress: address,
      symbol: "",
      name: "",
      logo: null,
      usdPrice: null,
      marketCap: null,
      liquidityUsd: null,
      holders: null,
      createdAt: null,
      pricePercentChange1h: null,
      pricePercentChange24h: null,
      totalVolume24h: null,
    });

  // Hand the selected token off to the agent chat: open the chat and auto-send a
  // research prompt so the report is produced in the conversation.
  const researchInChat = (token: TrendingToken) => {
    const cmd = token.symbol
      ? t("tokens.researchCommand", {
          symbol: token.symbol,
          address: token.tokenAddress,
        })
      : t("tokens.researchCommandNoSymbol", { address: token.tokenAddress });
    setChatOpen(true);
    void handleSubmit(cmd);
  };

  // Token search: find any Base token by name, ticker, or contract address
  // instead of only clicking a row in the list. A 0x address opens its chart
  // directly; free text hits /search and shows a dropdown of candidates.
  const [caInput, setCaInput] = useState("");
  const [caError, setCaError] = useState("");
  const [searchResults, setSearchResults] = useState<TrendingToken[] | null>(
    null,
  );
  const [searchLoading, setSearchLoading] = useState(false);

  // Free-text name/ticker search → /api/tokens/search; shows a dropdown of
  // candidates. Returns no results as a friendly error, preserves actionable
  // backend messages (coingecko disabled, rate limit, …).
  const runNameSearch = async (q: string) => {
    setSearchLoading(true);
    setSearchResults(null);
    try {
      const r = await fetch(`/api/tokens/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { tokens?: TrendingToken[] };
      const list = j.tokens ?? [];
      if (list.length === 0) {
        setCaError(t("tokens.noSearchResults"));
        setSearchResults(null);
      } else {
        setSearchResults(list);
      }
    } catch (err) {
      setCaError(
        err instanceof Error && err.message
          ? err.message
          : t("tokens.tokenNotFound"),
      );
      setSearchResults(null);
    } finally {
      setSearchLoading(false);
    }
  };

  const submitCa = () => {
    const q = caInput.trim();
    if (!q) return;
    setCaError("");
    setSearchResults(null);

    // A contract address opens its chart directly.
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      selectAddress(q);
      setCaInput("");
      return;
    }

    // Otherwise treat it as a name/ticker search.
    void runNameSearch(q);
  };

  // Show the chart for a token picked from the search-results dropdown.
  const pickSearchResult = (tok: TrendingToken) => {
    setSearchResults(null);
    setCaError("");
    setSelected(tok);
  };

  // Deep link: /terminal/report/<address> opens the token's chart panel
  // (once per address).
  const [, reportParams] = useRoute("/terminal/report/:address");
  const deepLinkFiredRef = useRef<string | null>(null);
  useEffect(() => {
    const addr = reportParams?.address;
    if (addr && deepLinkFiredRef.current !== addr.toLowerCase()) {
      deepLinkFiredRef.current = addr.toLowerCase();
      selectAddress(addr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportParams?.address]);

  const forceRef = useRef(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["/api/tokens", source],
    queryFn: async (): Promise<TrendingToken[]> => {
      const fresh = forceRef.current;
      forceRef.current = false;
      const r = await fetch(
        `/api/tokens?limit=100&source=${source}${fresh ? "&fresh=1" : ""}`,
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { tokens?: TrendingToken[] };
      return Array.isArray(j.tokens) ? j.tokens : [];
    },
    // No auto-refresh: only fetch on first load, on source switch, or when the
    // user clicks refresh — avoids hammering rate limits in the background.
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    staleTime: Infinity,
  });

  const handleRefresh = () => {
    forceRef.current = true;
    void refetch();
  };

  const setFilter = (k: keyof Filters, v: string) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const rows = useMemo(() => {
    const all = data ?? [];
    const minLiq = parseNum(filters.minLiquidity);
    const minVol = parseNum(filters.minVolume24h);
    const minMc = parseNum(filters.minMarketCap);
    const minHolders = parseNum(filters.minHolders);
    const maxAge = parseNum(filters.maxAgeDays);
    const min1h = parseNum(filters.min1hChange);
    const min24h = parseNum(filters.min24hChange);

    const filtered = all.filter((t) => {
      if (minLiq !== null && (t.liquidityUsd ?? -Infinity) < minLiq) return false;
      if (minVol !== null && (t.totalVolume24h ?? -Infinity) < minVol) return false;
      if (minMc !== null && (t.marketCap ?? -Infinity) < minMc) return false;
      if (minHolders !== null && (t.holders ?? -Infinity) < minHolders) return false;
      if (min1h !== null && (t.pricePercentChange1h ?? -Infinity) < min1h) return false;
      if (min24h !== null && (t.pricePercentChange24h ?? -Infinity) < min24h) return false;
      if (maxAge !== null) {
        const d = ageDays(t.createdAt);
        if (d === null || d > maxAge) return false;
      }
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = av === null || !Number.isFinite(av) ? -Infinity : av;
      const bn = bv === null || !Number.isFinite(bv) ? -Infinity : bv;
      if (an === bn) return 0;
      return an < bn ? -1 * dir : 1 * dir;
    });
    return filtered;
  }, [data, filters, sortKey, sortDir]);

  const activeFilterCount = Object.values(filters).filter((v) => v.trim() !== "").length;
  const anyFilter = activeFilterCount > 0;

  return (
    <div className="flex h-full w-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
        <PageHeader
          title={t("tokens.researchBase")}
          titleAfter={
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("tokens.dataMethodology")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
                className="max-w-xs bg-popover text-popover-foreground border border-border shadow-md"
              >
                <div className="space-y-1.5 py-0.5 font-sans text-[11px] leading-snug">
                  <p className="font-medium">{t(`tokens.${METHODOLOGY[source].title}`)}</p>
                  <p>
                    <span className="text-muted-foreground">{t("tokens.sourceLabel")} </span>
                    {t(`tokens.${METHODOLOGY[source].source}`)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">{t("tokens.filtersLabel")} </span>
                    {t(`tokens.${METHODOLOGY[source].filters}`)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">{t("tokens.marketDataLabel")} </span>
                    {t(`tokens.${METHODOLOGY[source].market}`)}
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          }
          subtitle={
            source === "bankr"
              ? t("tokens.subtitleBankr")
              : source === "virtuals"
                ? t("tokens.subtitleVirtuals")
                : t("tokens.subtitleCoingecko")
          }
          actions={
            <>
              <div className="flex items-center rounded border border-border p-0.5">
              {(["coingecko", "virtuals"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSource(s)}
                  className={cn(
                    "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                    source === s
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isFetching}
              className="h-7 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={cn("h-3 w-3 mr-1", isFetching && "animate-spin")} />
              {t("tokens.refresh")}
            </Button>
            </>
          }
        />

        <div className="border-b border-border/50 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <Input
              value={caInput}
              onChange={(e) => {
                setCaInput(e.target.value);
                if (caError) setCaError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCa();
              }}
              placeholder={t("tokens.searchPlaceholder")}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="h-8 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              onClick={submitCa}
              disabled={searchLoading}
              className="h-8 shrink-0 font-mono text-[11px] uppercase tracking-wider"
            >
              {searchLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t("tokens.searchAction")
              )}
            </Button>
          </div>
          <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
            {t("tokens.researchHint")}
          </div>
          {caError && (
            <div className="mt-1.5 font-mono text-[10px] text-destructive">
              {caError}
            </div>
          )}
          {searchResults && searchResults.length > 0 && (
            <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border/50 bg-card">
              {searchResults.map((tok) => (
                <button
                  key={tok.tokenAddress}
                  type="button"
                  onClick={() => pickSearchResult(tok)}
                  className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left last:border-b-0 hover:bg-muted/60"
                >
                  {tok.logo ? (
                    <img
                      src={tok.logo}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] uppercase text-muted-foreground">
                      {(tok.symbol || "?").slice(0, 2)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-medium uppercase">
                        {tok.symbol || "—"}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {tok.name}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {fmtUsd(tok.usdPrice)} · {t("tokens.colLiquidity")} {fmtUsd(tok.liquidityUsd)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-b border-border/50 px-4 py-2 shrink-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              <SlidersHorizontal className="h-3 w-3" />
              <span>{t("tokens.filtersLabel")}</span>
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-foreground/10 px-1.5 text-[9px] text-foreground">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", filtersOpen && "rotate-180")}
              />
            </button>
            {anyFilter && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {t("tokens.clearFilters")}
              </button>
            )}
          </div>
          {filtersOpen && (
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <FilterField
                label={t("tokens.filterMinLiq")}
                value={filters.minLiquidity}
                onChange={(v) => setFilter("minLiquidity", v)}
                placeholder="0"
              />
              <FilterField
                label={t("tokens.filterMin24hVol")}
                value={filters.minVolume24h}
                onChange={(v) => setFilter("minVolume24h", v)}
                placeholder="0"
              />
              <FilterField
                label={t("tokens.filterMinMktCap")}
                value={filters.minMarketCap}
                onChange={(v) => setFilter("minMarketCap", v)}
                placeholder="0"
              />
              <FilterField
                label={t("tokens.filterMinHolders")}
                value={filters.minHolders}
                onChange={(v) => setFilter("minHolders", v)}
                placeholder="0"
              />
              <FilterField
                label={t("tokens.filterMaxAge")}
                value={filters.maxAgeDays}
                onChange={(v) => setFilter("maxAgeDays", v)}
                placeholder="∞"
              />
              <FilterField
                label={t("tokens.filterMin1h")}
                value={filters.min1hChange}
                onChange={(v) => setFilter("min1hChange", v)}
                placeholder="-100"
              />
              <FilterField
                label={t("tokens.filterMin24h")}
                value={filters.min24hChange}
                onChange={(v) => setFilter("min24hChange", v)}
                placeholder="-100"
              />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {source === "bankr"
                  ? t("tokens.loadingRecentLaunches")
                  : source === "virtuals"
                    ? t("tokens.loadingVirtualsTokens")
                    : t("tokens.loadingTrendingTokens")}
              </span>
            </div>
          ) : isError ? (
            <div className="px-4 py-16 text-center">
              <p className="font-mono text-xs text-destructive">
                {error instanceof Error ? error.message : t("tokens.failedToLoadTokens")}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                className="mt-3 font-mono text-[11px]"
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-16 text-center font-mono text-xs text-muted-foreground">
              {anyFilter
                ? t("tokens.noTokensMatchFilters")
                : source === "bankr"
                  ? t("tokens.noRecentLaunches")
                  : source === "virtuals"
                    ? t("tokens.noVirtualsTokens")
                    : t("tokens.noTrendingTokens")}
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("tokens.colToken")}
                  </th>
                  <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("tokens.colPrice")}
                  </th>
                  {COLUMNS.map((c) => {
                    const active = c.key === sortKey;
                    return (
                      <th
                        key={c.key}
                        className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider"
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-foreground",
                            active ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {t(`tokens.${c.labelKey}`)}
                          {active &&
                            (sortDir === "desc" ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ArrowUp className="h-3 w-3" />
                            ))}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr
                    key={t.tokenAddress}
                    onClick={() => setSelected(t)}
                    className={cn(
                      "border-b border-border/40 cursor-pointer hover:bg-foreground/5",
                      selected?.tokenAddress === t.tokenAddress && "bg-foreground/5",
                    )}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <TokenAvatar logo={t.logo} symbol={t.symbol} size="sm" />
                        <div className="min-w-0">
                          <div className="font-mono text-xs text-foreground truncate max-w-[140px]">
                            {t.symbol || "?"}
                          </div>
                          <div className="font-sans text-[10px] text-muted-foreground truncate max-w-[140px]">
                            {t.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
                      {fmtUsd(t.usdPrice)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
                      {fmtUsd(t.marketCap, true)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
                      {fmtUsd(t.liquidityUsd, true)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
                      {fmtUsd(t.totalVolume24h, true)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono text-xs",
                        changeColor(t.pricePercentChange1h),
                      )}
                    >
                      {fmtPct(t.pricePercentChange1h)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono text-xs",
                        changeColor(t.pricePercentChange24h),
                      )}
                    >
                      {fmtPct(t.pricePercentChange24h)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                      {fmtAge(t.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && (
        <div className="hidden lg:block lg:w-[480px] lg:shrink-0 lg:border-l lg:border-border/50">
          <ChartPanel
            token={selected}
            onClose={() => setSelected(null)}
            onResearch={() => researchInChat(selected)}
            t={t}
          />
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 bg-background lg:hidden">
          <ChartPanel
            token={selected}
            onClose={() => setSelected(null)}
            onResearch={() => researchInChat(selected)}
            t={t}
          />
        </div>
      )}
    </div>
  );
}
