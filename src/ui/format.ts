import { formatCents } from "../core/money.js";
import type { Cents } from "../core/money.js";
import type { GroupId } from "../core/categorize.js";
import type { CategoryId, ISODate } from "../core/types.js";

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

/** Every category id is a single word, so the CSS token is just its lowercase.
 *  The scale lives in tokens.css; this is only the bridge to it. */
export function categoryColor(id: CategoryId): string {
  return `var(--cat-${id.toLowerCase()})`;
}

/** Group names carry spaces and an ampersand, so unlike categories they need a
 *  real map rather than a slug rule. */
const GROUP_TOKEN: Readonly<Record<GroupId, string>> = {
  Living: "living",
  "Food & Drink": "food",
  "Getting Around": "around",
  Lifestyle: "lifestyle",
  Money: "money",
  Unsorted: "unsorted",
};

export function groupColor(id: GroupId): string {
  return `var(--grp-${GROUP_TOKEN[id]})`;
}
