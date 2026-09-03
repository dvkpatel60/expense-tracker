import { CATEGORIES } from "../core/categorize.js";
import type { CategoryId, MerchantFacts } from "../core/types.js";

/**
 * Turn the model's JSON array into merchant facts.
 *
 * The array shape is dictated by our prompt, not by the provider, so every
 * provider returns the same thing wrapped in a different envelope. Unwrapping
 * is per-provider (see providers.ts); this parse is shared, which is what stops
 * a second provider from arriving with a second, subtly different parser.
 *
 * Defensive throughout: a model response is untrusted input like any other.
 */
export function parseFacts(text: string, today: string): MerchantFacts[] {
  const cleaned = text.replace(/```json|```/g, "").trim();
  if (!cleaned) throw new Error("The model returned nothing to parse");
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  return collect(parsed, today);
}

/**
 * For facts that arrive already parsed — our own function normalizes before it
 * responds, so the browser never sees a provider envelope. Still validated:
 * the payload crossed a network to get here.
 */
export function coerceFacts(value: unknown, today: string): MerchantFacts[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array of facts");
  return collect(value, today);
}

function collect(items: readonly unknown[], today: string): MerchantFacts[] {
  const valid = new Set<string>(CATEGORIES);
  const out: MerchantFacts[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    // Accept both the model's "category" and our own "categoryId", so a fact
    // survives a round trip through the function without being renamed twice.
    const rawCategory = typeof r["category"] === "string" ? r["category"] : r["categoryId"];
    const category =
      typeof rawCategory === "string" && valid.has(rawCategory)
        ? (rawCategory as CategoryId)
        : undefined;
    if (typeof r["key"] !== "string" || !r["key"]) continue;
    out.push({
      key: r["key"],
      name: typeof r["name"] === "string" && r["name"] ? r["name"] : r["key"],
      ...(typeof r["note"] === "string" && r["note"] ? { note: r["note"] } : {}),
      ...(category ? { categoryId: category } : {}),
      ...(typeof r["commonlyShared"] === "boolean"
        ? { commonlyShared: r["commonlyShared"] }
        : {}),
      retrievedOn: typeof r["retrievedOn"] === "string" ? r["retrievedOn"] : today,
    });
  }
  return out;
}
