import {
  getLlmProvider,
  getApiKey,
  getSurplusApiKey,
  getVeniceApiKey,
  getEconomyosApiKey,
  getBunnyDsEnabled,
} from "./settings";
import {
  getGatewaySessionToken,
  gatewayInferenceBaseUrl,
  isGatewayConfigured,
} from "./bunnyos-gateway";

// Inference is provider-pluggable. All providers are OpenAI-compatible
// (chat completions + a /models catalog with the same `data[]` shape), so the
// agent's call/stream/list code only needs the URL, the auth headers, and a
// default model id per provider.

export type LlmProviderId =
  | "bunnyos"
  | "openrouter"
  | "surplus"
  | "venice"
  | "economyos";

export interface LlmProvider {
  id: LlmProviderId;
  label: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
  // Tried in order if the user's stored model fails or is unset.
  fallbackModels: string[];
  // OpenRouter wants HTTP-Referer + X-Title for attribution; Surplus does not.
  sendOpenRouterHeaders: boolean;
  // Authorization scheme for the bearer-style credential. The bunnyOS gateway
  // authenticates the wallet session token as `Wallet <token>`; every other
  // provider uses a plain API key as `Bearer <key>`.
  authScheme: "Bearer" | "Wallet";
}

// Insertion order is the recommended order shown in the UI picker. bunnyOS is
// first: when bunnyDS is on, inference is served through the bunnyOS managed
// gateway authenticated by the user's own wallet session token (metered against
// their USDC allowance), so the user needs no inference API key of their own.
export const LLM_PROVIDERS: Record<LlmProviderId, LlmProvider> = {
  bunnyos: {
    id: "bunnyos",
    label: "bunnyOS",
    chatCompletionsUrl: `${gatewayInferenceBaseUrl()}/chat/completions`,
    modelsUrl: `${gatewayInferenceBaseUrl()}/models`,
    // Locked to deepseek-v4-flash by user mandate: never escalate bunnyDS
    // inference to the expensive gpt-5.5 / claude-opus tiers.
    fallbackModels: ["deepseek-v4-flash"],
    sendOpenRouterHeaders: false,
    authScheme: "Wallet",
  },
  surplus: {
    id: "surplus",
    label: "Surplus Intelligence",
    chatCompletionsUrl:
      "https://www.surplusintelligence.ai/api/inference/v1/chat/completions",
    modelsUrl: "https://www.surplusintelligence.ai/api/inference/v1/models",
    fallbackModels: ["gpt-5.4"],
    sendOpenRouterHeaders: false,
    authScheme: "Bearer",
  },
  venice: {
    id: "venice",
    label: "Venice",
    chatCompletionsUrl: "https://api.venice.ai/api/v1/chat/completions",
    modelsUrl: "https://api.venice.ai/api/v1/models",
    fallbackModels: ["openai-gpt-54"],
    sendOpenRouterHeaders: false,
    authScheme: "Bearer",
  },
  economyos: {
    id: "economyos",
    label: "EconomyOS (Virtuals Protocol)",
    chatCompletionsUrl: "https://compute.virtuals.io/v1/chat/completions",
    modelsUrl: "https://compute.virtuals.io/v1/models",
    fallbackModels: ["deepseek-v4-flash"],
    sendOpenRouterHeaders: false,
    authScheme: "Bearer",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    chatCompletionsUrl: "https://openrouter.ai/api/v1/chat/completions",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    fallbackModels: ["openai/gpt-5.4"],
    sendOpenRouterHeaders: true,
    authScheme: "Bearer",
  },
};

export function normalizeProviderId(v: unknown): LlmProviderId {
  return typeof v === "string" && v in LLM_PROVIDERS
    ? (v as LlmProviderId)
    : "bunnyos";
}

export function getActiveProviderId(): LlmProviderId {
  const stored = normalizeProviderId(getLlmProvider());
  // bunnyDS is the master switch for the managed gateway. ON → inference goes
  // through bunnyOS regardless of the stored pick. OFF → fall back to the
  // user's own provider; if that pick is "bunnyos" (which needs the gateway),
  // default to OpenRouter so we never route inference through a disabled
  // service.
  if (getBunnyDsEnabled() && isGatewayConfigured()) return "bunnyos";
  return stored === "bunnyos" ? "openrouter" : stored;
}

export function getActiveProvider(): LlmProvider {
  return LLM_PROVIDERS[getActiveProviderId()];
}

// The API key for whichever provider is currently active.
export function getActiveApiKey(): string | undefined {
  switch (getActiveProviderId()) {
    case "bunnyos":
      return getGatewaySessionToken();
    case "surplus":
      return getSurplusApiKey();
    case "venice":
      return getVeniceApiKey();
    case "economyos":
      return getEconomyosApiKey();
    default:
      return getApiKey();
  }
}
