import { CATEGORIES } from "../core/categorize.js";
import { buildEnrichmentPrompt, ENRICHMENT_MODEL } from "./prompt.js";
import type { CategoryId, MerchantFacts } from "../core/types.js";
import type { EnrichmentTransport } from "./types.js";

/** Only merchant strings cross this boundary. */
export function anthropicTransport(config: {
  endpoint?: string;
  model?: string;
  today: string;
  fetchImpl?: typeof fetch;
}): EnrichmentTransport {
  const endpoint = config.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = config.model ?? ENRICHMENT_MODEL;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async lookup(keys) {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          messages: [{ role: "user", content: buildEnrichmentPrompt(keys) }],
        }),
      });
      if (!res.ok) throw new Error(`Lookup failed with status ${res.status}`);
      const data: unknown = await res.json();
      return parseResponse(data, config.today);
    },
  };
}

/** Defensive: a model response is untrusted input like any other. */
export function parseResponse(data: unknown, today: string): MerchantFacts[] {
  const blocks = (data as { content?: unknown })?.content;
  if (!Array.isArray(blocks)) throw new Error("Unexpected response shape");

  const text = blocks
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "text"
    )
    .map((b) => b.text)
    .join("");

  const cleaned = text.replace(/```json|```/g, "").trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");

  const valid = new Set<string>(CATEGORIES);
  const out: MerchantFacts[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["key"] !== "string" || !r["key"]) continue;
    const category = typeof r["category"] === "string" && valid.has(r["category"])
      ? (r["category"] as CategoryId)
      : undefined;
    out.push({
      key: r["key"],
      name: typeof r["name"] === "string" && r["name"] ? r["name"] : r["key"],
      ...(typeof r["note"] === "string" && r["note"] ? { note: r["note"] } : {}),
      ...(category ? { categoryId: category } : {}),
      ...(typeof r["commonlyShared"] === "boolean" ? { commonlyShared: r["commonlyShared"] } : {}),
      retrievedOn: today,
    });
  }
  return out;
}
