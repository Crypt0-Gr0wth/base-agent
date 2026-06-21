import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { useChat } from "./ChatContextDef";
import { PageHeader } from "@/components/PageHeader";
import osLogo from "@assets/favicon.png";

type TokenView = {
  symbol: string | null;
  name: string | null;
  logo: string | null;
  balance: string | null;
  usdValue: number | null;
  usdPrice: number | null;
  pct24h: number | null;
  nativeToken: boolean;
  contractAddress: string | null;
};

type TokensResponse = {
  enabled: boolean;
  needsWallet: boolean;
  wallet?: string;
  totalUsd?: number;
  tokens: TokenView[];
};

type DefiPosition = {
  protocol: string | null;
  protocolLogo: string | null;
  label: string | null;
  valueUsd: number | null;
  unclaimedUsd: number | null;
  tokens: string[];
  poolAddress: string | null;
};

type DefiResponse = {
  enabled: boolean;
  needsWallet: boolean;
  totalUsd?: number;
  positions: DefiPosition[];
};

type Transaction = {
  type: string | null;
  date: string | null;
  symbol: string | null;
  amount: number | null;
  valueUsd: number | null;
  hash: string | null;
  explorerUrl: string | null;
};

type TransactionsResponse = {
  enabled: boolean;
  needsWallet: boolean;
  syncing: boolean;
  transactions: Transaction[];
};

function usd(v: number | string | null | undefined): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function amount(v: string | number | null | undefined): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toPrecision(4);
}

function Section({
  title,
  subtotal,
  action,
  children,
}: {
  title: string;
  subtotal?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border/60 rounded-lg bg-surface/40 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border/50">
        <h2 className="font-sans text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </h2>
        <div className="flex items-center gap-3 shrink-0">
          {action}
          {subtotal && (
            <span className="font-mono text-xs text-foreground">{subtotal}</span>
          )}
        </div>
      </div>
      <div>{children}</div>
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="px-4 py-6 font-mono text-[11px] text-muted-foreground text-center">
      {text}
    </div>
  );
}

