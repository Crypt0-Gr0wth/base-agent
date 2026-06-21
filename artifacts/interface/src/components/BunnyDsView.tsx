import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTabs } from "./TabsContext";
import { useT } from "@/i18n";
import { useToast } from "@/hooks/use-toast";

type BunnyDsStatus = {
  enabled: boolean;
  connected: boolean;
  gatewayConfigured: boolean;
};

type Billing = {
  configured: boolean;
  connected: boolean;
  wallet: string | null;
  usdc: string | null;
  collector: string | null;
  chainId: number | null;
  network: string | null;
  inferenceEnabled: boolean;
  dataEnabled: boolean;
  allowance: string | null;
  balance: string | null;
  owed: string | null;
  credit: string | null;
};

function openApprovalPopup(url: string): void {
  const w = 460;
  const h = 720;
  const dualLeft = window.screenLeft ?? window.screenX ?? 0;
  const dualTop = window.screenTop ?? window.screenY ?? 0;
  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height =
    window.innerHeight || document.documentElement.clientHeight || 0;
  const left = dualLeft + Math.max(0, (width - w) / 2);
  const top = dualTop + Math.max(0, (height - h) / 2);
  const features = `scrollbars=yes,width=${w},height=${h},top=${top},left=${left}`;
  const win = window.open(url, "bunnyds-approval", features);
  if (!win) window.open(url, "_blank", "noopener,noreferrer");
}

