import { coerceFacts } from "./facts.js";
import { coerceInsights } from "./insights.js";
import type { AnalysisOptions, Insight } from "./insights.js";
import type { InsightsDigest } from "../core/digest.js";
import type { ProviderAvailability, ProviderId } from "./providers.js";
import type { EnrichmentTransport } from "./types.js";

/**
 * Talks to our own serverless function instead of a provider directly.
 *
 * This is the shape any real deployment needs: an API key cannot live in a
 * browser bundle, so keys stay on the server and the client posts nothing but a
 * list of merchant strings plus which provider to ask.
 *
 * The function normalizes before responding, so provider envelopes never reach
 * the browser — adding a provider changes nothing on this side of the wire.
 */
export function proxyTransport(config: {
  endpoint?: string;
  provider: ProviderId;
  model?: string;
  today: string;
  fetchImpl?: typeof fetch;
}): EnrichmentTransport {
  const endpoint = config.endpoint ?? "/api/enrich";
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async lookup(keys) {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchants: keys,
          provider: config.provider,
          ...(config.model ? { model: config.model } : {}),
        }),
      });
      if (!res.ok) throw new Error(await explain(res));
      const data: unknown = await res.json();
      return coerceFacts((data as { facts?: unknown })?.facts, config.today);
    },
  };
}

/** The function explains itself in the body; surfacing that beats a bare code,
 *  because "not configured" and "rate limited" need different reactions. */
async function explain(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* fall through to the status */
  }
  return `Lookup failed with status ${res.status}`;
}

/**
 * Which providers this deployment can actually use. Returns an empty list
 * rather than throwing: no lookup is a degraded mode, not a broken app.
 */
export async function fetchProviders(config: {
  endpoint?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<ProviderAvailability[]> {
  const endpoint = config.endpoint ?? "/api/providers";
  const doFetch = config.fetchImpl ?? fetch;
  try {
    const res = await doFetch(endpoint);
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const list = (data as { providers?: unknown })?.providers;
    return Array.isArray(list) ? (list as ProviderAvailability[]) : [];
  } catch {
    return [];
  }
}

/**
 * Ask our own function to analyze the aggregates digest. One request, one
 * answer — no transport interface, because unlike merchant lookup nothing
 * batches or caches at this layer (the caller remembers answers per digest).
 */
export async function requestInsights(config: {
  endpoint?: string;
  digest: InsightsDigest;
  provider: ProviderId;
  model?: string;
  options?: AnalysisOptions;
  fetchImpl?: typeof fetch;
}): Promise<Insight[]> {
  const endpoint = config.endpoint ?? "/api/insights";
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      digest: config.digest,
      provider: config.provider,
      ...(config.model ? { model: config.model } : {}),
      ...(config.options ? { options: config.options } : {}),
    }),
  });
  if (!res.ok) throw new Error(await explain(res));
  const data: unknown = await res.json();
  return coerceInsights((data as { insights?: unknown })?.insights);
}
