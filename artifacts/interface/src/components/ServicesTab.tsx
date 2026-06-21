import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useTabs } from "./TabsContext";
import { useT, type TFn } from "@/i18n";

type TelegramStatus = {
  botConfigured: boolean;
  enabled: boolean;
  chatId: string | null;
  connected: boolean;
};

type ProtocolStatus = {
  id: string;
  label: string;
  kind: string;
  connected: boolean;
  toolCount: number;
  requiresAuth: boolean;
  enabled: boolean;
  source: "mcp" | "api";
  via?: string;
  error?: string;
  defaultOff?: boolean;
};

const KEY_PROTOCOLS = new Set(["moralis", "coingecko", "gmgn", "zerion", "coinstats"]);

// Protocols whose data is served by the bunnyDS managed gateway. When bunnyDS
// is active these never need a user key, so their "set api" button is replaced
// with a "powered by bunnyDS" status.
const GATEWAY_PROTOCOLS = new Set(["coingecko", "gmgn", "coinstats"]);

const GET_KEY_URLS: Record<string, string> = {
  moralis: "https://admin.moralis.com",
  coingecko: "https://www.coingecko.com/en/api/pricing",
  gmgn: "https://gmgn.ai",
  zerion: "https://developers.zerion.io",
  coinstats: "https://openapi.coinstats.app",
};

