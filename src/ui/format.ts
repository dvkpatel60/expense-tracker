import { formatCents } from "../core/money.js";
import type { Cents } from "../core/money.js";
import type { ISODate } from "../core/types.js";

export const dollars = (c: Cents): string => formatCents(c, { currency: true });
export const dollarsAbs = (c: Cents): string =>
  formatCents(Math.abs(c) as Cents, { currency: true });

export function monthLabel(period: string): string {
  const d = new Date(period + "-02T00:00:00Z");
  return d.toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function dayLabel(iso: ISODate): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-CA", {
    day: "numeric", month: "short", timeZone: "UTC",
  });
}

export function relativeDays(from: ISODate, to: ISODate): number {
  return Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000
  );
}
