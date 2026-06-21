import { Router, type IRouter } from "express";
import {
  SetApiKeyBody,
  GetApiKeyStatusResponse,
  SetLlmProviderBody,
  GetLlmProviderResponse,
  ListLlmProvidersResponse,
} from "@workspace/api-zod";
import {
  getApiKey,
  setApiKey,
  clearApiKey,
  isUserKey,
  getSurplusApiKey,
  setSurplusApiKey,
  clearSurplusApiKey,
  isUserSurplusKey,
  getVeniceApiKey,
  setVeniceApiKey,
  clearVeniceApiKey,
  isUserVeniceKey,
  getEconomyosApiKey,
  setEconomyosApiKey,
  clearEconomyosApiKey,
  isUserEconomyosKey,
  getMoralisApiKey,
  setMoralisApiKey,
  clearMoralisApiKey,
  isUserMoralisKey,
  getCoingeckoApiKey,
  setCoingeckoApiKey,
  clearCoingeckoApiKey,
  isUserCoingeckoKey,
  getGmgnApiKey,
  setGmgnApiKey,
  clearGmgnApiKey,
  isUserGmgnKey,
  getCoinstatsApiKey,
  setCoinstatsApiKey,
  clearCoinstatsApiKey,
  isUserCoinstatsKey,
  getZerionApiKey,
  setZerionApiKey,
  clearZerionApiKey,
  isUserZerionKey,
  getLlmProvider,
  setLlmProvider,
  getLang,
  setLang,
  getBunnyDsEnabled,
  setBunnyDsEnabled,
  maskKey,
} from "../lib/settings";
import { normalizeAgentLang } from "../lib/bunny-agent";
import { normalizeProviderId, LLM_PROVIDERS } from "../lib/llm-provider";
import { isGatewayConfigured } from "../lib/bunnyos-gateway";

const router: IRouter = Router();

function statusPayload() {
  const key = getApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/api-key", async (_req, res): Promise<void> => {
  res.json(statusPayload());
});

router.post("/settings/api-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setApiKey(parsed.data.apiKey);
  res.json(statusPayload());
});

router.delete("/settings/api-key", async (_req, res): Promise<void> => {
  await clearApiKey();
  res.json(statusPayload());
});

function moralisStatusPayload() {
  const key = getMoralisApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserMoralisKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/moralis-key", async (_req, res): Promise<void> => {
  res.json(moralisStatusPayload());
});

router.post("/settings/moralis-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setMoralisApiKey(parsed.data.apiKey);
  res.json(moralisStatusPayload());
});

router.delete("/settings/moralis-key", async (_req, res): Promise<void> => {
  await clearMoralisApiKey();
  res.json(moralisStatusPayload());
});

function coingeckoStatusPayload() {
  const key = getCoingeckoApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserCoingeckoKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/coingecko-key", async (_req, res): Promise<void> => {
  res.json(coingeckoStatusPayload());
});

router.post("/settings/coingecko-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setCoingeckoApiKey(parsed.data.apiKey);
  res.json(coingeckoStatusPayload());
});

router.delete("/settings/coingecko-key", async (_req, res): Promise<void> => {
  await clearCoingeckoApiKey();
  res.json(coingeckoStatusPayload());
});

function gmgnStatusPayload() {
  const key = getGmgnApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserGmgnKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/gmgn-key", async (_req, res): Promise<void> => {
  res.json(gmgnStatusPayload());
});

router.post("/settings/gmgn-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setGmgnApiKey(parsed.data.apiKey);
  res.json(gmgnStatusPayload());
});

router.delete("/settings/gmgn-key", async (_req, res): Promise<void> => {
  await clearGmgnApiKey();
  res.json(gmgnStatusPayload());
});

function zerionStatusPayload() {
  const key = getZerionApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserZerionKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/zerion-key", async (_req, res): Promise<void> => {
  res.json(zerionStatusPayload());
});

router.post("/settings/zerion-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setZerionApiKey(parsed.data.apiKey);
  res.json(zerionStatusPayload());
});

router.delete("/settings/zerion-key", async (_req, res): Promise<void> => {
  await clearZerionApiKey();
  res.json(zerionStatusPayload());
});

function coinstatsStatusPayload() {
  const key = getCoinstatsApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserCoinstatsKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/coinstats-key", async (_req, res): Promise<void> => {
  res.json(coinstatsStatusPayload());
});

router.post("/settings/coinstats-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setCoinstatsApiKey(parsed.data.apiKey);
  res.json(coinstatsStatusPayload());
});

