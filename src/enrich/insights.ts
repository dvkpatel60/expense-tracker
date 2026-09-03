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

export type InsightKind =
  | "headline"
  | "summary"
  | "trend"
  | "anomaly"
  | "habit"
  | "savings"
  | "action";

export interface Insight {
  readonly kind: InsightKind;
  readonly text: string;
  /** When present, the insight is about one category and the UI links to it. */
  readonly categoryId?: CategoryId;
}

const KINDS = new Set<string>([
  "headline",
  "summary",
  "trend",
  "anomaly",
  "habit",
  "savings",
  "action",
]);

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

/**
 * The copilot asks predefined questions, not free-form ones.
 *
 * A workflow is an *instruction*, never data: it changes what the model is
 * asked to pay attention to in the digest it was always going to receive. That
 * is the whole reason the copilot does not widen the privacy boundary — there
 * is no workflow that can carry a transaction, a date or a name across the
 * wire, because a workflow is a sentence appended to a prompt.
 *
 * It arrives in a request body, so like the model id it is resolved against
 * this registry rather than interpolated. An unknown id is refused.
 */
export type WorkflowId = "explain" | "savings" | "anomalies" | "compare" | "category";

export interface Workflow {
  readonly id: WorkflowId;
  readonly label: string;
  /** What the button promises, shown beneath it. */
  readonly hint: string;
  /** Appended to the prompt verbatim. */
  readonly instruction: string;
  /** Meaningless without a category in focus, so the UI disables it until one
   *  is selected and the server refuses it without one. */
  readonly needsFocus?: boolean;
}

export const WORKFLOWS: readonly Workflow[] = [
  {
    id: "explain",
    label: "Explain this period",
    hint: "What moved, and what it actually cost you",
    instruction:
      "Give a rounded read on the period: the largest categories, how your own spend compares to the cash that left the accounts, and anything worth knowing. Lead with the single most useful fact.",
  },
  {
    id: "savings",
    label: "Find savings",
    hint: "Where money is recoverable, and how",
    instruction:
      "Concentrate on money that is recoverable: categories where your share exceeds what you should carry, recurring merchants worth renegotiating or cancelling, and outstanding claims. Every point must name a concrete action. Prefer kind \"savings\".",
  },
  {
    id: "anomalies",
    label: "Spot anomalies",
    hint: "Merchants and categories that broke pattern",
    instruction:
      "Concentrate on what is unusual: a category far from its previous figure, a merchant that appeared or jumped, a cadence that broke. Say plainly when nothing is unusual rather than inventing an outlier. Prefer kind \"anomaly\".",
  },
  {
    id: "compare",
    label: "Compare to last period",
    hint: "What changed since the previous month",
    instruction:
      "Concentrate on the comparison with the previous period: which categories rose and fell, and by how much. If no previous period is available, say exactly that and stop. Prefer kind \"trend\".",
  },
  {
    id: "category",
    label: "Summarize category",
    hint: "One category in depth",
    needsFocus: true,
    instruction:
      "Concentrate on the category named below: its size against the rest of the period, how it moved, which merchants drive it, and what could be done about it.",
  },
];

export function workflowFor(id: unknown): Workflow | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Tone                                                                */
/* ------------------------------------------------------------------ */

/**
 * How much licence the model has. This is the only control that reaches a
 * provider parameter (temperature); everything else is prompt text, so a tone
 * cannot change what is sent, only how it is answered.
 */
export type ToneId = "conservative" | "balanced" | "creative";

export interface Tone {
  readonly id: ToneId;
  readonly label: string;
  readonly temperature: number;
  readonly instruction: string;
}

export const TONES: readonly Tone[] = [
  {
    id: "conservative",
    label: "Conservative",
    temperature: 0,
    instruction: "Stay strictly with what the figures show. Do not speculate about causes.",
  },
  { id: "balanced", label: "Balanced", temperature: 0.4, instruction: "" },
  {
    id: "creative",
    label: "Creative",
    temperature: 0.9,
    instruction:
      "You may offer less obvious readings and suggestions, but never invent a figure that is not above.",
  },
];

