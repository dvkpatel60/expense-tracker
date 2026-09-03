import { categoryTotals, periodTotals, spendIn } from "./ledger.js";
import type { LedgerState, PeriodTotals } from "./ledger.js";
import { effectiveAmount } from "./split.js";
import { cents } from "./money.js";
import type { Cents } from "./money.js";
import type { CategoryId } from "./types.js";

/**
 * The aggregates-only view of a ledger that AI analysis is allowed to see.
 *
 * This is the second thing permitted to cross the network (the first being
 * normalized merchant strings for identification), and the shape enforces the
 * limit structurally: there is nowhere in it to put an individual transaction,
 * a day-level date, a balance, an account, or a person. A category is a total,
 * a merchant is a total, and that is all the model gets.
 */
export interface CategoryDigest {
  readonly categoryId: CategoryId;
  readonly yourShare: Cents;
  readonly cashOut: Cents;
  readonly transactionCount: number;
  /** Your share in the previous period; 0 when there was none. */
  readonly previousYourShare: Cents;
}

export interface MerchantDigest {
  /** The normalized merchant key — the same string enrichment already sends. */
  readonly merchant: string;
  readonly yourShare: Cents;
  readonly transactionCount: number;
}

export interface InsightsDigest {
  /** "YYYY-MM", or null for all time. The only date the model sees. */
  readonly period: string | null;
  readonly totals: PeriodTotals;
  /** Null for all-time, where "previous period" has no meaning. */
  readonly previousTotals: PeriodTotals | null;
  readonly categories: readonly CategoryDigest[];
  readonly topMerchants: readonly MerchantDigest[];
  /** Aggregate only — how much is owed to you across how many claims, no names. */
  readonly openClaims: { readonly count: number; readonly total: Cents };
}

/** Server-side cap on the merchant list, mirroring MAX_MERCHANTS_PER_REQUEST. */
export const MAX_DIGEST_MERCHANTS = 15;

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const prev = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1));
  return prev.toISOString().slice(0, 7);
}

export function buildInsightsDigest(state: LedgerState, period: string | null): InsightsDigest {
  const prior = period === null ? null : previousPeriod(period);
  const priorCategories = prior === null ? [] : categoryTotals(state, prior);
  const priorShare = new Map(priorCategories.map((c) => [c.categoryId, c.yourShare]));

  const merchants = new Map<string, { share: number; n: number }>();
  for (const t of spendIn(state, period)) {
    // A counterparty key must never reach a model. E-transfers recategorized as
    // real spend still count in the category totals above; they are simply
    // invisible in the merchant list.
    if (t.merchantKey.startsWith("etransfer:")) continue;
    const b = merchants.get(t.merchantKey) ?? { share: 0, n: 0 };
    b.share += -effectiveAmount(t, state.claims);
    b.n++;
    merchants.set(t.merchantKey, b);
  }
  const topMerchants = [...merchants.entries()]
    .map(([merchant, b]) => ({ merchant, yourShare: cents(b.share), transactionCount: b.n }))
    .sort((a, b) => b.yourShare - a.yourShare)
    .slice(0, MAX_DIGEST_MERCHANTS);

  const open = state.claims.filter((c) => c.status === "open");

  return {
    period,
    totals: periodTotals(state, period),
    previousTotals: prior === null ? null : periodTotals(state, prior),
    categories: categoryTotals(state, period).map((c) => ({
      categoryId: c.categoryId,
      yourShare: c.yourShare,
      cashOut: c.cashOut,
      transactionCount: c.transactionCount,
      previousYourShare: priorShare.get(c.categoryId) ?? cents(0),
    })),
    topMerchants,
    openClaims: {
      count: open.length,
      total: cents(open.reduce((acc, c) => acc + c.amount, 0)),
    },
  };
}
