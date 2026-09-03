import { cents } from "./money.js";
import type { Cents } from "./money.js";
import type { LedgerState } from "./ledger.js";
import type { Transaction } from "./types.js";

export type RecurringFrequency = "monthly" | "weekly";

export interface RecurringPattern {
  readonly merchantKey: string;
  readonly merchantName: string;
  readonly avgAmount: Cents;
  readonly frequency: RecurringFrequency;
  /** The calendar date the next one is expected on, per the observed cadence. */
  readonly nextExpected: string;
  /** How regular the interval actually is — 1 is perfectly regular. */
  readonly regularity: number;
  readonly lastDate: string;
}

/** A recurring expense is a merchant that shows up on a steady cadence. Pure
 *  computation off the ledger's own history — no AI, no network. Subscriptions,
 *  rent, insurance and the like fall out of this shape, and it is what makes a
 *  ledger feel like it is paying attention rather than just storing. */
export function detectRecurring(
  state: LedgerState,
  period: string | null
): RecurringPattern[] {
  const inPeriod = state.transactions.filter(
    (t) => t.amount < 0 && (period === null || t.date.startsWith(period))
  );

  const buckets = new Map<string, Transaction[]>();
  for (const t of inPeriod) {
    const list = buckets.get(t.merchantKey) ?? [];
    list.push(t);
    buckets.set(t.merchantKey, list);
  }

  const out: RecurringPattern[] = [];
  for (const [merchantKey, txs] of buckets) {
    if (txs.length < 3) continue;

    const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : 1));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(dayDiff(sorted[i - 1]!.date, sorted[i]!.date));
    }
    const freq = classifyFrequency(intervals);
    if (!freq) continue;

    const { avg, median } = summarize(intervals);
    const avgAmount = cents(
      Math.round(-sorted.reduce((n, t) => n + t.amount, 0) / sorted.length)
    );

    out.push({
      merchantKey,
      merchantName: sorted[0]!.merchantName,
      avgAmount,
      frequency: freq.kind,
      nextExpected: addDays(sorted[sorted.length - 1]!.date, Math.round(median)),
      regularity: varianceScore(avg, intervals),
      lastDate: sorted[sorted.length - 1]!.date,
    });
  }

  return out.sort((a, b) => b.avgAmount - a.avgAmount);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

function addDays(date: string, days: number): string {
  const d = new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Decide whether a sequence of intervals looks monthly or weekly. Monthly is
 *  a 28–35 day gap; weekly is 6–8. Anything that doesn't cluster returns null. */
function classifyFrequency(
  intervals: readonly number[]
): { kind: RecurringFrequency; avg: number } | null {
  const avg = intervals.reduce((n, x) => n + x, 0) / intervals.length;
  if (avg >= 28 && avg <= 35) return { kind: "monthly", avg };
  if (avg >= 6 && avg <= 8) return { kind: "weekly", avg };
  return null;
}

function summarize(intervals: readonly number[]): { avg: number; median: number } {
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    avg: intervals.reduce((n, x) => n + x, 0) / intervals.length,
    median,
  };
}

/** 0..1 — how much the real intervals deviate from the cadence's average. A
 *  larger value means more irregular (a 14-day min and a 42-day max is still
 *  monthly, but less predictable). */
function varianceScore(avg: number, intervals: readonly number[]): number {
  const maxDev = intervals.reduce((m, x) => Math.max(m, Math.abs(x - avg)), 0);
  // Normalize against the cadence itself so monthly and weekly are comparable.
  return clamp01(1 - maxDev / Math.max(avg, 1));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