export function PortfolioView() {
  const t = useT();
  const { toast } = useToast();
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const { handleSubmit } = useChat();
  const BASE_APP_URL = "https://account.base.app/";
  const OS_ADDRESS = "0xD34cF0759cb65A0fe508bb1DaE0A16Cb5109bB7B";

  // Hand off a $OS buy to the agent chat: open the chat and auto-send a buy
  // command so the agent works the swap (the user still signs on-chain).
  const buyOS = () => {
    setChatOpen(true);
    void handleSubmit(`buy 100 USDC of $OS (${OS_ADDRESS})`);
  };

  const {
    data: tokensData,
    isLoading: loadingTokens,
    refetch: refetchTokens,
  } = useQuery({
    queryKey: ["/api/portfolio/tokens"],
    queryFn: async (): Promise<TokensResponse> => {
      const r = await fetch("/api/portfolio/tokens");
      if (!r.ok) return { enabled: true, needsWallet: false, tokens: [] };
      return (await r.json()) as TokensResponse;
    },
    staleTime: 30_000,
  });

  const {
    data: defi,
    isLoading: loadingDefi,
    refetch: refetchDefi,
  } = useQuery({
    queryKey: ["/api/portfolio/defi"],
    queryFn: async (): Promise<DefiResponse> => {
      const r = await fetch("/api/portfolio/defi");
      if (!r.ok) return { enabled: true, needsWallet: false, positions: [] };
      return (await r.json()) as DefiResponse;
    },
    staleTime: 30_000,
  });

  const {
    data: txData,
    isLoading: loadingTx,
    refetch: refetchTx,
  } = useQuery({
    queryKey: ["/api/portfolio/transactions"],
    queryFn: async (): Promise<TransactionsResponse> => {
      const r = await fetch("/api/portfolio/transactions");
      // See chart query: non-OK is a transient error (429/502), not an empty
      // state — throw so React Query retries instead of clearing good data.
      if (!r.ok) throw new Error(`transactions ${r.status}`);
      return (await r.json()) as TransactionsResponse;
    },
    staleTime: 60_000,
    refetchInterval: (q) =>
      (q.state.data as TransactionsResponse | undefined)?.syncing ? 15_000 : false,
  });

  const baseAddress = tokensData?.wallet;

  const refreshAll = () => {
    void refetchTokens();
    void refetchDefi();
    void refetchTx();
  };

  const openExternal = (url: string) =>
    window.open(url, "_blank", "noopener,noreferrer");

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: t("portfolio.copied", { label }), duration: 2000 });
  };

  const shortAddr = (a?: string) =>
    a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";

  const [hideZero, setHideZero] = useState(true);
  const defiPositions = defi?.positions ?? [];
  // A DeFi vault share token (e.g. STEAKUSDC) appears in BOTH the token balance
  // list and the DeFi positions list — same address (token.contractAddress ==
  // position.poolAddress). Drop it from the token list so the position is not
  // counted twice in the hero total.
  const defiPoolAddrs = new Set(
    defiPositions
      .map((p) => p.poolAddress?.toLowerCase())
      .filter((a): a is string => Boolean(a)),
  );
  const allTokens = (tokensData?.tokens ?? []).filter(
    (tk) =>
      !(tk.contractAddress && defiPoolAddrs.has(tk.contractAddress.toLowerCase())),
  );
  const isZeroValue = (tk: TokenView) =>
    tk.usdValue === null || Math.abs(tk.usdValue) < 0.005;
  const hasZeroTokens = allTokens.some(isZeroValue);
  const tokens =
    hideZero && hasZeroTokens ? allTokens.filter((tk) => !isZeroValue(tk)) : allTokens;
  const tokensTotal = allTokens.reduce((s, tk) => s + (tk.usdValue ?? 0), 0);
  const defiTotal = defi?.totalUsd ?? 0;
  const heroTotal = tokensTotal + defiTotal;
  const osToken = allTokens.find(
    (tk) => tk.contractAddress?.toLowerCase() === OS_ADDRESS.toLowerCase(),
  );
  const osBalance = osToken ? Number(osToken.balance) : 0;
  const transactions = txData?.transactions ?? [];

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      <PageHeader
        title={t("portfolio.title")}
        subtitle={t("portfolio.subtitle")}
        actions={
          <button
            onClick={refreshAll}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={t("portfolio.refresh")}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto space-y-5">
            {/* Hero: total value + address + external links */}
            <div className="border border-border/60 rounded-lg bg-surface/40 px-5 py-4">
              <div className="flex items-stretch gap-8 flex-wrap">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {t("portfolio.totalValue")}
                  </div>
                  <div className="font-sans text-3xl font-semibold tracking-tight mt-1">
                    {usd(heroTotal)}
                  </div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    <button
                      onClick={() =>
                        baseAddress && handleCopy(baseAddress, t("portfolio.address"))
                      }
                      className="font-mono text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                      data-testid="button-copy-address"
                    >
                      {loadingTokens ? t("portfolio.loading") : shortAddr(baseAddress)}
                      <Copy className="h-2.5 w-2.5" />
                    </button>
                    <button
                      onClick={() => openExternal(BASE_APP_URL)}
                      className="font-mono text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                      {t("portfolio.manageAccount")}
                      <ExternalLink className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </div>
                <div className="self-stretch w-px bg-border/60" aria-hidden="true" />
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {t("portfolio.totalOS")}
                  </div>
                  <div className="font-sans text-3xl font-semibold tracking-tight mt-1 flex items-center gap-2">
                    {amount(osBalance)}
                    <img src={osLogo} alt="" className="h-7 w-7 shrink-0" />
                  </div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    <button
                      onClick={buyOS}
                      className="font-mono text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                      data-testid="button-buy-os"
                    >
                      {t("portfolio.buyOS")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
            {/* Token holdings */}
            <Section
              title={t("portfolio.holdings")}
              subtotal={allTokens.length > 0 ? usd(tokensTotal) : undefined}
              action={
                hasZeroTokens ? (
                  <button
                    onClick={() => setHideZero((v) => !v)}
                    className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="button-toggle-zero"
                  >
                    {hideZero ? t("portfolio.showZero") : t("portfolio.hideZero")}
                  </button>
                ) : undefined
              }
            >
              {loadingTokens ? (
                <EmptyRow text={t("portfolio.loading")} />
              ) : tokensData && tokensData.enabled === false ? (
                <EmptyRow text={t("portfolio.tokensDisabled")} />
              ) : tokensData?.needsWallet ? (
                <EmptyRow text={t("portfolio.needsWallet")} />
              ) : tokens.length === 0 ? (
                <EmptyRow text={t("portfolio.noTokens")} />
              ) : (
                <div className="divide-y divide-border/40">
                  {tokens.map((tk, i) => (
                    <div
                      key={`${tk.symbol}-${i}`}
                      className="flex items-center justify-between px-4 py-2.5 gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {tk.contractAddress?.toLowerCase() ===
                        OS_ADDRESS.toLowerCase() ? (
                          <img
                            src={osLogo}
                            alt=""
                            className="h-6 w-6 rounded-full shrink-0"
                          />
                        ) : tk.logo ? (
                          <img
                            src={tk.logo}
                            alt=""
                            className="h-6 w-6 rounded-full shrink-0"
                          />
                        ) : (
                          <div className="h-6 w-6 rounded-full bg-foreground/10 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-sans text-xs font-medium text-foreground truncate">
                            {tk.symbol ?? tk.name ?? "—"}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {amount(tk.balance)} {tk.symbol ?? ""}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-xs text-foreground">
                          {usd(tk.usdValue)}
                        </div>
                        {tk.pct24h !== null && (
                          <div
                            className={cn(
                              "font-mono text-[10px]",
                              tk.pct24h >= 0 ? "text-green-500" : "text-red-500",
                            )}
                          >
                            {tk.pct24h >= 0 ? "+" : ""}
                            {tk.pct24h.toFixed(2)}%
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <div className="space-y-5">
            {/* DeFi / staking positions */}
            <Section
              title={t("portfolio.defiPositions")}
              subtotal={
                defiPositions.length > 0 ? usd(defi?.totalUsd) : undefined
              }
            >
              {loadingDefi ? (
                <EmptyRow text={t("portfolio.loading")} />
              ) : defi && defi.enabled === false ? (
                <EmptyRow text={t("portfolio.defiDisabled")} />
              ) : defi?.needsWallet ? (
                <EmptyRow text={t("portfolio.needsWallet")} />
              ) : defiPositions.length === 0 ? (
                <EmptyRow text={t("portfolio.noDefi")} />
              ) : (
                <div className="divide-y divide-border/40">
                  {defiPositions.map((p, i) => (
                    <div
                      key={`${p.protocol}-${i}`}
                      className="flex items-center justify-between px-4 py-2.5 gap-3"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {p.protocolLogo ? (
                          <img
                            src={p.protocolLogo}
                            alt=""
                            className="h-6 w-6 rounded-full shrink-0"
                          />
                        ) : (
                          <div className="h-6 w-6 rounded-full bg-foreground/10 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-sans text-xs font-medium text-foreground truncate">
                            {p.protocol ?? "—"}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground truncate">
                            {[p.label, p.tokens.join(" / ")]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-xs text-foreground">
                          {usd(p.valueUsd)}
                        </div>
                        {p.unclaimedUsd && p.unclaimedUsd > 0 ? (
                          <div className="font-mono text-[10px] text-green">
                            +{usd(p.unclaimedUsd)} {t("portfolio.unclaimed")}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
            </div>
            </div>

            {/* Recent transactions */}
            <Section title={t("portfolio.transactions")}>
              {loadingTx ? (
                <EmptyRow text={t("portfolio.loading")} />
              ) : txData && txData.enabled === false ? (
                <EmptyRow text={t("portfolio.coinstatsDisabled")} />
              ) : txData?.needsWallet ? (
                <EmptyRow text={t("portfolio.needsWallet")} />
              ) : txData?.syncing ? (
                <EmptyRow text={t("portfolio.syncing")} />
              ) : transactions.length === 0 ? (
                <EmptyRow text={t("portfolio.noTransactions")} />
              ) : (
                <div className="divide-y divide-border/40">
                  {transactions.map((tx, i) => {
                    const inner = (
                      <>
                        <div className="min-w-0">
                          <div className="font-sans text-xs font-medium text-foreground truncate">
                            {[tx.type, tx.symbol].filter(Boolean).join(" ") || "—"}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {tx.date ? new Date(tx.date).toLocaleString() : ""}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          {tx.amount !== null && (
                            <div className="font-mono text-xs text-foreground">
                              {amount(tx.amount)} {tx.symbol ?? ""}
                            </div>
                          )}
                          {tx.valueUsd !== null && tx.valueUsd > 0 && (
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {usd(tx.valueUsd)}
                            </div>
                          )}
                        </div>
                      </>
                    );
                    const rowClass =
                      "flex items-center justify-between px-4 py-2.5 gap-3";
                    return tx.explorerUrl ? (
                      <a
                        key={`${tx.hash ?? "tx"}-${i}`}
                        href={tx.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                          rowClass,
                          "hover:bg-foreground/5 transition-colors",
                        )}
                      >
                        {inner}
                      </a>
                    ) : (
                      <div key={`${tx.hash ?? "tx"}-${i}`} className={rowClass}>
                        {inner}
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
        </div>
      </div>
    </div>
  );
}
