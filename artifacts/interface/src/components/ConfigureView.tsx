import { useEffect, useRef, useState } from "react";
import { Download, Upload, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useListModels,
  useGetCurrentModel,
  useSetCurrentModel,
  getGetCurrentModelQueryKey,
  useGetApiKeyStatus,
  useSetApiKey,
  useClearApiKey,
  getGetApiKeyStatusQueryKey,
  useGetSurplusKeyStatus,
  useSetSurplusKey,
  useClearSurplusKey,
  getGetSurplusKeyStatusQueryKey,
  useGetVeniceKeyStatus,
  useSetVeniceKey,
  useClearVeniceKey,
  getGetVeniceKeyStatusQueryKey,
  useGetEconomyosKeyStatus,
  useSetEconomyosKey,
  useClearEconomyosKey,
  getGetEconomyosKeyStatusQueryKey,
  useGetLlmProvider,
  useSetLlmProvider,
  getGetLlmProviderQueryKey,
  useListLlmProviders,
  getListModelsQueryKey,
  useGetMemory,
  useUpdateMemory,
  getGetMemoryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useT, type TFn } from "@/i18n";
import { ServicesTab } from "./ServicesTab";

const LLM_META: Record<string, { placeholder: string; url: string }> = {
  openrouter: { placeholder: "sk-or-v1-...", url: "https://openrouter.ai/keys" },
  surplus: { placeholder: "inf_...", url: "https://www.surplusintelligence.ai" },
  venice: { placeholder: "vk_...", url: "https://venice.ai/settings/api" },
  economyos: {
    placeholder: "your virtuals api key",
    url: "https://compute.virtuals.io",
  },
};

