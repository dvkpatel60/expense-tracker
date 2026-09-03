import { titleCase } from "./people.js";

export interface ETransferInfo {
  readonly direction: "in" | "out";
  readonly counterpartyName: string;
  /** False when the FI gave us a direction but no usable name. */
  readonly named: boolean;
}

const IS_ETRANSFER = /e-?tr(an)?sf|e[_\s]transfer|interac\s+e/i;

interface Pattern {
  readonly re: RegExp;
  readonly direction: "in" | "out";
  readonly group: number;
}

/** Ordered: inbound forms are checked before the looser outbound ones so that
 *  "Interac e-Transfer from X" is never read as a send. */
const PATTERNS: readonly Pattern[] = [
  { re: /INTERAC\s+E-?TRANSFERS?\s*(?:-\s*)?(?:RECEIVED|RCVD|FROM)\s*:?\s*(.*)/i, direction: "in", group: 1 },
  { re: /E-?TR(?:AN)?SF(?:ER)?\s+(?:RECEIVED|RCVD|FROM)\s*:?\s*(.*)/i, direction: "in", group: 1 },
  { re: /E[_\s]TRANSFER[_\s]IN\b\s*(.*)/i, direction: "in", group: 1 },
  { re: /INTERAC\s+E-?TRANSFERS?\s*(?:-\s*)?(?:SENT|TO)\s*:?\s*(.*)/i, direction: "out", group: 1 },
  { re: /E-?TR(?:AN)?SF(?:ER)?\s+(?:SENT|TO)\s*:?\s*(.*)/i, direction: "out", group: 1 },
  { re: /E[_\s]TRANSFER[_\s]OUT\b\s*(.*)/i, direction: "out", group: 1 },
];

function cleanName(raw: string): string {
  return raw
    // The description arrives as joined FI fields; the name sits after the
    // separator, so leading separators come off before trailing segments do.
    .replace(/^[\s|:\-]+/, "")
    .replace(/^(INTERAC\s+)?E-?TRANSFER\s+(FROM|TO)\s*:?\s*/i, "")
    .replace(/\|.*$/, "")
    .replace(/\b(REF|REFERENCE|CONF|CONFIRMATION)\s*[#:]?\s*\w+/gi, "")
    .replace(/@\S+/g, " ")
    .replace(/[^A-Za-z'\-\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseETransfer(description: string, amount: number): ETransferInfo | null {
  const s = String(description ?? "");
  if (!IS_ETRANSFER.test(s)) return null;

  for (const p of PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    const name = cleanName(m[p.group] ?? "");
    if (!name) continue;
    return { direction: p.direction, counterpartyName: titleCase(name), named: true };
  }
  // Recognisably an e-transfer but the name did not parse. Fall back to sign
  // rather than dropping the row into the merchant pipeline, where it would be
  // categorized as a business.
  return {
    direction: amount < 0 ? "out" : "in",
    counterpartyName: "Unknown",
    named: false,
  };
}
