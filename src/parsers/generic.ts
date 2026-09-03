import { parseAmount, parseWithHeader, findColumn, buildRow } from "./util.js";
import type { Rejection } from "./util.js";
import { inferDateOrder } from "../core/dates.js";
import type { Parser, ParseResult, RawRow } from "../core/types.js";

/** Last resort: sniff the columns. Always scores low so a real parser wins. */
export const genericParser: Parser = {
  id: "generic",
  label: "Generic CSV",
  hint: "Any CSV with a date column and an amount (or debit/credit) column.",

  detect(text) {
    const head = text.slice(0, 400).toLowerCase();
    const hasDate = head.includes("date");
    const hasAmount = head.includes("amount") || head.includes("debit") || head.includes("credit");
    return hasDate && hasAmount ? 0.2 : 0.05;
  },

  parse(text): ParseResult {
    const { rows, fields } = parseWithHeader(text);
    const rejected: Rejection[] = [];
    const out: RawRow[] = [];

    const dateCol = findColumn(fields, "date");
    const amountCol = findColumn(fields, "amount", "cad", "value");
    const debitCol = findColumn(fields, "debit", "withdrawal");
    const creditCol = findColumn(fields, "credit", "deposit");
    const descCol = findColumn(fields, "desc", "merchant", "narrative", "detail", "payee");
    const balanceCol = findColumn(fields, "balance");

    if (!dateCol) {
      return {
        fi: "generic",
        rows: [],
        rejected: [{ line: 1, reason: "No column looks like a date", raw: fields.join(",") }],
      };
    }

    const order = inferDateOrder(rows.map((r) => String(r[dateCol] ?? "")));
    const resolved = order === "ambiguous" ? "mdy" : order;

    rows.forEach((r, i) => {
      let amount = amountCol ? parseAmount(r[amountCol]) : null;
      if (amount === null && debitCol) {
        const d = parseAmount(r[debitCol]);
        const c = creditCol ? parseAmount(r[creditCol]) : null;
        amount = d !== null && d !== 0 ? ((-Math.abs(d)) as typeof d) : c !== null ? ((Math.abs(c)) as typeof c) : null;
      }
      const row = buildRow(
        {
          date: r[dateCol],
          amount,
          descriptionParts: [descCol ? r[descCol] : ""],
          balance: balanceCol ? parseAmount(r[balanceCol]) : null,
        },
        i + 2,
        resolved,
        rejected,
        JSON.stringify(r)
      );
      if (row) out.push(row);
    });

    return { fi: "generic", rows: out, rejected };
  },
};