function KeyPopover({
  configured,
  masked,
  userProvided,
  draft,
  setDraft,
  onSave,
  onClear,
  saving,
  placeholder,
  getKeyUrl,
  t,
}: {
  configured: boolean;
  masked?: string;
  userProvided?: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSave: () => void | Promise<void>;
  onClear: () => void | Promise<void>;
  saving: boolean;
  placeholder: string;
  getKeyUrl: string;
  t: TFn;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground shrink-0 transition-colors cursor-pointer hover:bg-muted/80 hover:text-foreground"
          aria-expanded={open}
        >
          {t("services.setApi")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0 overflow-hidden">
        <div className="px-4 pt-3.5 pb-2.5 text-left">
          <p className="text-sm font-medium tracking-tight">
            {t("services.setApi")}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {configured
              ? userProvided
                ? t("configure.userKeyStatus", { masked: masked ?? "" })
                : t("configure.envKeyStatus", { masked: masked ?? "" })
              : t("configure.noKeySet")}
          </p>
        </div>
        <div className="px-4 pb-4 space-y-2.5">
          <a
            href={getKeyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("wallet.getKey")} <ExternalLink className="h-2.5 w-2.5" />
          </a>
          <Input
            type="password"
            placeholder={configured ? masked : placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-8 font-mono text-xs"
            autoComplete="off"
            aria-label={t("wallet.apiKeyPlaceholder")}
          />
          <div className="flex items-center gap-2 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 flex-1"
              disabled={draft.trim().length < 8 || saving}
              onClick={() => void onSave()}
            >
              {t("common.save")}
            </Button>
            {userProvided && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                disabled={saving}
                onClick={() => void onClear()}
              >
                {t("configure.clear")}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ConfigureView() {
  const t = useT();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [surplusDraft, setSurplusDraft] = useState("");
  const [veniceDraft, setVeniceDraft] = useState("");
  const [economyosDraft, setEconomyosDraft] = useState("");

  const { data: keyStatus } = useGetApiKeyStatus();
  const setApiKey = useSetApiKey();
  const clearApiKey = useClearApiKey();

  const { data: surplusStatus } = useGetSurplusKeyStatus();
  const setSurplusKey = useSetSurplusKey();
  const clearSurplusKey = useClearSurplusKey();

  const { data: veniceStatus } = useGetVeniceKeyStatus();
  const setVeniceKey = useSetVeniceKey();
  const clearVeniceKey = useClearVeniceKey();

  const { data: economyosStatus } = useGetEconomyosKeyStatus();
  const setEconomyosKey = useSetEconomyosKey();
  const clearEconomyosKey = useClearEconomyosKey();

  const { data: providerData } = useGetLlmProvider();
  const setProvider = useSetLlmProvider();
  const { data: providerList } = useListLlmProviders();
  const activeProvider = providerData?.provider ?? "openrouter";
  const providers = providerList?.providers ?? [
    { id: "surplus", label: "Surplus Intelligence" },
    { id: "venice", label: "Venice" },
    { id: "economyos", label: "EconomyOS" },
    { id: "openrouter", label: "OpenRouter" },
  ];
  const visibleProviders = providers.filter((p) => p.id !== "bunnyos");
  const visibleActiveProvider =
    activeProvider === "bunnyos" ? "openrouter" : activeProvider;
  const activeKeyConfigured =
    visibleActiveProvider === "surplus"
      ? Boolean(surplusStatus?.configured)
      : visibleActiveProvider === "venice"
        ? Boolean(veniceStatus?.configured)
        : visibleActiveProvider === "economyos"
          ? Boolean(economyosStatus?.configured)
          : Boolean(keyStatus?.configured);

  const { data: models = [] } = useListModels({
    query: {
      queryKey: ["/api/models", activeProvider],
      enabled: activeKeyConfigured,
    },
  });
  const { data: currentModelData } = useGetCurrentModel();
  const setCurrentModel = useSetCurrentModel();

  const { data: memory } = useGetMemory({
    query: { queryKey: getGetMemoryQueryKey() },
  });
  const updateMemory = useUpdateMemory();

  // bunnyDS active = managed gateway on AND configured. When active the user's
  // own data/inference keys are bypassed, so the key + provider sections in the
  // services tab are hidden.
  const [bunnyDsActive, setBunnyDsActive] = useState(false);
  const [tab, setTab] = useState("services");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/settings/bunny-ds");
        if (!r.ok) return;
        const j = (await r.json()) as {
          enabled?: boolean;
          gatewayConfigured?: boolean;
        };
        if (cancelled) return;
        const active = Boolean(j.enabled) && Boolean(j.gatewayConfigured);
        setBunnyDsActive(active);
      } catch {
        /* leave tabs enabled on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [draft, setDraft] = useState<string | null>(null);
  const serverContent = memory?.content;
  const editorValue = draft ?? serverContent ?? "";
  const dirty = draft !== null && draft !== (serverContent ?? "");

  const currentModelName =
    models.find((m) => m.id === currentModelData?.model)?.name ||
    currentModelData?.model ||
    t("configure.selectModel");

  const handleSaveKey = async () => {
    if (keyDraft.trim().length < 8) return;
    await setApiKey.mutateAsync({ data: { apiKey: keyDraft.trim() } });
    setKeyDraft("");
    queryClient.invalidateQueries({ queryKey: getGetApiKeyStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleClearKey = async () => {
    await clearApiKey.mutateAsync();
    queryClient.invalidateQueries({ queryKey: getGetApiKeyStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleSaveSurplus = async () => {
    if (surplusDraft.trim().length < 8) return;
    await setSurplusKey.mutateAsync({ data: { apiKey: surplusDraft.trim() } });
    setSurplusDraft("");
    queryClient.invalidateQueries({
      queryKey: getGetSurplusKeyStatusQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleClearSurplus = async () => {
    await clearSurplusKey.mutateAsync();
    queryClient.invalidateQueries({
      queryKey: getGetSurplusKeyStatusQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleSaveVenice = async () => {
    if (veniceDraft.trim().length < 8) return;
    await setVeniceKey.mutateAsync({ data: { apiKey: veniceDraft.trim() } });
    setVeniceDraft("");
    queryClient.invalidateQueries({
      queryKey: getGetVeniceKeyStatusQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleClearVenice = async () => {
    await clearVeniceKey.mutateAsync();
    queryClient.invalidateQueries({
      queryKey: getGetVeniceKeyStatusQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleSaveEconomyos = async () => {
    if (economyosDraft.trim().length < 8) return;
    await setEconomyosKey.mutateAsync({ data: { apiKey: economyosDraft.trim() } });
    setEconomyosDraft("");
    queryClient.invalidateQueries({
      queryKey: getGetEconomyosKeyStatusQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleClearEconomyos = async () => {
    await clearEconomyosKey.mutateAsync();
    queryClient.invalidateQueries({
      queryKey: getGetEconomyosKeyStatusQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
  };

  const handleSelectProvider = async (provider: string) => {
    if (provider === activeProvider) return;
    await setProvider.mutateAsync({ data: { provider } });
    queryClient.invalidateQueries({ queryKey: getGetLlmProviderQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetCurrentModelQueryKey() });
  };

  const handleSelectModel = (modelId: string) => {
    setCurrentModel.mutate(
      { data: { model: modelId } },
      {
        onSuccess: (res) => {
          queryClient.setQueryData(getGetCurrentModelQueryKey(), res);
        },
      },
    );
    setPickerOpen(false);
  };

  const handleSaveMemory = async () => {
    if (draft === null) return;
    try {
      await updateMemory.mutateAsync({ data: { content: draft } });
      queryClient.invalidateQueries({ queryKey: getGetMemoryQueryKey() });
      setDraft(null);
      toast({ description: t("configure.memorySaved"), duration: 1500 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ description: t("configure.saveFailed", { msg }), duration: 4000 });
    }
  };

  const handleRevertMemory = () => setDraft(null);

  const isSavingMemory = updateMemory.isPending;

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportMemory = () => {
    const blob = new Blob([memory?.content ?? ""], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bunny-memory-${new Date().toISOString().split("T")[0]}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ description: t("configure.memoryExported"), duration: 1500 });
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      await updateMemory.mutateAsync({ data: { content: text } });
      queryClient.invalidateQueries({ queryKey: getGetMemoryQueryKey() });
      setDraft(null);
      toast({ description: t("configure.memoryImported"), duration: 2000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ description: t("configure.importFailed", { msg }), duration: 4000 });
    }
  };

  const llmCfg: Record<
    string,
    {
      status?: { configured: boolean; masked: string; userProvided: boolean };
      draft: string;
      setDraft: (v: string) => void;
      onSave: () => Promise<void>;
      onClear: () => Promise<void>;
      saving: boolean;
    }
  > = {
    openrouter: {
      status: keyStatus,
      draft: keyDraft,
      setDraft: setKeyDraft,
      onSave: handleSaveKey,
      onClear: handleClearKey,
      saving: setApiKey.isPending,
    },
    surplus: {
      status: surplusStatus,
      draft: surplusDraft,
      setDraft: setSurplusDraft,
      onSave: handleSaveSurplus,
      onClear: handleClearSurplus,
      saving: setSurplusKey.isPending,
    },
    venice: {
      status: veniceStatus,
      draft: veniceDraft,
      setDraft: setVeniceDraft,
      onSave: handleSaveVenice,
      onClear: handleClearVenice,
      saving: setVeniceKey.isPending,
    },
    economyos: {
      status: economyosStatus,
      draft: economyosDraft,
      setDraft: setEconomyosDraft,
      onSave: handleSaveEconomyos,
      onClear: handleClearEconomyos,
      saving: setEconomyosKey.isPending,
    },
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <PageHeader
        title={t("common.configure")}
        subtitle={t("configure.subtitle")}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        <Tabs value={tab} onValueChange={setTab} className="mt-2">
          <TabsList className="grid grid-cols-2 w-full h-auto font-mono text-xs">
            <TabsTrigger value="services">{t("configure.tabServices")}</TabsTrigger>
            <TabsTrigger value="memory">{t("configure.tabMemory")}</TabsTrigger>
          </TabsList>

          <TabsContent value="services" className="space-y-5 py-3 font-mono">
            {!bunnyDsActive && (
                <div className="rounded-md border border-border/60 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      {t("configure.llmGroupLabel")}
                      <span className="text-red ml-1">
                        {t("configure.requiredMark")}
                      </span>
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                      {t("configure.llmGroupHint")}
                    </span>
                  </div>

                  <div className="flex flex-col">
                    {visibleProviders.map((provider) => {
                      const cfg = llmCfg[provider.id];
                      const meta = LLM_META[provider.id];
                      const isActive = provider.id === visibleActiveProvider;
                      const configured = Boolean(cfg?.status?.configured);
                      const dotColor = configured
                        ? "bg-green"
                        : "bg-muted-foreground/40";
                      const nameColor = isActive
                        ? "text-foreground"
                        : "text-muted-foreground";
                      return (
                        <div
                          key={provider.id}
                          className="flex items-center justify-between gap-2 py-1.5 border-b border-border/40 last:border-b-0"
                        >
                          <span className="flex items-center gap-2 min-w-0 flex-1">
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}
                            />
                            <span
                              className={`font-sans text-sm truncate lowercase ${nameColor}`}
                            >
                              {provider.label}
                            </span>
                          </span>
                          {cfg && meta && (
                            <KeyPopover
                              configured={configured}
                              masked={cfg.status?.masked}
                              userProvided={cfg.status?.userProvided}
                              draft={cfg.draft}
                              setDraft={cfg.setDraft}
                              onSave={cfg.onSave}
                              onClear={cfg.onClear}
                              saving={cfg.saving}
                              placeholder={meta.placeholder}
                              getKeyUrl={meta.url}
                              t={t}
                            />
                          )}
                          <Switch
                            checked={isActive}
                            onCheckedChange={(v) => {
                              if (v) void handleSelectProvider(provider.id);
                            }}
                            disabled={setProvider.isPending}
                            className="shrink-0 scale-75 -mr-1"
                            aria-label={provider.label}
                            data-testid={`switch-provider-${provider.id}`}
                          />
                        </div>
                      );
                    })}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs">{t("configure.modelLabel")}</Label>
                    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-full justify-between text-xs font-mono"
                          disabled={!activeKeyConfigured}
                          data-testid="button-model-picker"
                        >
                          <span className="truncate">{currentModelName}</span>
                          <span className="text-muted-foreground ml-2">▾</span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-[calc(100vw-2rem)] sm:w-[440px] p-0"
                        align="start"
                      >
                        <Command>
                          <CommandInput
                            placeholder={t("configure.searchModels")}
                            className="font-mono text-xs"
                          />
                          <CommandList>
                            <CommandEmpty className="text-xs p-4 text-center font-mono">
                              {t("configure.noModelsFound")}
                            </CommandEmpty>
                            <CommandGroup>
                              {models.map((model) => (
                                <CommandItem
                                  key={model.id}
                                  value={model.name}
                                  onSelect={() => handleSelectModel(model.id)}
                                  className="font-mono text-xs flex justify-between items-center cursor-pointer"
                                >
                                  <span className="truncate mr-2">
                                    {model.name}
                                  </span>
                                  {model.free ? (
                                    <span className="text-green shrink-0">
                                      {t("configure.free")}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground shrink-0">
                                      ${model.price_input}
                                    </span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {!activeKeyConfigured && (
                      <p className="text-[10px] text-muted-foreground">
                        {t("configure.setKeyToLoadModels")}
                      </p>
                    )}
                  </div>
                </div>
              )}
            <ServicesTab />
          </TabsContent>

          <TabsContent value="memory" className="space-y-3 py-3 font-mono">
            <div className="flex items-center justify-end gap-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="text/markdown,text/plain,.md,.txt"
                onChange={handleImportFile}
                className="hidden"
                data-testid="input-memory-import"
              />
              <button
                onClick={handleImportClick}
                disabled={isSavingMemory}
                className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded font-mono text-[10px] text-foreground transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                data-testid="button-memory-import"
                title={t("configure.importMemoryTitle")}
              >
                <Upload className="h-3 w-3" />
                {t("configure.importLabel")}
              </button>
              <button
                onClick={handleExportMemory}
                className="px-2 py-1 bg-secondary hover:bg-secondary/80 rounded font-mono text-[10px] text-foreground transition-colors inline-flex items-center gap-1"
                data-testid="button-memory-export"
                title={t("configure.exportMemoryTitle")}
              >
                <Download className="h-3 w-3" />
                {t("configure.exportLabel")}
              </button>
            </div>
            <Textarea
              value={editorValue}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs min-h-[200px] sm:min-h-[320px] resize-y bg-background"
              spellCheck={false}
              placeholder={t("configure.memoryPlaceholder")}
              data-testid="memory-editor"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground">
                {t("configure.memoryHelp")}
              </p>
              <div className="flex gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs font-mono"
                  onClick={handleRevertMemory}
                  disabled={!dirty || isSavingMemory}
                  data-testid="button-memory-revert"
                >
                  {t("configure.revert")}
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs font-mono"
                  onClick={handleSaveMemory}
                  disabled={!dirty || isSavingMemory}
                  data-testid="button-memory-save"
                >
                  {isSavingMemory ? t("configure.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
        </div>
      </div>
    </div>
  );
}
