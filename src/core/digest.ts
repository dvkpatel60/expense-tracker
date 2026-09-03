import { categoryTotals, periodTotals, spendIn } from "./ledger.js";
import type { LedgerState, PeriodTotals } from "./ledger.js";
import { effectiveAmount } from "./split.js";
import { cents } from "./money.js";
import type { Cents } from "./money.js";
import { detectRecurring } from "./recurring.js";
import type { RecurringPattern } from "./recurring.js";
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

/** A merchant flagged as recurring. Merchant name only — the expected date is
 *  deliberately not included, so no day-level date is added. The cadence is
 *  enough for the model to talk about subscriptions. */
export interface RecurringCandidateDigest {
  readonly merchant: string;
  readonly avgAmount: Cents;
  readonly frequency: RecurringPattern["frequency"];
  readonly regularity: number;
}

/** A category where your share exceeds what you ought to carry. When you are
 *  paying more than your fair share of a category, that money is recoverable
 *  from other people — a concrete, actionable signal. */
export interface SavingsOpportunityDigest {
  readonly categoryId: CategoryId;
  readonly yourShare: Cents;
  readonly cashOut: Cents;
  /** yourShare minus cashOut: positive when friends carry some of it. */
  readonly potentialSavings: Cents;
}

/** A merchant whose share moved most between the prior period and this one. */
export interface MerchantDeltaDigest {
  readonly merchant: string;
  readonly currentShare: Cents;
  readonly previousShare: Cents;
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
  /** Merchants on a steady cadence, with cadence and average amount. */
  readonly recurringCandidates: readonly RecurringCandidateDigest[];
  /** Categories where you are paying more than your fair share. */
  readonly savingsOpportunity: readonly SavingsOpportunityDigest[];
  /** The merchants whose share changed most, current vs previous period. */
  readonly topMerchantDelta: readonly MerchantDeltaDigest[];
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

  // Recurring, savings and merchant-delta signals share the digest's privacy
  // discipline: merchant keys (already sent for enrichment) and category ids
  // only, never a person, account, date or balance.
  const recurring = detectRecurring(state, period)
    .filter((r) => !r.merchantKey.startsWith("etransfer:"))
    .map((r) => ({
      merchant: r.merchantKey,
      avgAmount: r.avgAmount,
      frequency: r.frequency,
      regularity: r.regularity,
    }))
    .slice(0, MAX_DIGEST_MERCHANTS);

  // A category is a savings opportunity when your share exceeds what you would
  // carry alone — i.e. other people's share (cashOut − yourShare) is material.
  // This is the "you're footing the bill for the group" signal the model can
  // turn into an action without inventing guilt.
  const savingsOpportunity = categoryTotals(state, period)
    .filter((c) => c.yourShare > c.cashOut && c.yourShare > 0)
    .map((c) => ({
      categoryId: c.categoryId,
      yourShare: c.yourShare,
      cashOut: c.cashOut,
      potentialSavings: cents(c.yourShare - c.cashOut),
    }))
    .sort((a, b) => b.potentialSavings - a.potentialSavings)
    .slice(0, 5);

  // The merchants that moved most between periods. Absent prior period, empty.
  const topMerchantDelta = prior === null ? [] : buildMerchantDelta(merchants, state, period, prior);

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
    recurringCandidates: recurring,
    savingsOpportunity,
    topMerchantDelta,
  };
}

/** Percentage shift between a merchant's prior and current share, used to rank
 *  the biggest movers. Bound at 0 (appearing) and scaled so a 10x jump doesn't
 *  drown out gentler changes. */
function merchantGrowth(current: Cents, previous: Cents): number {
  if (previous === 0) return current === 0 ? 0 : 1;
  return Math.max(0, (current - previous) / Math.abs(previous));
}

function buildMerchantDelta(
  currentByKey: Map<string, { share: number; n: number }>,
  state: LedgerState,
  period: string | null,
  prior: string
): { merchant: string; currentShare: Cents; previousShare: Cents }[] {
  const priorByKey = new Map<string, number>();
  for (const t of spendIn(state, prior)) {
    if (t.merchantKey.startsWith("etransfer:")) continue;
    priorByKey.set(t.merchantKey, (priorByKey.get(t.merchantKey) ?? 0) + -effectiveAmount(t, state.claims));
  }

  const keys = new Set([...currentByKey.keys(), ...priorByKey.keys()]);
  return [...keys]
    .map((key) => {
      const current = cents(currentByKey.get(key)?.share ?? 0);
      const previous = cents(priorByKey.get(key) ?? 0);
      return {
        merchant: key,
        currentShare: current,
        previousShare: previous,
        growth: merchantGrowth(current, previous),
      };
    })
    .sort((a, b) => b.growth - a.growth)
    .slice(0, 5)
    .map(({ merchant, currentShare, previousShare }) => ({ merchant, currentShare, previousShare }));
}
