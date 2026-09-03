import { stripGeography } from "./geography.js";

/**
 * Turn a statement description into a stable merchant key.
 *
 * The key is what the enrichment cache is keyed on, so it must be stable across
 * visits to the same merchant. "SQ *BLUE DOOR COFFEE TORONTO ON" and
 * "SQ *BLUE DOOR COFFEE #22 TORONTO ON" have to land on the same key or you
 * pay for the same lookup twice and split the merchant across two rows in the
 * report.
 *
 * Each step is separate and named so a bad rule can be tested in isolation.
 */

type Step = { readonly name: string; readonly apply: (s: string) => string };

/** Wealthsimple prefixes the description with a machine type. Leading only —
 *  stripping WITHDRAWAL anywhere would eat "ABM WITHDRAWAL". */
const WS_TYPE_PREFIX =
  /^\s*(SPEND|E[_\s]TRANSFER([_\s](IN|OUT))?|AFT[_\s](IN|OUT)|INTEREST|REFERRAL|DEPOSIT|WITHDRAWAL|REFUND|REVERSAL)\s+/;

const STEPS: readonly Step[] = [
  { name: "uppercase", apply: (s) => s.toUpperCase() },
  { name: "flatten-field-separators", apply: (s) => s.replace(/\|/g, " ") },
  { name: "collapse", apply: (s) => s.replace(/\s{2,}/g, " ").trim() },
  { name: "ws-type-prefix", apply: (s) => s.replace(WS_TYPE_PREFIX, "") },

  // Payment processors and card networks
  { name: "square", apply: (s) => s.replace(/\bSQ\s*\*\s*/g, " ") },
  { name: "toast", apply: (s) => s.replace(/\bTST\s*[*\-]\s*/g, " ") },
  { name: "shopify", apply: (s) => s.replace(/\bSP\s+(?=[A-Z]{2})/g, " ") },
  { name: "paypal", apply: (s) => s.replace(/\bPAYPAL\s*\*\s*/g, " ") },
  { name: "uber", apply: (s) => s.replace(/\bUBER\s*\*\s*/g, "UBER ") },
  { name: "amazon", apply: (s) => s.replace(/\bAMZN\s+MKTP\s+CA\b/g, "AMAZON") },
  { name: "urls", apply: (s) => s.replace(/\bWWW\.?|\.COM\b|\.CA\b|\.NET\b/g, " ") },

  // Canadian POS and preauthorized debit wrappers
  { name: "interac-debit", apply: (s) => s.replace(/\bIDP\s+PURCHASE\s*-?\s*\d*/g, " ") },
  { name: "pos", apply: (s) => s.replace(/\bPOINT\s+OF\s+SALE\s+(PURCHASE|DEBIT)\b/g, " ") },
  { name: "preauth", apply: (s) => s.replace(/\bPRE-?AUTHORI[SZ]ED\s+(DEBIT|PAYMENT)\b/g, " ") },
  { name: "pap-pad", apply: (s) => s.replace(/\b(PAP|PAD)\b/g, " ") },
  { name: "misc-payment", apply: (s) => s.replace(/\bMISC\s+PAYMENT\b/g, " ") },
  { name: "visa-debit", apply: (s) => s.replace(/\bVISA\s+DEBIT\s+(PURCHASE|RETAIL)\b/g, " ") },
  { name: "contactless", apply: (s) => s.replace(/\bCONTACTLESS\s+(PURCHASE|INTERAC)\b/g, " ") },

  // Identifiers that vary per visit
  { name: "phone", apply: (s) => s.replace(/\b\d{3}[-\s.]?\d{3}[-\s.]?\d{4}\b/g, " ") },
  { name: "store-number", apply: (s) => s.replace(/\s#\s?\d+/g, " ") },
  { name: "long-digits", apply: (s) => s.replace(/\s\d{4,}\b/g, " ") },
  { name: "reference", apply: (s) => s.replace(/\bREF(ERENCE)?\s*[#:]?\s*\w+/g, " ") },

  { name: "punctuation", apply: (s) => s.replace(/[^A-Z0-9&'\-\s]/g, " ") },
  { name: "collapse-2", apply: (s) => s.replace(/\s{2,}/g, " ").trim() },
  { name: "opaque-ids", apply: dropOpaqueIds },
  { name: "dedupe-tokens", apply: (s) => uniqueTokens(s) },
  { name: "geography", apply: stripGeography },
];

/** Order ids like 2H4KL9 or P3A9F2 change every visit and destroy cache hits.
 *  Requires 5+ chars with at least two digits and two letters, so A&W,
 *  7-ELEVEN and M&M survive. */
function dropOpaqueIds(s: string): string {
  const kept = s.split(" ").filter((w) => {
    if (w.length < 5) return true;
    const digits = (w.match(/\d/g) ?? []).length;
    const letters = (w.match(/[A-Z]/g) ?? []).length;
    return !(digits >= 2 && letters >= 2);
  });
  return kept.join(" ");
}

function uniqueTokens(s: string): string {
  const seen = new Set<string>();
  return s
    .split(" ")
    .filter((w) => (seen.has(w) ? false : (seen.add(w), true)))
    .join(" ");
}

export function normalizeMerchant(raw: string): string {
  const original = String(raw ?? "")
    .toUpperCase()
    .replace(/\|/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  let s = original;
  for (const step of STEPS) {
    const next = step.apply(s);
    // No step is ever allowed to empty the string. That is how BLUE DOOR
    // COFFEE became BLUE in the first prototype.
    s = next.trim() ? next : s;
  }
  return s.trim() || original;
}

/** Debug aid: show what each step did. Used by the normalization tests. */
export function traceNormalization(raw: string): { step: string; result: string }[] {
  const trace: { step: string; result: string }[] = [];
  let s = String(raw ?? "").toUpperCase().replace(/\s{2,}/g, " ").trim();
  for (const step of STEPS) {
    const next = step.apply(s);
    s = next.trim() ? next : s;
    trace.push({ step: step.name, result: s });
  }
  return trace;
}
