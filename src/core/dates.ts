import type { ISODate } from "./types.js";

/**
 * Canadian statements use M/D/YYYY, D/M/YYYY and YYYY-MM-DD depending on the FI
 * and the user's locale setting at export time. Ambiguity between the first two
 * is unresolvable per row, so the parser declares which it expects and this
 * module never guesses silently.
 */
export type DateOrder = "mdy" | "dmy" | "iso";

const pad = (n: string): string => n.padStart(2, "0");

export function parseDate(raw: unknown, order: DateOrder = "mdy"): ISODate | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`;
  if (order === "iso") return null;

  const slash = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (slash) {
    const [, a, b, y] = slash;
    const year = y!.length === 2 ? `20${y}` : y!;
    const [month, day] = order === "mdy" ? [a!, b!] : [b!, a!];
    if (Number(month) > 12 || Number(day) > 31 || Number(month) < 1 || Number(day) < 1) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  // "03 Aug 2026" and similar long forms.
  const parsed = Date.parse(s + " UTC");
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

/**
 * True when a batch of date strings contains a day above 12, which proves the
 * order. Lets the importer warn instead of silently transposing a whole month.
 */
export function inferDateOrder(samples: readonly string[]): DateOrder | "ambiguous" {
  let mdy = false;
  let dmy = false;
  for (const s of samples) {
    const m = s.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{2,4}/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) mdy = true;
  }
  if (mdy && !dmy) return "mdy";
  if (dmy && !mdy) return "dmy";
  return "ambiguous";
}

export const daysBetween = (a: ISODate, b: ISODate): number =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