export function BunnyDsView() {
  const t = useT();
  const { toast } = useToast();
  const { setActive } = useTabs();
  const [status, setStatus] = useState<BunnyDsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [billing, setBilling] = useState<Billing | null>(null);

  // connect (mint wallet session token) flow state
  const [connectState, setConnectState] = useState<
    | { kind: "idle" }
    | { kind: "starting" }
    | { kind: "awaiting"; url: string; requestId: string | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const pollRef = useRef<number | null>(null);

  // allowance flow state
  const [amount, setAmount] = useState("");
  const [allowanceState, setAllowanceState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "awaiting"; url: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/settings/bunny-ds");
      if (!r.ok) throw new Error(String(r.status));
      setStatus((await r.json()) as BunnyDsStatus);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBilling = useCallback(async () => {
    try {
      const r = await fetch("/api/bunnyds/billing");
      if (!r.ok) throw new Error(String(r.status));
      setBilling((await r.json()) as Billing);
    } catch {
      setBilling(null);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Load billing on mount (and when connection changes). The snapshot now
  // includes the gateway's billing config (availability + addresses) even
  // before a wallet is connected, so the approve() flow can be shown early.
  useEffect(() => {
    void loadBilling();
  }, [status?.connected, loadBilling]);

  // Poll the metered values (allowance/balance/owed/credit) while connected so
  // they reflect on-chain allowance changes and gateway spend without a manual
  // refresh. The server read is uncached, so a modest interval is enough.
  useEffect(() => {
    if (!status?.connected) return;
    const id = window.setInterval(() => {
      void loadBilling();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadBilling();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status?.connected, loadBilling]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, []);

  const toggle = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setStatus((prev) => (prev ? { ...prev, enabled: next } : prev));
      try {
        const r = await fetch("/api/settings/bunny-ds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        });
        if (!r.ok) throw new Error(String(r.status));
        setStatus((await r.json()) as BunnyDsStatus);
      } catch {
        setStatus((prev) => (prev ? { ...prev, enabled: !next } : prev));
        toast({ description: t("bunnyds.saveFailed"), duration: 4000 });
      } finally {
        setSaving(false);
      }
    },
    [t, toast],
  );

  const pollConnect = useCallback(
    (requestId: string | null, attempt: number) => {
      // ~2.5 min budget at 5s intervals.
      if (attempt > 30) {
        setConnectState({ kind: "error", message: t("bunnyds.connectTimeout") });
        return;
      }
      pollRef.current = window.setTimeout(() => {
        void (async () => {
          try {
            const r = await fetch("/api/bunnyds/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestId ? { requestId } : {}),
            });
            if (!r.ok) {
              const j = (await r.json().catch(() => ({}))) as { error?: string };
              setConnectState({
                kind: "error",
                message: j.error ?? t("bunnyds.connectFailed"),
              });
              return;
            }
            const j = (await r.json()) as {
              connected: boolean;
              pending: boolean;
            };
            if (j.connected) {
              setConnectState({ kind: "idle" });
              await loadStatus();
              await loadBilling();
              return;
            }
            pollConnect(requestId, attempt + 1);
          } catch {
            setConnectState({
              kind: "error",
              message: t("bunnyds.connectFailed"),
            });
          }
        })();
      }, 5000);
    },
    [loadBilling, loadStatus, t],
  );

  const startConnect = useCallback(async () => {
    setConnectState({ kind: "starting" });
    try {
      const r = await fetch("/api/bunnyds/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setConnectState({
          kind: "error",
          message: j.error ?? t("bunnyds.connectFailed"),
        });
        return;
      }
      const j = (await r.json()) as {
        approvalUrl: string | null;
        requestId: string | null;
      };
      if (!j.approvalUrl) {
        setConnectState({ kind: "error", message: t("bunnyds.noApproval") });
        return;
      }
      openApprovalPopup(j.approvalUrl);
      setConnectState({
        kind: "awaiting",
        url: j.approvalUrl,
        requestId: j.requestId,
      });
      pollConnect(j.requestId, 0);
    } catch {
      setConnectState({ kind: "error", message: t("bunnyds.connectFailed") });
    }
  }, [pollConnect, t]);

  const submitAllowance = useCallback(async () => {
    const amt = amount.trim();
    if (!amt || !/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0) {
      setAllowanceState({
        kind: "error",
        message: t("bunnyds.allowanceInvalid"),
      });
      return;
    }
    setAllowanceState({ kind: "submitting" });
    try {
      const r = await fetch("/api/bunnyds/allowance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setAllowanceState({
          kind: "error",
          message: j.error ?? t("bunnyds.allowanceFailed"),
        });
        return;
      }
      const j = (await r.json()) as { approvalUrl: string | null };
      if (!j.approvalUrl) {
        setAllowanceState({ kind: "error", message: t("bunnyds.noApproval") });
        return;
      }
      openApprovalPopup(j.approvalUrl);
      setAllowanceState({ kind: "awaiting", url: j.approvalUrl });
      toast({ description: t("bunnyds.allowanceSubmitted"), duration: 4000 });
    } catch {
      setAllowanceState({ kind: "error", message: t("bunnyds.allowanceFailed") });
    }
  }, [amount, t, toast]);

  const enabled = status?.enabled ?? false;
  const connected = status?.connected ?? false;
  // Gateway-side metering availability (operator turned billing on). The
  // approve() flow only needs this + the user's Base wallet — not a bunnyDS
  // session token — so the allowance controls key off `configured`, while the
  // live metered rows (allowance/balance/owed/credit) still require `connected`.
  const configured = billing?.configured ?? false;
  const connectBusy =
    connectState.kind === "starting" || connectState.kind === "awaiting";

  return (
    <div className="flex-1 w-full min-h-0 overflow-y-auto">
      <PageHeader title={t("bunnyds.title")} subtitle={t("bunnyds.subtitle")} />
      <div className="mx-auto w-full max-w-2xl px-4 py-6 space-y-5 sm:px-6">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("bunnyds.loading")}
          </div>
        ) : (
          <>
            <div className="rounded-md border border-border/60 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                        enabled ? "bg-green-500" : "bg-muted-foreground/40"
                      }`}
                    />
                    <span className="font-mono text-sm font-medium text-foreground">
                      {enabled
                        ? t("bunnyds.statusActive")
                        : t("bunnyds.statusInactive")}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {enabled
                      ? t("bunnyds.activeHelp")
                      : t("bunnyds.inactiveHelp")}
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(v) => void toggle(v)}
                  disabled={saving}
                  className="shrink-0 mt-0.5"
                  aria-label={t("bunnyds.toggleAria")}
                />
              </div>
            </div>

            {/* Connect: mint a wallet session token by signing the gateway nonce. */}
            <div className="rounded-md border border-border/60 p-4">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                    connected ? "bg-green-500" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="font-mono text-sm font-medium text-foreground">
                  {connected
                    ? t("bunnyds.connectedTitle")
                    : t("bunnyds.connectTitle")}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {connected
                  ? t("bunnyds.connectedHelp")
                  : t("bunnyds.connectHelp")}
              </p>
              <div className="mt-4 flex items-center gap-2">
                <Button
                  type="button"
                  onClick={() => void startConnect()}
                  disabled={connectBusy}
                  className="inline-flex items-center gap-2"
                >
                  {connectBusy && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {connectBusy
                    ? t("bunnyds.connecting")
                    : connected
                      ? t("bunnyds.reconnect")
                      : t("bunnyds.connectButton")}
                </Button>
                {connectState.kind === "awaiting" && (
                  <button
                    type="button"
                    onClick={() => openApprovalPopup(connectState.url)}
                    className="h-9 px-3 rounded-md border border-border text-sm hover:bg-card"
                  >
                    {t("bunnyds.reopen")}
                  </button>
                )}
              </div>
              {connectState.kind === "error" && (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-2 text-[11px] text-destructive"
                >
                  {connectState.message}
                </p>
              )}
            </div>

            {/* Allowance: keyed off gateway `configured` (approve needs only
                the addresses + the user's Base wallet). Live metered rows below
                still require a minted session token (`connected`). */}
            <div
              className={`rounded-md border border-border/60 p-4 ${
                configured ? "" : "opacity-70"
              }`}
            >
              <span className="font-mono text-sm font-medium text-foreground">
                {t("bunnyds.spendingTitle")}
              </span>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {configured
                  ? t("bunnyds.spendingHelp")
                  : t("bunnyds.spendingLocked")}
              </p>

              {connected && billing && (
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <BillingRow
                    label={t("bunnyds.billingAllowance")}
                    value={billing.allowance}
                    t={t}
                  />
                  <BillingRow
                    label={t("bunnyds.billingBalance")}
                    value={billing.balance}
                    t={t}
                  />
                  <BillingRow
                    label={t("bunnyds.billingOwed")}
                    value={billing.owed}
                    t={t}
                  />
                  <BillingRow
                    label={t("bunnyds.billingCredit")}
                    value={billing.credit}
                    t={t}
                  />
                </dl>
              )}

              <div className="mt-4 space-y-2">
                <label
                  htmlFor="bunnyds-spend-limit"
                  className="block text-[11px] font-medium text-muted-foreground"
                >
                  {t("bunnyds.spendingLimitLabel")}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="bunnyds-spend-limit"
                    type="number"
                    inputMode="decimal"
                    placeholder="25"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={!configured || allowanceState.kind === "submitting"}
                    className="max-w-[140px] font-mono"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("bunnyds.spendingUnit")}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => void submitAllowance()}
                    disabled={
                      !configured || allowanceState.kind === "submitting"
                    }
                    className="mt-1 inline-flex items-center gap-2"
                  >
                    {allowanceState.kind === "submitting" && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    {allowanceState.kind === "submitting"
                      ? t("bunnyds.allowanceApproving")
                      : t("bunnyds.spendingApprove")}
                  </Button>
                  {allowanceState.kind === "awaiting" && (
                    <button
                      type="button"
                      onClick={() => openApprovalPopup(allowanceState.url)}
                      className="mt-1 h-9 px-3 rounded-md border border-border text-sm hover:bg-card"
                    >
                      {t("bunnyds.reopen")}
                    </button>
                  )}
                </div>
                {allowanceState.kind === "error" && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-[11px] text-destructive"
                  >
                    {allowanceState.message}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {t("bunnyds.byoPrefix")}{" "}
              <button
                type="button"
                onClick={() => setActive("settings")}
                className="text-foreground underline underline-offset-2 hover:opacity-80"
              >
                {t("bunnyds.byoLink")}
              </button>{" "}
              {t("bunnyds.byoSuffix")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BillingRow({
  label,
  value,
  t,
}: {
  label: string;
  value: string | null;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">
        {value != null && value !== "" ? value : t("bunnyds.billingNone")}
      </dd>
    </div>
  );
}