router.delete("/settings/coinstats-key", async (_req, res): Promise<void> => {
  await clearCoinstatsApiKey();
  res.json(coinstatsStatusPayload());
});

function surplusStatusPayload() {
  const key = getSurplusApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserSurplusKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/surplus-key", async (_req, res): Promise<void> => {
  res.json(surplusStatusPayload());
});

router.post("/settings/surplus-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setSurplusApiKey(parsed.data.apiKey);
  res.json(surplusStatusPayload());
});

router.delete("/settings/surplus-key", async (_req, res): Promise<void> => {
  await clearSurplusApiKey();
  res.json(surplusStatusPayload());
});

function veniceStatusPayload() {
  const key = getVeniceApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserVeniceKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/venice-key", async (_req, res): Promise<void> => {
  res.json(veniceStatusPayload());
});

router.post("/settings/venice-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setVeniceApiKey(parsed.data.apiKey);
  res.json(veniceStatusPayload());
});

router.delete("/settings/venice-key", async (_req, res): Promise<void> => {
  await clearVeniceApiKey();
  res.json(veniceStatusPayload());
});

function economyosStatusPayload() {
  const key = getEconomyosApiKey();
  return GetApiKeyStatusResponse.parse({
    configured: Boolean(key),
    userProvided: isUserEconomyosKey(),
    masked: key ? maskKey(key) : "",
  });
}

router.get("/settings/economyos-key", async (_req, res): Promise<void> => {
  res.json(economyosStatusPayload());
});

router.post("/settings/economyos-key", async (req, res): Promise<void> => {
  const parsed = SetApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setEconomyosApiKey(parsed.data.apiKey);
  res.json(economyosStatusPayload());
});

router.delete("/settings/economyos-key", async (_req, res): Promise<void> => {
  await clearEconomyosApiKey();
  res.json(economyosStatusPayload());
});

// Active LLM inference provider ("surplus" | "venice" | "economyos" | "openrouter").
router.get("/settings/llm-provider", async (_req, res): Promise<void> => {
  res.json(
    GetLlmProviderResponse.parse({ provider: normalizeProviderId(getLlmProvider()) }),
  );
});

// All available LLM inference providers, sourced from the registry so adding a
// provider in lib/llm-provider.ts surfaces it in the UI with no further wiring.
router.get("/settings/llm-providers", async (_req, res): Promise<void> => {
  res.json(
    ListLlmProvidersResponse.parse({
      providers: Object.values(LLM_PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
      })),
    }),
  );
});

router.post("/settings/llm-provider", async (req, res): Promise<void> => {
  const parsed = SetLlmProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!(parsed.data.provider in LLM_PROVIDERS)) {
    res.status(400).json({ error: `Unknown provider: ${parsed.data.provider}` });
    return;
  }
  await setLlmProvider(parsed.data.provider);
  res.json(GetLlmProviderResponse.parse({ provider: parsed.data.provider }));
});

// bunnyDS — the bunnyOS managed data + inference gateway. A per-user master
// toggle: ON (default) routes data tool calls + inference through the gateway
// authenticated by the user's own wallet session token (metered against their
// USDC allowance); OFF falls back to the user's own keys (open-source / BYO
// mode). `connected`/`gatewayConfigured` now reflect whether THIS user has
// minted a wallet session token — without one the gateway routes nothing and
// the user falls back to their own keys. (`gatewayConfigured` kept as an alias
// for backward-compatible clients.)
function bunnyDsPayload() {
  const connected = isGatewayConfigured();
  return {
    enabled: getBunnyDsEnabled(),
    connected,
    gatewayConfigured: connected,
  };
}

router.get("/settings/bunny-ds", async (_req, res): Promise<void> => {
  res.json(bunnyDsPayload());
});

router.post("/settings/bunny-ds", async (req, res): Promise<void> => {
  const enabled = (req.body ?? {}).enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "`enabled` must be a boolean" });
    return;
  }
  await setBunnyDsEnabled(enabled);
  res.json(bunnyDsPayload());
});

// User language preference. Persisted server-side so background-generated
// action recommendations/alerts (produced by the scanner, with no request or
// browser to read `lang` from) are written natively in the user's language.
router.get("/settings/lang", async (_req, res): Promise<void> => {
  res.json({ lang: getLang() });
});

router.post("/settings/lang", async (req, res): Promise<void> => {
  const lang = normalizeAgentLang((req.body ?? {}).lang);
  await setLang(lang);
  res.json({ lang });
});

export default router;