function ApiKeyInline({
  protocolId,
  getKeyUrl,
  t,
}: {
  protocolId: string;
  getKeyUrl?: string;
  t: TFn;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/settings/${protocolId}-key`;

  const { data } = useQuery({
    queryKey: [endpoint],
    queryFn: async (): Promise<{ configured: boolean }> => {
      const r = await fetch(endpoint);
      if (!r.ok) return { configured: false };
      return (await r.json()) as { configured: boolean };
    },
  });
  const configured = data?.configured ?? false;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [endpoint] });
    void queryClient.invalidateQueries({ queryKey: ["/api/protocols"] });
  };

  const save = async () => {
    if (draft.trim().length < 4) return;
    setBusy(true);
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: draft.trim() }),
      });
      if (r.ok) {
        setDraft("");
        refresh();
        toast({ description: t("wallet.keySaved"), duration: 2000 });
      } else {
        toast({
          description: t("wallet.keySaveFailed"),
          duration: 2500,
          variant: "destructive",
        });
      }
    } catch {
      toast({
        description: t("wallet.keySaveFailed"),
        duration: 2500,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const r = await fetch(endpoint, { method: "DELETE" });
      if (r.ok) {
        refresh();
        toast({ description: t("wallet.keyCleared"), duration: 2000 });
      } else {
        toast({
          description: t("wallet.keySaveFailed"),
          duration: 2500,
          variant: "destructive",
        });
      }
    } catch {
      toast({
        description: t("wallet.keySaveFailed"),
        duration: 2500,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {getKeyUrl && (
        <a
          href={getKeyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("wallet.getKey")} <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          configured
            ? t("wallet.apiKeySavedPlaceholder")
            : t("wallet.apiKeyPlaceholder")
        }
        type="password"
        autoComplete="off"
        aria-label={t("wallet.apiKeyPlaceholder")}
        className="h-7 font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || draft.trim().length < 4}
          onClick={() => void save()}
          className="h-7 shrink-0"
        >
          {t("wallet.keySave")}
        </Button>
        {configured && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void clear()}
            className="h-7 shrink-0"
          >
            {t("wallet.keyClear")}
          </Button>
        )}
      </div>
    </div>
  );
}

function ProtocolRow({
  p,
  onToggle,
  onOpen,
  bunnyDsActive,
  t,
}: {
  p: ProtocolStatus;
  onToggle: (id: string, enabled: boolean) => void;
  onOpen: (p: ProtocolStatus) => void;
  bunnyDsActive: boolean;
  t: TFn;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const gatewayPowered = bunnyDsActive && GATEWAY_PROTOCOLS.has(p.id);
  const hasKey = KEY_PROTOCOLS.has(p.id) && !gatewayPowered;
  const status: "connected" | "available" | "error" | "off" = !p.enabled
    ? "off"
    : p.error
      ? "error"
      : p.connected
        ? "connected"
        : "available";
  const dotColor =
    status === "connected"
      ? "bg-green"
      : status === "error"
        ? "bg-destructive/70"
        : status === "off"
          ? "bg-muted-foreground/20"
          : "bg-muted-foreground/40";
  const nameColor =
    status === "connected" ? "text-foreground" : "text-muted-foreground";
  const meta = !p.enabled
    ? t("services.off")
    : p.connected
      ? t("services.toolCount", { count: p.toolCount })
      : p.requiresAuth
        ? t("services.notAuthorized")
        : p.error
          ? t("services.offline")
          : p.kind;
  return (
    <div
      className="flex items-center justify-between py-1.5 gap-2 border-b border-border/40 last:border-b-0"
      title={p.error ?? `${p.label} · ${p.kind}`}
    >
      <button
        type="button"
        onClick={() => onOpen(p)}
        className="flex items-center gap-2 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}
        />
        <span className={`font-sans text-sm truncate ${nameColor}`}>
          {p.label}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpen(p)}
        className="font-mono text-[10px] text-muted-foreground shrink-0 hover:text-foreground transition-colors cursor-pointer"
      >
        {meta}
      </button>
      {gatewayPowered && (
        <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground shrink-0">
          {t("services.poweredByBunnyDs")}
        </span>
      )}
      {hasKey && (
        <Popover open={keyOpen} onOpenChange={setKeyOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground shrink-0 transition-colors cursor-pointer hover:bg-muted/80 hover:text-foreground"
              aria-expanded={keyOpen}
            >
              {t("services.setApi")}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-0 overflow-hidden">
            <div className="px-4 pt-3.5 pb-2.5 text-left">
              <p className="text-sm font-medium tracking-tight">{p.label}</p>
            </div>
            <div className="px-4 pb-4">
              <ApiKeyInline
                protocolId={p.id}
                getKeyUrl={GET_KEY_URLS[p.id]}
                t={t}
              />
            </div>
          </PopoverContent>
        </Popover>
      )}
      <Switch
        checked={p.enabled}
        onCheckedChange={(v) => onToggle(p.id, v)}
        className="shrink-0 scale-75 -mr-1"
        aria-label={t("services.toggleAria", { label: p.label })}
      />
    </div>
  );
}

function SecuritySection({ t }: { t: TFn }) {
  return (
    <div>
      <h3 className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
        {t("services.security.section")}
      </h3>
      <div className="flex items-center justify-between py-1.5 gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span className="inline-block h-1.5 w-1.5 rounded-full shrink-0 bg-green" />
          <span className="font-sans text-sm text-foreground">
            {t("services.security.label")}
          </span>
        </span>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">
          {t("services.security.always")}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed mt-1">
        {t("services.security.help")}{" "}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="font-mono text-[10px] text-foreground underline underline-offset-2 hover:text-green transition-colors"
            >
              {t("services.security.howTitle")}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-80 max-w-[calc(100vw-2rem)]"
          >
            <p className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {t("services.security.howTitle")}
            </p>
            <ul className="space-y-1.5">
              {[
                "services.security.step.screen",
                "services.security.step.deobfuscate",
                "services.security.step.drain",
                "services.security.step.approval",
                "services.security.step.exfil",
                "services.security.step.injection",
              ].map((key) => (
                <li
                  key={key}
                  className="flex gap-2 text-[11px] text-muted-foreground leading-relaxed"
                >
                  <span className="text-green shrink-0">✓</span>
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted-foreground/80 leading-relaxed mt-2 italic">
              {t("services.security.footer")}
            </p>
          </PopoverContent>
        </Popover>
      </p>
    </div>
  );
}

function TelegramSection({ t }: { t: TFn }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const { data } = useQuery({
    queryKey: ["/api/telegram"],
    queryFn: async (): Promise<TelegramStatus> => {
      const r = await fetch("/api/telegram");
      if (!r.ok) throw new Error("failed");
      return (await r.json()) as TelegramStatus;
    },
  });

  useEffect(() => {
    if (data?.chatId != null) setChatId(data.chatId);
  }, [data?.chatId]);

  const enabled = data?.enabled ?? false;
  const botConfigured = data?.botConfigured ?? false;
  const connected = data?.connected ?? false;

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    const r = await fetch("/api/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return false;
    queryClient.setQueryData<TelegramStatus>(
      ["/api/telegram"],
      (await r.json()) as TelegramStatus,
    );
    return true;
  };

  const toggle = (v: boolean) => {
    void post({ enabled: v }).then((ok) => {
      if (!ok) {
        toast({
          description: t("services.telegram.saveFailed"),
          duration: 2000,
          variant: "destructive",
        });
      }
    });
  };

  const save = async () => {
    setSaving(true);
    const body: Record<string, unknown> = { chatId: chatId.trim() };
    if (botToken.trim() !== "") body.botToken = botToken.trim();
    const ok = await post(body);
    setSaving(false);
    if (ok) setBotToken("");
    toast({
      description: ok
        ? t("services.telegram.saved")
        : t("services.telegram.invalidInput"),
      duration: 2000,
      variant: ok ? "default" : "destructive",
    });
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const reqBody: Record<string, unknown> = {};
      if (botToken.trim() !== "") reqBody.botToken = botToken.trim();
      const r = await fetch("/api/telegram/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      if (r.ok) {
        const { chatId: detected } = (await r.json()) as { chatId: string };
        setChatId(detected);
        toast({
          description: t("services.telegram.detected"),
          duration: 2000,
        });
      } else {
        toast({
          description: t("services.telegram.detectFailed"),
          duration: 3000,
          variant: "destructive",
        });
      }
    } catch {
      toast({
        description: t("services.telegram.detectFailed"),
        duration: 3000,
        variant: "destructive",
      });
    } finally {
      setDetecting(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    const r = await fetch("/api/telegram/test", { method: "POST" });
    setTesting(false);
    toast({
      description: r.ok
        ? t("services.telegram.testSent")
        : t("services.telegram.testFailed"),
      duration: 2500,
      variant: r.ok ? "default" : "destructive",
    });
  };

  const dotColor = connected
    ? "bg-green"
    : enabled
      ? "bg-muted-foreground/40"
      : "bg-muted-foreground/20";

  return (
    <div>
      <h3 className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
        {t("services.telegram.section")}
      </h3>
      <div className="flex items-center justify-between py-1.5 gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}
          />
          <span className="font-sans text-sm text-foreground">
            {t("services.telegram.label")}
          </span>
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={!botConfigured}
          className="shrink-0 scale-75 -mr-1"
          aria-label={t("services.telegram.toggleAria")}
        />
      </div>
      <div className="space-y-2 mt-1">
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {t("services.telegram.help")}
        </p>
        <Input
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder={
            botConfigured
              ? t("services.telegram.botTokenSavedPlaceholder")
              : t("services.telegram.botTokenPlaceholder")
          }
          type="password"
          autoComplete="off"
          className="h-7 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder={t("services.telegram.chatIdPlaceholder")}
            inputMode="numeric"
            className="h-7 font-mono text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={
              detecting || (!botConfigured && botToken.trim() === "")
            }
            onClick={() => void detect()}
            className="h-7 shrink-0"
          >
            {t("services.telegram.detect")}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={
              saving ||
              chatId.trim() === "" ||
              (!botConfigured && botToken.trim() === "")
            }
            onClick={() => void save()}
            className="h-7 shrink-0"
          >
            {t("services.telegram.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing || !connected}
            onClick={() => void sendTest()}
            className="h-7 shrink-0"
          >
            {t("services.telegram.test")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ServicesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { openTab } = useTabs();
  const t = useT();

  const { data: protocolsData } = useQuery({
    queryKey: ["/api/protocols"],
    queryFn: async (): Promise<{ protocols: ProtocolStatus[] }> => {
      const r = await fetch("/api/protocols");
      if (!r.ok) return { protocols: [] };
      return (await r.json()) as { protocols: ProtocolStatus[] };
    },
    refetchInterval: 15_000,
  });
  const { data: bunnyDs } = useQuery({
    queryKey: ["/api/settings/bunny-ds"],
    queryFn: async (): Promise<{
      enabled?: boolean;
      gatewayConfigured?: boolean;
    }> => {
      const r = await fetch("/api/settings/bunny-ds");
      if (!r.ok) return {};
      return (await r.json()) as {
        enabled?: boolean;
        gatewayConfigured?: boolean;
      };
    },
  });
  const bunnyDsActive =
    Boolean(bunnyDs?.enabled) && Boolean(bunnyDs?.gatewayConfigured);
  const protocols = protocolsData?.protocols ?? [];
  const mcp = protocols.filter((p) => p.source === "mcp");
  const api = protocols.filter((p) => p.source === "api");
  const apiOn = api.filter((p) => !p.defaultOff);
  const apiOff = api.filter((p) => p.defaultOff);

  const openProtocolTab = (p: ProtocolStatus) =>
    openTab({
      id: `protocol:${p.id}`,
      title: p.label,
      kind: "protocol",
      payload: { protocolId: p.id },
    });

  const toggleProtocol = (id: string, enabled: boolean) => {
    queryClient.setQueryData<{ protocols: ProtocolStatus[] }>(
      ["/api/protocols"],
      (old) =>
        old
          ? {
              protocols: old.protocols.map((p) =>
                p.id === id ? { ...p, enabled } : p,
              ),
            }
          : old,
    );
    void fetch(`/api/protocols/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).catch(() => {
      toast({
        description: t("services.toggleFailed", { id }),
        duration: 2000,
        variant: "destructive",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/protocols"] });
    });
  };

  return (
    <div className="space-y-5">
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        {t("services.description")}
      </p>

      {mcp.length > 0 && (
        <div>
          <h3 className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
            {t("services.mcpSection")}
          </h3>
          <div>
            {mcp.map((p) => (
              <ProtocolRow
                key={p.id}
                p={p}
                onToggle={toggleProtocol}
                onOpen={openProtocolTab}
                bunnyDsActive={bunnyDsActive}
                t={t}
              />
            ))}
          </div>
        </div>
      )}

      {apiOn.length > 0 && (
        <div>
          <h3 className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
            {t("services.bunnyosImplementation")}
          </h3>
          <div>
            {apiOn.map((p) => (
              <ProtocolRow
                key={p.id}
                p={p}
                onToggle={toggleProtocol}
                onOpen={openProtocolTab}
                bunnyDsActive={bunnyDsActive}
                t={t}
              />
            ))}
          </div>
        </div>
      )}

      {apiOff.length > 0 && (
        <div>
          <h3 className="font-mono text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
            {t("services.optionalSection")}
          </h3>
          <div>
            {apiOff.map((p) => (
              <ProtocolRow
                key={p.id}
                p={p}
                onToggle={toggleProtocol}
                onOpen={openProtocolTab}
                bunnyDsActive={bunnyDsActive}
                t={t}
              />
            ))}
          </div>
        </div>
      )}

      {protocols.length === 0 && (
        <div className="text-[11px] text-muted-foreground">
          {t("services.loadingServices")}
        </div>
      )}

      <SecuritySection t={t} />

      <TelegramSection t={t} />
    </div>
  );
}
