import { parseAmount, parseWithHeader, pick, buildRow } from "./util.js";
import type { Rejection } from "./util.js";
import type { Parser, ParseResult, RawRow } from "../core/types.js";

/**
 * Wealthsimple Cash CSV. The one FI here that gives a machine-readable
 * transaction type, which is worth more than any amount of description
 * pattern matching: E_TRANSFER_IN is unambiguous where "INTERAC E-TRF" is not.
 * The type is carried through as typeHint rather than being folded into the
 * description, so the domain can trust it.
 */
export const wealthsimpleParser: Parser = {
  id: "wealthsimple",
  label: "Wealthsimple",

  detect(text) {
    const head = text.slice(0, 800).toLowerCase();
    // transaction_type is the only column unique to Wealthsimple. A balance
    // column is common to most bank exports, so scoring on it alone was enough
    // to beat the generic parser on a file this one cannot read — and claiming
    // a file then rejecting every row of it is worse than never claiming it.
    if (!head.includes("transaction_type")) return 0;
    let score = 0.6;
    if (head.includes("balance")) score += 0.2;
    if (/e_transfer|aft_in|aft_out/.test(head)) score += 0.3;
    return Math.min(score, 1);
  },

  parse(text): ParseResult {
    const { rows } = parseWithHeader(text);
    const rejected: Rejection[] = [];
    const out: RawRow[] = [];

    rows.forEach((r, i) => {
      const type = pick(r, "transaction_type", "type");
      const row = buildRow(
        {
          date: pick(r, "date", "posted_date", "created_at"),
          amount: parseAmount(pick(r, "amount", "value")),
          descriptionParts: [pick(r, "description", "notes", "memo")],
          ...(type ? { typeHint: type } : {}),
          accountHint: "Cash",
        },
        i + 2,
        "iso",
        rejected,
        JSON.stringify(r)
      );
      if (row) out.push(row);
    });

    return { fi: "wealthsimple", rows: out, rejected };
  },
};
