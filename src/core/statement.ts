import { isAsset, towardsNetWorth } from "./accounts.js";
import { previousPeriod } from "./digest.js";
import type { LedgerState } from "./ledger.js";
import { cents, sum } from "./money.js";
import type { Cents } from "./money.js";
import type { Account, ISODate, Transaction } from "./types.js";

/**
 * Monthly statements and a balance sheet.
 *
 * Distinct from the spend report in ledger.ts on purpose. That one answers
 * "what did this cost me", excluding internal transfers and other people's
 * share. This one answers "what moved through the account and what is left",
 * so it counts every row including transfers — a card payment genuinely is
 * money leaving chequing, even though it is not spending.
 *
 * Balances are evidence from the statement, never computed from the rows: if
 * the two disagree the file is telling us something (see core/anomalies.ts),
 * and a computed balance would hide exactly that.
 */

export interface AccountStatement {
  readonly account: Account;
  readonly opening: Cents;
  readonly inflows: Cents;
  readonly outflows: Cents;
  readonly closing: Cents;
  readonly transactionCount: number;
  /** False when the export carried no balance column, so opening and closing
   *  are derived from flows rather than reported. Shown, not hidden. */
  readonly balanceReported: boolean;
}

export interface BalanceSheet {
  readonly period: string | null;
  readonly accounts: readonly AccountStatement[];
  readonly assets: Cents;
  readonly liabilities: Cents;
  readonly netWorth: Cents;
  readonly inflows: Cents;
  readonly outflows: Cents;
  /** Change in net worth against the previous period, null when there is none. */
  readonly netWorthDelta: Cents | null;
}

const inPeriod = (t: Transaction, period: string | null): boolean =>
  period === null || t.date.startsWith(period);

/** Statement order, not import order: same day ties break on the id, which the
 *  clock issues in file order, so a day's rows stay in the order they posted. */
function ordered(rows: readonly Transaction[]): Transaction[] {
  return [...rows].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
}

export function accountStatement(
  state: LedgerState,
  account: Account,
  period: string | null
): AccountStatement {
  const rows = ordered(
    state.transactions.filter((t) => t.accountId === account.id && inPeriod(t, period))
  );

  const inflows = cents(sum(rows.filter((t) => t.amount > 0).map((t) => t.amount)));
  const outflows = cents(sum(rows.filter((t) => t.amount < 0).map((t) => t.amount)));

  const last = [...rows].reverse().find((t) => t.balanceAfter !== undefined);
  const first = rows.find((t) => t.balanceAfter !== undefined);

  if (last?.balanceAfter !== undefined && first?.balanceAfter !== undefined) {
    // Opening is the balance before the first row that reported one, which is
    // that row's balance minus its own amount.
    const opening = cents(first.balanceAfter - first.amount);
    return {
      account,
      opening,
      inflows,
      outflows,
      closing: last.balanceAfter,
      transactionCount: rows.length,
      balanceReported: true,
    };
  }

  // No balance column: fall back to the account's declared opening and the
  // flows, and say so rather than presenting a guess as a bank figure.
  const opening = account.openingBalance ?? cents(0);
  return {
    account,
    opening,
    inflows,
    outflows,
    closing: cents(opening + inflows + outflows),
    transactionCount: rows.length,
    balanceReported: false,
  };
}

export function balanceSheet(state: LedgerState, period: string | null): BalanceSheet {
  const accounts = state.accounts.map((a) => accountStatement(state, a, period));

  const assets = cents(
    sum(accounts.filter((s) => isAsset(s.account.kind)).map((s) => s.closing))
  );
  // Liabilities are reported as a positive amount owed, whichever sign the
  // card export used.
  const liabilities = cents(
    sum(accounts.filter((s) => !isAsset(s.account.kind)).map((s) => cents(Math.abs(s.closing))))
  );

  const netWorth = cents(
    sum(accounts.map((s) => towardsNetWorth(s.account.kind, s.closing)))
  );

  return {
    period,
    accounts,
    assets,
    liabilities,
    netWorth,
    inflows: cents(sum(accounts.map((s) => s.inflows))),
    outflows: cents(sum(accounts.map((s) => s.outflows))),
    netWorthDelta:
      period === null ? null : cents(netWorth - priorNetWorth(state, previousPeriod(period))),
  };
}

function priorNetWorth(state: LedgerState, period: string): Cents {
  return cents(
    sum(
      state.accounts.map((a) => towardsNetWorth(a.kind, accountStatement(state, a, period).closing))
    )
  );
}

/** The period labels a ledger actually covers, newest first. */
export function periodsIn(state: LedgerState): string[] {
  return [...new Set(state.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

/** The last date any account reported, for "as of" labelling. */
export function asOf(state: LedgerState, period: string | null): ISODate | null {
  const dates = state.transactions.filter((t) => inPeriod(t, period)).map((t) => t.date).sort();
  return dates[dates.length - 1] ?? null;
}
