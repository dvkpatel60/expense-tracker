import { directTransport } from "./direct.js";
import { parseFacts } from "./facts.js";
import { providerFor } from "./providers.js";
import type { MerchantFacts } from "../core/types.js";
import type { EnrichmentTransport } from "./types.js";

/**
 * Anthropic, spelled out.
 *
 * The generic path is directTransport; this stays because Anthropic was the
 * only provider before the registry existed and its wire format is the one the
 * tests pin. Only merchant strings cross this boundary.
 */
export function anthropicTransport(config: {
  model?: string;
  today: string;
  fetchImpl?: typeof fetch;
}): EnrichmentTransport {
  return directTransport({
    provider: "anthropic",
    today: config.today,
    ...(config.model ? { model: config.model } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
  });
}

/** Anthropic's envelope, unwrapped and parsed. Kept as a named export because
 *  it is the wire format most of the enrichment tests are written against. */
export function parseResponse(data: unknown, today: string): MerchantFacts[] {
  const spec = providerFor("anthropic");
  if (!spec) throw new Error("Anthropic provider is not registered");
  return parseFacts(spec.extractText(data), today);
}
