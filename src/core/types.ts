import type { Cents } from "./money.js";

/** YYYY-MM-DD, always. Never a Date object in the domain — timezones ruin ledgers. */
export type ISODate = string;

export type FiId = "rbc" | "scotiabank" | "wealthsimple" | "generic";
export type Currency = "CAD" | "USD";

export type AccountId = string;
export type PersonId = string;
export type TransactionId = string;
export type ClaimId = string;
export type SettlementId = string;
export type CategoryId = string;

/* ------------------------------------------------------------------ */
/* Parser boundary                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a parser produces. Deliberately dumb: no category, no merchant, no
 * person. Parsers know CSV shapes and nothing about the domain, which is why
 * adding an FI is one file plus one fixture.
 */
export interface RawRow {
  readonly date: ISODate;
  readonly amount: Cents;
  readonly currency: Currency;
  /** FI-specific description fields, in source order. RBC gives two. */
  readonly descriptionParts: readonly string[];
  /** Machine transaction type where the FI provides one (Wealthsimple does). */
  readonly typeHint?: string;
  readonly accountHint?: string;
  readonly chequeNumber?: string;
  /** Running account balance after this row, where the export states one.
   *  Optional because plenty of exports (card statements especially) do not. */
  readonly balance?: Cents;
  /** Set when the row settled in a currency other than the posted one. */
  readonly originalAmount?: { amount: Cents; currency: string };
}

export interface ParseResult {
  readonly fi: FiId;
  readonly rows: readonly RawRow[];
  /** Rows the parser saw but could not turn into a RawRow, with a reason. */
  readonly rejected: readonly { line: number; reason: string; raw: string }[];
}

export interface Parser {
  readonly id: FiId;
  readonly label: string;
  /** What this parser recognizes, in the reader's terms — shown on the import
   *  screen so a bare dropzone is not the only instruction. It lives beside
   *  detect() precisely so the two cannot drift apart. */
  readonly hint: string;
  /** 0 means "not mine". Highest score wins detection. */
  detect(text: string): number;
  parse(text: string): ParseResult;
}

/* ------------------------------------------------------------------ */
/* Domain                                                              */
/* ------------------------------------------------------------------ */

export type TransactionKind =
  | "purchase"
  | "credit"
  | "etransfer_in"
  | "etransfer_out"
  | "internal_transfer";

export type Provenance = "default" | "rule" | "enriched" | "user";

/** Chequing, savings and cash are assets; credit is a liability, and its
 *  balance counts against net worth rather than towards it. */
export type AccountKind = "chequing" | "savings" | "credit" | "cash";

export interface Account {
  readonly id: AccountId;
  readonly label: string;
  readonly fi: FiId;
  readonly kind: AccountKind;
  /** Where the statement's balance column starts, when it has none. */
  readonly openingBalance?: Cents;
  /** Credit accounts only; enables a utilisation figure. */
  readonly creditLimit?: Cents;
}

export interface Person {
  readonly id: PersonId;
  readonly displayName: string;
  /** Every spelling seen on a statement. Aliasing is a guess, so it is visible. */
  readonly aliases: readonly string[];
}

export interface Transaction {
  readonly id: TransactionId;
  /** Stable fingerprint. Re-importing an overlapping range is a no-op. */
  readonly importHash: string;
  readonly accountId: AccountId;
  readonly fi: FiId;
  readonly date: ISODate;
  /** Negative is money leaving the account. */
  readonly amount: Cents;
  readonly currency: Currency;
  readonly rawDescription: string;
  readonly merchantKey: string;
  readonly merchantName: string;
  readonly merchantNote?: string;
  readonly merchantSource: Provenance;
  readonly commonlyShared?: boolean;
  readonly categoryId: CategoryId;
  readonly categorySource: Provenance;
  readonly kind: TransactionKind;
  readonly personId?: PersonId;
  readonly transferPairId?: string;
  /** Balance the statement reported after this row. Carried, never computed —
   *  it is evidence from the bank, which is what makes it worth checking
   *  against (see core/anomalies.ts). */
  readonly balanceAfter?: Cents;
  readonly originalAmount?: { amount: Cents; currency: string };
}

export type ClaimDirection = "they_owe_me" | "i_owe_them";
export type ClaimStatus = "open" | "settled" | "void";

export interface Claim {
  readonly id: ClaimId;
  readonly transactionId: TransactionId;
  readonly personId: PersonId;
  readonly amount: Cents;
  readonly direction: ClaimDirection;
  readonly status: ClaimStatus;
  readonly createdOn: ISODate;
  readonly settlementId?: SettlementId;
  readonly memo?: string;
}

export interface Settlement {
  readonly id: SettlementId;
  /** The e-transfer that closed the claims. */
  readonly transactionId: TransactionId;
  readonly personId: PersonId;
  readonly amount: Cents;
  readonly claimIds: readonly ClaimId[];
  readonly on: ISODate;
  /** Left over when the transfer didn't equal the net position. */
  readonly residual: Cents;
}

/* ------------------------------------------------------------------ */
/* Splitting                                                           */
/* ------------------------------------------------------------------ */

export type SplitSpec =
  | { readonly kind: "even"; readonly participants: readonly PersonId[]; readonly includeMe: boolean }
  | {
      readonly kind: "percent";
      readonly shares: readonly { personId: PersonId; percent: number }[];
      readonly myPercent: number;
    }
  | {
      readonly kind: "amounts";
      readonly shares: readonly { personId: PersonId; amount: Cents }[];
    }
  | {
      readonly kind: "itemized";
      readonly items: readonly {
        label: string;
        amount: Cents;
        participants: readonly PersonId[];
        includeMe: boolean;
      }[];
    };

export interface SplitResult {
  readonly claims: readonly Omit<Claim, "id" | "status" | "createdOn">[];
  readonly myShare: Cents;
}

/* ------------------------------------------------------------------ */
/* Categorization                                                      */
/* ------------------------------------------------------------------ */

export interface CategoryRule {
  readonly id: string;
  /** Serialized so rules are data the user can edit, not code. */
  readonly pattern: string;
  readonly flags?: string;
  readonly categoryId: CategoryId;
  readonly source: "builtin" | "user";
  /** Higher wins. User rules default above builtins. */
  readonly priority: number;
}

export interface MerchantFacts {
  readonly key: string;
  readonly name: string;
  readonly note?: string;
  readonly categoryId?: CategoryId;
  readonly commonlyShared?: boolean;
  readonly retrievedOn: ISODate;
}
