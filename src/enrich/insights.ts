import { CATEGORIES } from "../core/categorize.js";
import { MAX_DIGEST_MERCHANTS } from "../core/digest.js";
import type { InsightsDigest } from "../core/digest.js";
import type { CategoryId } from "../core/types.js";

/**
 * AI spending analysis over the aggregates-only digest.
 *
 * Prompt, parsing and digest validation live in one file shared by the browser
 * transport and the serverless function, for the same reason prompt.ts and
 * facts.ts do: two copies of a contract is how the two ends drift apart.
 */

export type InsightKind = "headline" | "trend" | "anomaly" | "habit" | "savings" | "action";

export interface Insight {
  readonly kind: InsightKind;
  readonly text: string;
  /** When present, the insight is about one category and the UI links to it. */
  readonly categoryId?: CategoryId;
}

const KINDS = new Set<string>(["headline", "trend", "anomaly", "habit", "savings", "action"]);

/** One headline plus a handful of observations. More is a report, not insight. */
export const MAX_INSIGHTS = 8;

const dollars = (c: number): string => `$${(Math.abs(c) / 100).toFixed(2)}`;

export function buildInsightsPrompt(digest: InsightsDigest): string {
  const t = digest.totals;
  const p = digest.previousTotals;
  const lines: string[] = [
    `Period: ${digest.period ?? "all time"}`,
    `Own spend ${dollars(t.yourShare)} across ${t.transactionCount} purchases; ${dollars(t.cashOut)} cash out, ${dollars(t.recovered)} of that covered by others.`,
  ];
  // A previous period with nothing in it means the ledger does not go back
  // that far, not that the person spent nothing. Saying "$0.00" invites a
  // triumphant trend about a month that was never imported.
  if (p && p.transactionCount > 0) {
    lines.push(
      `Previous period: own spend ${dollars(p.yourShare)} across ${p.transactionCount} purchases.`
    );
  } else {
    lines.push("No earlier period is available, so do not describe any trend over time.");
  }
  if (digest.openClaims.count > 0) {
    lines.push(
      `${digest.openClaims.count} split claims open, ${dollars(digest.openClaims.total)} total outstanding.`
    );
  }
  const hasPrior = Boolean(p && p.transactionCount > 0);
  lines.push(
    "",
    hasPrior
      ? "Categories (own spend / cash out / count / own spend previous period):"
      : "Categories (own spend / cash out / count):"
  );
  for (const c of digest.categories) {
    lines.push(
      `- ${c.categoryId}: ${dollars(c.yourShare)} / ${dollars(c.cashOut)} / ${c.transactionCount}${
        hasPrior ? ` / ${dollars(c.previousYourShare)}` : ""
      }`
    );
  }
  lines.push("", "Top merchants (own spend / count):");
  for (const m of digest.topMerchants) {
    lines.push(`- ${m.merchant}: ${dollars(m.yourShare)} / ${m.transactionCount}`);
  }

  if (digest.recurringCandidates.length > 0) {
    lines.push("", "Recurring merchants (avg amount / cadence / regularity 0-1):");
    for (const r of digest.recurringCandidates) {
      lines.push(
        `- ${r.merchant}: ${dollars(r.avgAmount)} / ${r.frequency} / ${r.regularity.toFixed(2)}`
      );
    }
  }

  if (digest.savingsOpportunity.length > 0) {
    lines.push(
      "",
      "Savings opportunities — categories where your share exceeds the cash out (you carry more than everyone else's share):"
    );
    for (const s of digest.savingsOpportunity) {
      lines.push(
        `- ${s.categoryId}: your share ${dollars(s.yourShare)} vs ${dollars(s.cashOut)} paid out, ${dollars(s.potentialSavings)} recoverable from others`
      );
    }
  }

  if (digest.topMerchantDelta.length > 0) {
    lines.push("", "Merchants that moved most (current share / previous share):");
    for (const m of digest.topMerchantDelta) {
      lines.push(`- ${m.merchant}: ${dollars(m.currentShare)} / ${dollars(m.previousShare)}`);
    }
  }

  return `You are analyzing one person's spending summary. "Own spend" already excludes what friends owe them back. Amounts are Canadian dollars.
 
${lines.join("\n")}

Write at most ${MAX_INSIGHTS} insights. Respond with ONLY a JSON array, no preamble and no code fences. Each element:
{"kind":"<headline|trend|anomaly|habit|savings|action>","text":"<one sentence, specific, cite figures>","categoryId":"<optional, one of: ${CATEGORIES.join(", ")}>"}

Attach categoryId whenever an insight is about one category, so it can be linked to those transactions.
Exactly one element must have kind "headline": the single most useful thing to know about this period, under 20 words.
"trend" compares against the previous period. "anomaly" flags something unusual for one merchant or category. "habit" names a recurring pattern from the recurring list. "savings" points at a savings opportunity — a category where friends owe you back — and should suggest one concrete way to recover that money. "action" suggests one concrete, non-judgmental step.
Do not moralize, do not pad, and skip any kind you have nothing real to say for.`;
}

/** Turn the model's JSON array into insights. Same defensive posture as
 *  parseFacts: a model response is untrusted input like any other. */
