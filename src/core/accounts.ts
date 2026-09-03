import { cents } from "./money.js";
import type { Cents } from "./money.js";
import type { Account, AccountKind, FiId } from "./types.js";

/**
 * What kind of account this is, and what that does to the arithmetic.
 *
 * The distinction is not cosmetic. A chequing balance of $2,000 and a credit
 * balance of $2,000 are opposite facts about your position, so every rollup
 * has to know which it is holding. Nothing else in the domain may assume a
 * balance is an asset.
 */

export const ACCOUNT_KINDS: readonly AccountKind[] = ["chequing", "savings", "credit", "cash"];

export const ACCOUNT_KIND_LABEL: Readonly<Record<AccountKind, string>> = {
  chequing: "Chequing",
  savings: "Savings",
  credit: "Credit card",
  cash: "Cash",
};

/** Credit is the only liability; everything else is money you have. */
export function isAsset(kind: AccountKind): boolean {
  return kind !== "credit";
}

/**
 * A statement balance as it counts towards net worth.
 *
 * Card exports disagree about sign: some post the amount owed as a positive
 * number, some as a negative. Both mean the same thing, so the magnitude is
 * taken and the sign applied here, once, rather than trusted from the file.
 */
export function towardsNetWorth(kind: AccountKind, balance: Cents): Cents {
  return isAsset(kind) ? balance : (cents(-Math.abs(balance)) as Cents);
}

/**
 * A guess at the kind from what the import knows. Deliberately a guess the UI
 * shows rather than a decision it hides: getting this wrong inverts a figure,
 * so the Import view offers it as an editable default.
 */
export function inferAccountKind(label: string, fi: FiId): AccountKind {
  const l = label.toLowerCase();
  if (/visa|mastercard|amex|credit|\bcard\b/.test(l)) return "credit";
  if (/saving|tfsa|rrsp|hisa/.test(l)) return "savings";
  if (/cash\b/.test(l)) return fi === "wealthsimple" ? "chequing" : "cash";
  if (/chequing|checking|current/.test(l)) return "chequing";
  return "chequing";
}

/** Utilisation as a fraction, or null when the limit is unknown. Reported
 *  rather than computed inline so the "no limit set" case stays explicit. */
export function utilisation(account: Account, balance: Cents): number | null {
  if (account.kind !== "credit" || !account.creditLimit || account.creditLimit === 0) return null;
  return Math.abs(balance) / Math.abs(account.creditLimit);
}
