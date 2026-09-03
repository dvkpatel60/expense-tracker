import { parseAmount, parseHeaderless, parseWithHeader, pick, buildRow } from "./util.js";
import type { Rejection } from "./util.js";
import { inferDateOrder } from "../core/dates.js";
import type { Parser, ParseResult, RawRow } from "../core/types.js";

/**
 * Scotiabank exports headerless CSV in the shape: date, amount, blank,
 * description. The chequing and credit card views differ slightly and some
 * exports do carry a header, so both are handled.
 *
 * The date order is the real hazard. Scotia emits M/D/YYYY or D/M/YYYY
 * depending on the profile locale, and a transposed month is invisible until
 * the report is wrong. So the order is inferred from any day above 12 in the
 * file, and left as the declared default only when the file cannot prove it.
 */
export const scotiabankParser: Parser = {
  id: "scotiabank",
  label: "Scotiabank",
  hint: "Headerless rows starting with a M/D/Y date, or any export naming Scotiabank.",

  detect(text) {
    const first = text.trim().split(/\r?\n/)[0] ?? "";
    if (/^"?\d{1,2}\/\d{1,2}\/\d{2,4}"?\s*,/.test(first)) return 0.85;
    const head = text.slice(0, 400).toLowerCase();
    if (head.includes("scotia")) return 0.5;
    return 0;
  },

  parse(text): ParseResult {
    const rejected: Rejection[] = [];
    const out: RawRow[] = [];
    const first = text.trim().split(/\r?\n/)[0] ?? "";
    const headerless = /^"?\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(first);

    if (headerless) {
      const rows = parseHeaderless(text);
      const order = inferDateOrder(rows.map((r) => r[0] ?? ""));
      const resolved = order === "ambiguous" ? "mdy" : order;
      if (order === "ambiguous") {
        rejected.push({
          line: 0,
          reason: "No day above 12 in this file, so the date order could not be proven. Read as M/D/Y.",
          raw: first,
        });
      }
      rows.forEach((r, i) => {
        const row = buildRow(
          {
            date: r[0],
            amount: parseAmount(r[1]),
            descriptionParts: [r[3] ?? r[2]],
          },
          i + 1,
          resolved,
          rejected,
          r.join(",")
        );
        if (row) out.push(row);
      });
    } else {
      const { rows } = parseWithHeader(text);
      const order = inferDateOrder(rows.map((r) => pick(r, "Date", "Transaction Date")));
      const resolved = order === "ambiguous" ? "mdy" : order;
      rows.forEach((r, i) => {
        const withdrawal = parseAmount(pick(r, "Withdrawals", "Debit"));
        const deposit = parseAmount(pick(r, "Deposits", "Credit"));
        const plain = parseAmount(pick(r, "Amount"));
        const amount =
          plain ??
          (withdrawal !== null
            ? ((-Math.abs(withdrawal)) as typeof withdrawal)
            : deposit !== null
              ? ((Math.abs(deposit)) as typeof deposit)
              : null);
        const row = buildRow(
          {
            date: pick(r, "Date", "Transaction Date"),
            amount,
            descriptionParts: [pick(r, "Description", "Details", "Transaction")],
          },
          i + 2,
          resolved,
          rejected,
          JSON.stringify(r)
        );
        if (row) out.push(row);
      });
    }

    return { fi: "scotiabank", rows: out, rejected };
  },
};
