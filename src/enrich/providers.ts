import { buildEnrichmentPrompt } from "./prompt.js";

/**
 * Every provider difference lives in this file.
 *
 * Adding one is a single entry: how to build the request, how to find the text
 * in the response, and which env var holds its key. The prompt, the JSON
 * contract, the batching, the cache and the privacy filter are all shared, so a
 * provider cannot quietly introduce its own version of any of them.
 *
 * This module is imported by the browser AND by the serverless function, so it
 * stays pure — no fetch, no process.env, no key material.
 */

export type ProviderId = "anthropic" | "gemini";

export interface ModelOption {
  readonly id: string;
  readonly label: string;
  /** Shown in the picker, so the cost of a choice is visible before making it. */
  readonly note?: string;
}

export interface UpstreamRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ProviderSpec {
  readonly id: ProviderId;
  readonly label: string;
  /** Read by the serverless function only. The value never reaches the client. */
  readonly envVar: string;
  readonly models: readonly ModelOption[];
  readonly defaultModel: string;
  /** `apiKey` is empty in the single-file build, which has no server to hold
   *  one; the auth header is then omitted rather than sent blank. */
  buildRequest(model: string, keys: readonly string[], apiKey: string): UpstreamRequest;
  /** Same wire shape, caller-supplied prompt. Insights analysis rides through
   *  here so a second feature cannot arrive with a second request builder. */
  buildPromptRequest(model: string, prompt: string, apiKey: string): UpstreamRequest;
  extractText(data: unknown): string;
}

/**
 * Sized for a full batch. At roughly 36 tokens per identified merchant the
 * 120-merchant cap needs about 4,400, and a ceiling below that truncates the
 * JSON mid-array — which surfaces as a whole failed batch rather than a short
 * one, because a half-written array cannot be parsed at all.
 */
export const MAX_OUTPUT_TOKENS = 8192;

/* ------------------------------------------------------------------ */
/* Anthropic                                                           */
/* ------------------------------------------------------------------ */

const anthropic: ProviderSpec = {
  id: "anthropic",
  label: "Anthropic",
  envVar: "ANTHROPIC_API_KEY",
  models: [
    { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "cheapest, fine for merchant names" },
    { id: "claude-sonnet-5", label: "Sonnet 5", note: "balanced" },
    { id: "claude-opus-5", label: "Opus 5", note: "most capable, most expensive" },
  ],
  defaultModel: "claude-sonnet-5",

  buildRequest(model, keys, apiKey) {
    return this.buildPromptRequest(model, buildEnrichmentPrompt(keys), apiKey);
  },

  buildPromptRequest(model, prompt, apiKey) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    };
  },

  extractText(data) {
    const blocks = (data as { content?: unknown })?.content;
    if (!Array.isArray(blocks)) throw new Error("Unexpected response shape");
    return blocks
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text"
      )
      .map((b) => b.text)
      .join("");
  },
};

/* ------------------------------------------------------------------ */
/* Google Gemini                                                       */
/* ------------------------------------------------------------------ */

const gemini: ProviderSpec = {
  id: "gemini",
  label: "Google Gemini",
  envVar: "GEMINI_API_KEY",
  models: [
    { id: "gemini-2.5-flash", label: "2.5 Flash", note: "free tier" },
    { id: "gemini-2.5-flash-lite", label: "2.5 Flash-Lite", note: "free tier, fastest" },
    { id: "gemini-2.0-flash", label: "2.0 Flash", note: "free tier" },
    { id: "gemini-2.0-flash-lite", label: "2.0 Flash-Lite", note: "free tier" },
  ],
  defaultModel: "gemini-2.5-flash",

  buildRequest(model, keys, apiKey) {
    return this.buildPromptRequest(model, buildEnrichmentPrompt(keys), apiKey);
  },

  buildPromptRequest(model, prompt, apiKey) {
    return {
      // The model id is a path segment, so it is encoded rather than trusted —
      // it reaches here from a request body.
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          // Gemini can be held to JSON natively, which removes the code-fence
          // guessing. parseFacts still strips fences: belt and braces.
          responseMimeType: "application/json",
          // 2.5 Flash thinks by default and thinking is billed against the same
          // output ceiling, so a long think returns MAX_TOKENS with empty text.
          // Naming merchants needs no reasoning budget. 2.0 rejects the field.
          ...(model.startsWith("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    };
  },

  extractText(data) {
    const candidates = (data as { candidates?: unknown })?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      const blocked = (data as { promptFeedback?: { blockReason?: string } })?.promptFeedback
        ?.blockReason;
      throw new Error(
        blocked ? `Gemini blocked the request: ${blocked}` : "Unexpected response shape"
      );
    }
    const first = candidates[0] as {
      content?: { parts?: unknown };
      finishReason?: string;
    };
    const parts = first?.content?.parts;
    if (!Array.isArray(parts)) {
      // An empty candidate with a finish reason is the common failure, and the
      // reason is the whole diagnosis — surface it instead of "bad shape".
      throw new Error(
        first?.finishReason
          ? `Gemini returned no text (${first.finishReason})`
          : "Unexpected response shape"
      );
    }
    return parts
      .filter(
        (p): p is { text: string } =>
          typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string"
      )
      .map((p) => p.text)
      .join("");
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const PROVIDERS: readonly ProviderSpec[] = [anthropic, gemini];

export function providerFor(id: unknown): ProviderSpec | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * The model arrives from a request body, so it is checked against the registry
 * rather than passed through. Without this the function is an open relay to any
 * model on the provider's account.
 */
export function resolveModel(spec: ProviderSpec, requested: unknown): string | null {
  if (requested === undefined || requested === null || requested === "") return spec.defaultModel;
  if (typeof requested !== "string") return null;
  return spec.models.some((m) => m.id === requested) ? requested : null;
}

/**
 * What the client is told: the catalogue plus whether a key is present. The env
 * var NAME travels (it is what the operator needs to be told to set); the value
 * never leaves the server.
 */
export interface ProviderAvailability {
  readonly id: ProviderId;
  readonly label: string;
  readonly envVar: string;
  readonly models: readonly ModelOption[];
  readonly defaultModel: string;
  readonly configured: boolean;
}

export function describeProviders(
  isConfigured: (spec: ProviderSpec) => boolean
): ProviderAvailability[] {
  return PROVIDERS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    envVar: spec.envVar,
    models: spec.models,
    defaultModel: spec.defaultModel,
    configured: isConfigured(spec),
  }));
}
