import Papa from "papaparse";
import { parseAmount } from "../core/money.js";
import { parseDate } from "../core/dates.js";
import type { DateOrder } from "../core/dates.js";
import type { Cents } from "../core/money.js";
import type { ISODate, RawRow } from "../core/types.js";

export interface Rejection {
  line: number;
  reason: string;
  raw: string;
}

export function parseWithHeader(text: string): { rows: Record<string, string>[]; fields: string[] } {
  const out = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return { rows: out.data, fields: out.meta.fields ?? [] };
}

export function parseHeaderless(text: string): string[][] {
  const out = Papa.parse<string[]>(text.trim(), { header: false, skipEmptyLines: true });
  return out.data;
}

/** Case- and whitespace-insensitive column lookup. FIs change header casing
 *  between exports more often than they change the columns. */
export function pick(row: Record<string, string>, ...names: string[]): string {
  const keys = Object.keys(row);
  for (const name of names) {
    const hit = keys.find((k) => k.trim().toLowerCase() === name.toLowerCase());
    if (hit !== undefined) return (row[hit] ?? "").trim();
  }
  return "";
}

export function findColumn(fields: readonly string[], ...fragments: string[]): string | null {
  for (const fragment of fragments) {
    const hit = fields.find((f) => f.trim().toLowerCase().includes(fragment));
    if (hit) return hit;
  }
  return null;
}

export interface RowDraft {
  date: unknown;
  amount: Cents | null;
  descriptionParts: (string | undefined)[];
  currency?: "CAD" | "USD";
  typeHint?: string;
  accountHint?: string;
  chequeNumber?: string;
  originalAmount?: { amount: Cents; currency: string };
}

/** Turn a draft into a RawRow or an explanation of why it could not be one.
 *  Nothing is dropped silently; the importer surfaces the rejections. */
export function buildRow(
  draft: RowDraft,
  line: number,
  order: DateOrder,
  rejected: Rejection[],
  raw: string
): RawRow | null {
  const date: ISODate | null = parseDate(draft.date, order);
  if (!date) {
    rejected.push({ line, reason: `Unreadable date: ${String(draft.date)}`, raw });
    return null;
  }
  if (draft.amount === null) {
    rejected.push({ line, reason: "No amount on this row", raw });
    return null;
  }
  const parts = draft.descriptionParts.filter((p): p is string => Boolean(p && p.trim()));
  return {
    date,
    amount: draft.amount,
    currency: draft.currency ?? "CAD",
    descriptionParts: parts,
    ...(draft.typeHint ? { typeHint: draft.typeHint } : {}),
    ...(draft.accountHint ? { accountHint: draft.accountHint } : {}),
    ...(draft.chequeNumber ? { chequeNumber: draft.chequeNumber } : {}),
    ...(draft.originalAmount ? { originalAmount: draft.originalAmount } : {}),
  };
}

export { parseAmount };