export const DEFAULT_TONE: ToneId = "balanced";

export function toneFor(id: unknown): Tone | null {
  return TONES.find((t) => t.id === id) ?? null;
}

/** What a workflow request carries beyond the digest. Every field is resolved
 *  against a registry above, so none of it is free text on the wire. */
export interface AnalysisOptions {
  readonly workflow?: WorkflowId;
  readonly tone?: ToneId;
  /** A category to concentrate on. A category id, never a transaction. */
  readonly focus?: CategoryId;
}

/** One headline plus a handful of observations. More is a report, not insight. */
export const MAX_INSIGHTS = 8;

const dollars = (c: number): string => `$${(Math.abs(c) / 100).toFixed(2)}`;

export function buildInsightsPrompt(
  digest: InsightsDigest,
  options: AnalysisOptions = {}
): string {
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

  // The workflow and the tone are appended, never interpolated from user text:
  // both are resolved against the registries above before they get here.
  const workflow = workflowFor(options.workflow);
  const tone = toneFor(options.tone) ?? toneFor(DEFAULT_TONE)!;
  const focus = options.focus;
  const task: string[] = [];
  if (workflow) task.push(workflow.instruction);
  if (focus) task.push(`The category to concentrate on is ${focus}.`);
  if (tone.instruction) task.push(tone.instruction);

  return `You are analyzing one person's spending summary. "Own spend" already excludes what friends owe them back. Amounts are Canadian dollars.
 
${lines.join("\n")}
${task.length > 0 ? `\nWhat to concentrate on:\n${task.join(" ")}\n` : ""}
Write at most ${MAX_INSIGHTS} insights. Respond with ONLY a JSON array, no preamble and no code fences. Each element:
{"kind":"<headline|summary|trend|anomaly|habit|savings|action>","text":"<specific, cite figures>","categoryId":"<optional, one of: ${CATEGORIES.join(", ")}>"}

Attach categoryId whenever an insight is about one category, so it can be linked to those transactions.
Exactly one element must have kind "headline": the single most useful thing to know about this period, under 20 words.
At most one element may have kind "summary": two or three sentences of plain prose answering what was asked, for a reader who wants the shape of it before the individual points. Omit it if the headline already says everything.
"trend" compares against the previous period. "anomaly" flags something unusual for one merchant or category. "habit" names a recurring pattern from the recurring list. "savings" points at a savings opportunity — a category where friends owe you back — and suggests one concrete, specific way to recover that money (split it more often, negotiate or switch a recurring provider, settle that outstanding claim). "action" suggests one concrete, non-judgmental step.
Do not moralize, do not pad, and skip any kind you have nothing real to say for.`;
}

/**
 * Server-side check on everything that rides alongside the digest.
 *
 * Same posture as resolveModel: these arrive in a request body, so an unknown
 * workflow, tone or focus category is refused rather than passed through into a
 * prompt. Returns an error message, or null when the options are clean.
 */
export function validateAnalysisOptions(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return "Analysis options must be an object.";
  const o = value as Record<string, unknown>;

  if (o["workflow"] !== undefined && o["workflow"] !== null && !workflowFor(o["workflow"]))
    return `Unknown workflow: ${String(o["workflow"])}.`;
  if (o["tone"] !== undefined && o["tone"] !== null && !toneFor(o["tone"]))
    return `Unknown tone: ${String(o["tone"])}.`;

  const focus = o["focus"];
  if (focus !== undefined && focus !== null) {
    if (typeof focus !== "string" || !(CATEGORIES as readonly string[]).includes(focus))
      return "focus must be a known category.";
  }

  // A workflow about one category with no category named would send the model
  // an instruction it cannot follow, so it is a bad request rather than a
  // silently generic answer.
  const workflow = workflowFor(o["workflow"]);
  if (workflow?.needsFocus && !focus) return `${workflow.label} needs a category in focus.`;

  return null;
}

/** The temperature a tone asks for, resolved through the registry so a number
 *  from a request body can never reach a provider. */
export function temperatureFor(tone: unknown): number {
  return (toneFor(tone) ?? toneFor(DEFAULT_TONE)!).temperature;
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