export function parseInsights(text: string): Insight[] {
  const cleaned = text.replace(/```json|```/g, "").trim();
  if (!cleaned) throw new Error("The model returned nothing to parse");
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  return coerceInsights(parsed);
}

/** For insights that arrive already parsed from our own function. */
export function coerceInsights(value: unknown): Insight[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array of insights");
  const valid = new Set<string>(CATEGORIES);
  const out: Insight[] = [];
  for (const item of value) {
    if (out.length >= MAX_INSIGHTS) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["kind"] !== "string" || !KINDS.has(r["kind"])) continue;
    if (typeof r["text"] !== "string" || !r["text"].trim()) continue;
    const category =
      typeof r["categoryId"] === "string" && valid.has(r["categoryId"])
        ? (r["categoryId"] as CategoryId)
        : undefined;
    out.push({
      kind: r["kind"] as InsightKind,
      text: r["text"].trim(),
      ...(category ? { categoryId: category } : {}),
    });
  }
  return out;
}

/**
 * Server-side re-validation of an incoming digest, so aggregates-only is
 * enforced rather than promised. Returns an error message, or null when the
 * payload really is nothing but totals. Anything with a shape this function
 * does not know — extra arrays, day-level dates, counterparty keys — fails.
 */
export function validateDigest(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "Send { digest }.";
  const d = value as Record<string, unknown>;

  if (d["period"] !== null && !(typeof d["period"] === "string" && /^\d{4}-\d{2}$/.test(d["period"])))
    return "period must be YYYY-MM or null.";
  if (!totalsOk(d["totals"])) return "totals must be four finite numbers.";
  if (d["previousTotals"] !== null && !totalsOk(d["previousTotals"]))
    return "previousTotals must be totals or null.";

  const cats = d["categories"];
  if (!Array.isArray(cats) || cats.length > CATEGORIES.length)
    return "categories must be a bounded array.";
  const valid = new Set<string>(CATEGORIES);
  for (const c of cats) {
    const r = c as Record<string, unknown>;
    if (typeof r !== "object" || r === null || !valid.has(String(r["categoryId"])))
      return "categories contain an unknown category.";
    if (![r["yourShare"], r["cashOut"], r["transactionCount"], r["previousYourShare"]].every(finite))
      return "category figures must be finite numbers.";
  }

  const merchants = d["topMerchants"];
  if (!Array.isArray(merchants) || merchants.length > MAX_DIGEST_MERCHANTS)
    return `topMerchants must be at most ${MAX_DIGEST_MERCHANTS} entries.`;
  for (const m of merchants) {
    const r = m as Record<string, unknown>;
    if (typeof r !== "object" || r === null) return "topMerchants entries must be objects.";
    const key = r["merchant"];
    if (typeof key !== "string" || !key || key.length > 120)
      return "Merchant keys must be non-empty strings under 120 characters.";
    // Belt and braces, same as /api/enrich: a counterparty must never reach a model.
    if (key.startsWith("etransfer:")) return "Counterparty keys are not eligible for analysis.";
    if (![r["yourShare"], r["transactionCount"]].every(finite))
      return "Merchant figures must be finite numbers.";
  }

  const claims = d["openClaims"] as Record<string, unknown> | null;
  if (typeof claims !== "object" || claims === null || !finite(claims["count"]) || !finite(claims["total"]))
    return "openClaims must be aggregate count and total.";

  const recurring = d["recurringCandidates"];
  if (!Array.isArray(recurring) || recurring.length > MAX_DIGEST_MERCHANTS)
    return "recurringCandidates must be a bounded array.";
  for (const r of recurring) {
    const o = r as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return "recurringCandidates entries must be objects.";
    if (typeof o["merchant"] !== "string" || !o["merchant"] || (o["merchant"] as string).startsWith("etransfer:"))
      return "Recurring merchant keys must not be counterparties.";
    if (!finite(o["avgAmount"]) || (o["frequency"] !== "monthly" && o["frequency"] !== "weekly") || !finite(o["regularity"]))
      return "Recurring fields must be an amount, a known cadence and a regularity.";
  }

  const savings = d["savingsOpportunity"];
  if (!Array.isArray(savings)) return "savingsOpportunity must be an array.";
  for (const s of savings) {
    const o = s as Record<string, unknown>;
    if (typeof o !== "object" || o === null || !valid.has(String(o["categoryId"])))
      return "savingsOpportunity names an unknown category.";
    if (![o["yourShare"], o["cashOut"], o["potentialSavings"]].every(finite))
      return "savingsOpportunity figures must be finite numbers.";
  }

  const deltas = d["topMerchantDelta"];
  if (!Array.isArray(deltas) || deltas.length > MAX_DIGEST_MERCHANTS)
    return "topMerchantDelta must be a bounded array.";
  for (const m of deltas) {
    const o = m as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return "topMerchantDelta entries must be objects.";
    const key = o["merchant"];
    if (typeof key !== "string" || !key || (key as string).startsWith("etransfer:"))
      return "Merchant deltas must not be counterparties.";
    if (![o["currentShare"], o["previousShare"]].every(finite))
      return "Merchant delta figures must be finite numbers.";
  }

  return null;
}

const finite = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

function totalsOk(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return [t["cashOut"], t["yourShare"], t["recovered"], t["transactionCount"]].every(finite);
}
