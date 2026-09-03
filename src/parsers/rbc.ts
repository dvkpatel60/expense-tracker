import { parseAmount, parseWithHeader, pick, buildRow } from "./util.js";
import type { Rejection } from "./util.js";
import type { Parser, ParseResult, RawRow } from "../core/types.js";

/**
 * RBC online banking CSV.
 *
 * Two quirks that matter. It splits the description across "Description 1" and
 * "Description 2" — the merchant is usually in the second, with the POS wrapper
 * in the first. And it has separate CAD$ and USD$ columns: a US transaction
 * posts in USD$ with CAD$ empty, so dropping the USD column loses the row
 * entirely rather than just losing the FX detail.
 */
export const rbcParser: Parser = {
  id: "rbc",
  label: "RBC",
  hint: 'An "Account Type" and "Description 1" header, amounts in CAD$.',

  detect(text) {
    const head = text.slice(0, 800).toLowerCase();
    let score = 0;
    if (head.includes("account type")) score += 0.4;
    if (head.includes("description 1")) score += 0.4;
    if (head.includes("cad$")) score += 0.2;
    return score;
  },

  parse(text): ParseResult {
    const { rows } = parseWithHeader(text);
    const rejected: Rejection[] = [];
    const out: RawRow[] = [];

    rows.forEach((r, i) => {
      const cad = parseAmount(pick(r, "CAD$", "CAD", "Amount"));
      const usd = parseAmount(pick(r, "USD$", "USD"));
      const amount = cad ?? usd;
      const row = buildRow(
        {
          date: pick(r, "Transaction Date", "Date"),
          amount,
          currency: cad !== null ? "CAD" : "USD",
          descriptionParts: [pick(r, "Description 1"), pick(r, "Description 2")],
          accountHint: pick(r, "Account Type"),
          chequeNumber: pick(r, "Cheque Number"),
        },
        i + 2,
        "mdy",
        rejected,
        JSON.stringify(r)
      );
      if (row) out.push(row);
    });

    return { fi: "rbc", rows: out, rejected };
  },
};
