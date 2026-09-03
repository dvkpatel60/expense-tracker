import { abs, cents, sum, ZERO } from "./money.js";
import type { Cents } from "./money.js";
import { BUILTIN_RULES, categorize, groupOf } from "./categorize.js";
import type { GroupId } from "./categorize.js";
import { parseETransfer } from "./etransfer.js";
import { previousPeriod } from "./digest.js";
import { normalizeMerchant } from "./normalize.js";
import { observePerson, titleCase } from "./people.js";
import { pairInternalTransfers } from "./pairing.js";
import { computeSplit, effectiveAmount, netPosition, proposeSettlement } from "./split.js";
import type {
  Account,
  AccountKind,
  CategoryId,
  CategoryRule,
  Claim,
  ClaimId,
  ISODate,
  MerchantFacts,
  Person,
  PersonId,
  RawRow,
  Settlement,
  SplitSpec,
  Transaction,
  TransactionId,
  TransactionKind,
} from "./types.js";

/**
 * The whole domain as one immutable value plus pure transitions over it.
 *
 * Nothing here touches storage, the network or React. That is what makes the
 * pipeline testable end to end, and it is why the first prototype had to be
 * sliced apart with a script to be tested at all.
 */
export interface LedgerState {
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly people: readonly Person[];
  readonly claims: readonly Claim[];
  readonly settlements: readonly Settlement[];
  readonly rules: readonly CategoryRule[];
  readonly merchants: Readonly<Record<string, MerchantFacts>>;
}

export const emptyLedger = (): LedgerState => ({
  accounts: [],
  transactions: [],
  people: [],
  claims: [],
  settlements: [],
  rules: BUILTIN_RULES,
  merchants: {},
});

/** Injected so tests are deterministic and ids are reproducible. */
export interface Clock {
  now(): ISODate;
  id(prefix: string): string;
}

export function counterClock(start = 0): Clock {
  let n = start;
  return {
    now: () => "2026-01-01",
    id: (prefix) => `${prefix}:${n++}`,
  };
}

export const systemClock = (): Clock => ({
  now: () => new Date().toISOString().slice(0, 10),
  id: (prefix) => `${prefix}:${crypto.randomUUID()}`,
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export interface ImportReport {
  readonly imported: number;
  readonly duplicates: number;
  readonly pairsFound: number;
  readonly newPeople: readonly string[];
}

/** Stable across re-imports of overlapping date ranges. */
export function importHash(accountId: string, row: RawRow): string {
  const desc = row.descriptionParts.join(" | ").slice(0, 80);
  return `${accountId}|${row.date}|${row.amount}|${desc}`;
}

function classify(row: RawRow, description: string): {
  kind: TransactionKind;
  counterpartyName: string | null;
} {
  // A machine type from the FI beats any description pattern.
  const hint = (row.typeHint ?? "").toUpperCase();
  const et = parseETransfer(
    hint.includes("E_TRANSFER") ? `${hint} ${description}` : description,
    row.amount
  );
  if (et) {
    return {
      kind: et.direction === "in" ? "etransfer_in" : "etransfer_out",
      counterpartyName: et.named ? et.counterpartyName : null,
    };
  }
  return { kind: row.amount > 0 ? "credit" : "purchase", counterpartyName: null };
}

export function importRows(
  state: LedgerState,
  rows: readonly RawRow[],
  account: Account,
  clock: Clock
): { state: LedgerState; report: ImportReport } {
  const known = new Set(state.transactions.map((t) => t.importHash));
  const accounts = state.accounts.some((a) => a.id === account.id)
    ? state.accounts
    : [...state.accounts, account];

  let people = [...state.people];
  const newPeople: string[] = [];
  const added: Transaction[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const hash = importHash(account.id, row);
    if (known.has(hash)) {
      duplicates++;
      continue;
    }
    known.add(hash);

    const description = row.descriptionParts.join(" | ");
    const { kind, counterpartyName } = classify(row, description);

    let personId: string | undefined;
    if (counterpartyName) {
      const before = people.length;
      const observed = observePerson(people, counterpartyName);
      people = observed.people;
      personId = observed.person.id;
      if (people.length > before) newPeople.push(observed.person.displayName);
    }

    // E-transfers are counterparty movements, not merchant purchases, so they
    // never enter the merchant pipeline. Running them through it produces
    // categories like "Dining" for a person's surname.
    const isEtransfer = kind === "etransfer_in" || kind === "etransfer_out";
    const merchantKey = isEtransfer
      ? `etransfer:${personId ?? "unknown"}`
      : normalizeMerchant(description);

    const categoryId: CategoryId = isEtransfer
      ? kind === "etransfer_in"
        ? "Reimbursement"
        : "Transfer"
      : categorize({ merchantKey, amount: row.amount }, state.rules).categoryId;

    const facts = state.merchants[merchantKey];

    added.push({
      id: clock.id("tx"),
      importHash: hash,
      accountId: account.id,
      fi: account.fi,
      date: row.date,
      amount: row.amount,
      currency: row.currency,
      rawDescription: description,
      merchantKey,
      merchantName: isEtransfer
        ? (counterpartyName ?? "Unknown")
        : (facts?.name ?? titleCase(merchantKey)),
      ...(facts?.note ? { merchantNote: facts.note } : {}),
      merchantSource: facts ? "enriched" : isEtransfer ? "rule" : "rule",
      ...(facts?.commonlyShared !== undefined ? { commonlyShared: facts.commonlyShared } : {}),
      categoryId,
      categorySource: "rule",
      kind,
      ...(personId ? { personId } : {}),
      ...(row.balance !== undefined ? { balanceAfter: row.balance } : {}),
      ...(row.originalAmount ? { originalAmount: row.originalAmount } : {}),
    });
  }

  const paired = pairInternalTransfers([...state.transactions, ...added]);
  const pairsFound =
    paired.filter((t) => t.transferPairId).length / 2 -
    state.transactions.filter((t) => t.transferPairId).length / 2;

  return {
    state: { ...state, accounts, people, transactions: paired },
    report: { imported: added.length, duplicates, pairsFound: Math.max(0, pairsFound), newPeople },
  };
}

/* ------------------------------------------------------------------ */
/* Categorization overrides                                            */
/* ------------------------------------------------------------------ */

/**
 * A manual override writes a user rule, so the next import of the same
 * merchant lands in the right place without being corrected again. This is the
 * feedback loop the first prototype described and did not implement.
 */
export function setCategory(
  state: LedgerState,
  transactionId: TransactionId,
  categoryId: CategoryId,
  opts: { applyToMerchant: boolean },
  clock: Clock
): LedgerState {
  const tx = state.transactions.find((t) => t.id === transactionId);
  if (!tx) return state;

  const transactions = state.transactions.map((t) =>
    t.id === transactionId ? { ...t, categoryId, categorySource: "user" as const } : t
  );

  if (!opts.applyToMerchant) return { ...state, transactions };

  const rule: CategoryRule = {
    id: clock.id("rule"),
    pattern: `^${escapeRegExp(tx.merchantKey)}$`,
    flags: "i",
    categoryId,
    source: "user",
    priority: 1000,
  };
  const rules = [...state.rules.filter((r) => r.pattern !== rule.pattern), rule];
  const retagged = transactions.map((t) =>
    t.merchantKey === tx.merchantKey && t.categorySource !== "user"
      ? { ...t, categoryId, categorySource: "rule" as const }
      : t
  );
  return { ...state, rules, transactions: retagged };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Editable account fields. Absent keys keep their stored value. */
export interface AccountPatch {
  label?: string;
  kind?: AccountKind;
  creditLimit?: Cents;
  openingBalance?: Cents;
}

/** Relabel an account or correct its kind or credit limits. Account ids are
 *  derived from the import label, so renaming only changes the display name;
 *  the id — and every transaction's accountId — is left alone. */
export function editAccount(
  state: LedgerState,
  accountId: string,
  patch: AccountPatch
): LedgerState {
  if (!state.accounts.some((a) => a.id === accountId)) return state;
  return {
    ...state,
    accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a)),
  };
}

export function applyMerchantFacts(
  state: LedgerState,
  facts: readonly MerchantFacts[]
): LedgerState {
  const merchants = { ...state.merchants };
  for (const f of facts) merchants[f.key] = f;

  const transactions = state.transactions.map((t) => {
    const f = merchants[t.merchantKey];
    if (!f) return t;
    return {
      ...t,
      merchantName: f.name || t.merchantName,
      ...(f.note ? { merchantNote: f.note } : {}),
      merchantSource: "enriched" as const,
      ...(f.commonlyShared !== undefined ? { commonlyShared: f.commonlyShared } : {}),
      ...(t.categorySource === "user" || !f.categoryId
        ? {}
        : { categoryId: f.categoryId, categorySource: "enriched" as const }),
    };
  });
  return { ...state, merchants, transactions };
}

/* ------------------------------------------------------------------ */
/* Splits and settlement                                               */
/* ------------------------------------------------------------------ */

export function applySplit(
  state: LedgerState,
  transactionId: TransactionId,
  spec: SplitSpec,
  clock: Clock
): LedgerState {
  const tx = state.transactions.find((t) => t.id === transactionId);
  if (!tx) return state;

  const { claims } = computeSplit(tx, spec);
  const kept = state.claims.filter(
    (c) => c.transactionId !== transactionId || c.status === "settled"
  );
  const created: Claim[] = claims.map((c) => ({
    ...c,
    id: clock.id("claim"),
    status: "open",
    createdOn: tx.date,
  }));
  return { ...state, claims: [...kept, ...created] };
}

export function clearSplit(state: LedgerState, transactionId: TransactionId): LedgerState {
  return {
    ...state,
    claims: state.claims.filter(
      (c) => c.transactionId !== transactionId || c.status === "settled"
    ),
  };
}

/** Close a person's whole net position against one incoming transfer. */
export function settle(
  state: LedgerState,
  transactionId: TransactionId,
  clock: Clock
): { state: LedgerState; settlement: Settlement | null } {
  const tx = state.transactions.find((t) => t.id === transactionId);
  if (!tx?.personId) return { state, settlement: null };

  const proposal = proposeSettlement(tx.personId, tx.amount, state.claims);
  if (!proposal) return { state, settlement: null };

  const settlement: Settlement = {
    id: clock.id("settlement"),
    transactionId,
    personId: tx.personId,
    amount: abs(tx.amount),
    claimIds: proposal.claimIds,
    on: tx.date,
    residual: proposal.residual,
  };
  const ids = new Set(proposal.claimIds);
  return {
    state: {
      ...state,
      claims: state.claims.map((c) =>
        ids.has(c.id) ? { ...c, status: "settled" as const, settlementId: settlement.id } : c
      ),
      settlements: [...state.settlements, settlement],
    },
    settlement,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

export interface PeriodTotals {
  readonly cashOut: Cents;
  readonly yourShare: Cents;
  readonly recovered: Cents;
  readonly transactionCount: number;
}

export interface CategoryTotal {
  readonly categoryId: CategoryId;
  readonly cashOut: Cents;
  readonly yourShare: Cents;
  readonly transactionCount: number;
}

/**
 * Spend excludes paired internal transfers and anything still sitting in the
 * Transfer category. An e-transfer out becomes spend the moment it is given a
 * real category, because paying someone back for dinner genuinely is dining.
 */
export function spendIn(state: LedgerState, period: string | null): Transaction[] {
  return state.transactions.filter(
    (t) =>
      t.amount < 0 &&
      !t.transferPairId &&
      t.categoryId !== "Transfer" &&
      (period === null || t.date.startsWith(period))
  );
}

export function periodTotals(state: LedgerState, period: string | null): PeriodTotals {
  const spend = spendIn(state, period);
  const cashOut = sum(spend.map((t) => t.amount));
  const yourShare = sum(spend.map((t) => effectiveAmount(t, state.claims)));
  return {
    cashOut,
    yourShare,
    recovered: cents(cashOut - yourShare),
    transactionCount: spend.length,
  };
}

/**
 * One fully-aggregated pass over a period's spend. This is the single source
 * the donut, the ranked list and the lens all read, so the ring and the list
 * can never drift — the same failure the app already guards against by making
 * groupTotals derive from categoryTotals instead of re-totalling the
 * transactions. The lens only uses the categoryIds/totals to know what is a
 * category; it still pages the raw transactions for row content.
 */
export interface SpendCategory {
  readonly categoryId: CategoryId;
  readonly groupId: GroupId;
  readonly cashOut: Cents;
  readonly yourShare: Cents;
  readonly transactionCount: number;
  /** Per-merchant totals inside the category, keyed by merchant key. */
  readonly merchantTotals: Readonly<Record<string, Cents>>;
}

export interface SpendGroup {
  readonly groupId: GroupId;
  readonly cashOut: Cents;
  readonly yourShare: Cents;
  readonly transactionCount: number;
  /** The categories inside it, already sorted, so a drill-down needs no second pass. */
  readonly categories: readonly SpendCategory[];
}

export function buildSpendTree(state: LedgerState, period: string | null): SpendGroup[] {
  const byCategory = new Map<CategoryId, { cash: number; eff: number; n: number; merchants: Map<string, number> }>();
  for (const t of spendIn(state, period)) {
    const b = byCategory.get(t.categoryId) ?? { cash: 0, eff: 0, n: 0, merchants: new Map() };
    b.cash += -t.amount;
    b.eff += -effectiveAmount(t, state.claims);
    b.n++;
    b.merchants.set(t.merchantKey, (b.merchants.get(t.merchantKey) ?? 0) + -effectiveAmount(t, state.claims));
    byCategory.set(t.categoryId, b);
  }

  const byGroup = new Map<GroupId, SpendCategory[]>();
  for (const [categoryId, b] of byCategory) {
    const groupId = groupOf(categoryId);
    const merchantTotals: Record<string, Cents> = {};
    for (const [key, val] of b.merchants) merchantTotals[key] = cents(val);
    const cat: SpendCategory = {
      categoryId,
      groupId,
      cashOut: cents(b.cash),
      yourShare: cents(b.eff),
      transactionCount: b.n,
      merchantTotals,
    };
    const bucket = byGroup.get(groupId);
    if (bucket) bucket.push(cat);
    else byGroup.set(groupId, [cat]);
  }

  return [...byGroup.entries()]
    .map(([groupId, categories]) => {
      categories.sort((a, b) => b.yourShare - a.yourShare);
      return {
        groupId,
        cashOut: cents(sum(categories.map((c) => c.cashOut))),
        yourShare: cents(sum(categories.map((c) => c.yourShare))),
        transactionCount: categories.reduce((n, c) => n + c.transactionCount, 0),
        categories,
      };
    })
    .sort((a, b) => b.yourShare - a.yourShare);
}

/** The per-category slice of buildSpendTree, flattened and sorted. Kept as a
 *  distinct public shape for callers that want the plain list; built from the
 *  tree so it can never disagree with it. */
export function categoryTotals(state: LedgerState, period: string | null): CategoryTotal[] {
  const groups = buildSpendTree(state, period);
  return groups
    .flatMap((g) => g.categories)
    .map((c) => ({
      categoryId: c.categoryId,
      cashOut: c.cashOut,
      yourShare: c.yourShare,
      transactionCount: c.transactionCount,
    }))
    .sort((a, b) => b.yourShare - a.yourShare);
}

export interface GroupTotal {
  readonly groupId: GroupId;
  readonly cashOut: Cents;
  readonly yourShare: Cents;
  readonly transactionCount: number;
  /** The categories inside it, already sorted, so a drill-down needs no second pass. */
  readonly categories: readonly CategoryTotal[];
}

/** The same report as categoryTotals, one level up. Built from it rather than
 *  from the transactions again, so the two can never disagree. */
export function groupTotals(state: LedgerState, period: string | null): GroupTotal[] {
  const groups = buildSpendTree(state, period);
  return groups.map((g) => ({
    groupId: g.groupId,
    cashOut: g.cashOut,
    yourShare: g.yourShare,
    transactionCount: g.transactionCount,
    categories: g.categories.map((c) => ({
      categoryId: c.categoryId,
      cashOut: c.cashOut,
      yourShare: c.yourShare,
      transactionCount: c.transactionCount,
    })),
  }));
}

/** Richer KPIs: per-transaction and per-day spend, plus the share of claims
 *  that have been closed. These are computed on the fly from the same spend
 *  pipeline as categoryTotals, so they can never disagree with the totals. */

export interface ActivityKpis {
  readonly avgTransactionTotal: Cents;
  readonly spendingVelocity: Cents;
  readonly settlementRate: number;
  readonly splitSharePercent: number;
}

/** Average transaction size on spend, account-currency cents — the mean of the
 *  cash figures, since that is the number a statement shows. */
export function avgTransactionTotal(state: LedgerState, period: string | null): Cents {
  const spend = spendIn(state, period);
  if (spend.length === 0) return ZERO;
  return cents(Math.round(-sum(spend.map((t) => t.amount)) / spend.length));
}

/** Daily spend rate: cash out divided by the number of distinct calendar days
 *  the ledger spans in the period. Uses the spend so paired transfers don't
 *  inflate the figure. */
export function spendingVelocity(state: LedgerState, period: string | null): Cents {
  const spend = spendIn(state, period);
  if (spend.length === 0) return ZERO;
  // Calendar days spanned, first to last inclusive — not the number of days
  // that happen to have a transaction on them. Dividing by active days answers
  // "how much on a day I spent", which is a different question from the one the
  // KPI asks, and it made the figure identical to the average transaction
  // whenever there was at most one purchase a day. It also inflated the spend
  // chart's constant-rate reference line, which multiplies this by the
  // calendar span and so implied the reader was under a pace they never set.
  const days = calendarSpan(spend.map((t) => t.date));
  if (days === 0) return ZERO;
  return cents(Math.round(-sum(spend.map((t) => t.amount)) / days));
}

/** 0..1 — the fraction of all non-void claims that have been settled. */
export function settlementRate(state: LedgerState): number {
  const total = state.claims.filter((c) => c.status !== "void").length;
  if (total === 0) return 0;
  const settled = state.claims.filter((c) => c.status === "settled").length;
  return settled / total;
}

/** 0..1 — of this period's spend, how much is meant for other people (the
 *  share covered by others, not you). */
export function splitSharePercent(state: LedgerState, period: string | null): number {
  const t = periodTotals(state, period);
  if (t.cashOut === 0) return 0;
  return -t.recovered / -t.cashOut;
}

/** The largest single category increase (by your share) against the previous
 *  period. Returns null when there is no prior period or nothing grew. */
export function topCategoryDelta(
  state: LedgerState,
  period: string
): { categoryId: CategoryId; current: Cents; previous: Cents; delta: Cents } | null {
  const priorPeriod = previousPeriod(period);
  if (priorPeriod === null) return null;
  const current = categoryTotals(state, period);
  const prior = new Map(categoryTotals(state, priorPeriod).map((c) => [c.categoryId, c.yourShare]));
  let best: { categoryId: CategoryId; current: Cents; previous: Cents; delta: Cents } | null = null;
  for (const c of current) {
    const prev = prior.get(c.categoryId) ?? ZERO;
    const delta = c.yourShare - prev;
    if (delta > 0 && (!best || delta > best.delta)) {
      best = { categoryId: c.categoryId, current: c.yourShare, previous: prev, delta: cents(delta) };
    }
  }
  return best;
}

/** Inclusive day count between the earliest and latest date given. One date
 *  is one day, not zero. */
function calendarSpan(dates: readonly string[]): number {
  if (dates.length === 0) return 0;
  let min = dates[0]!;
  let max = dates[0]!;
  for (const d of dates) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return Math.round((Date.parse(max + "T00:00:00Z") - Date.parse(min + "T00:00:00Z")) / 86_400_000) + 1;
}


export interface PersonBalance {
  readonly person: Person;
  readonly net: Cents;
  readonly openClaims: readonly Claim[];
  readonly oldestOpenOn: ISODate | null;
}

export function personBalances(state: LedgerState): PersonBalance[] {
  return state.people
    .map((person) => {
      const openClaims = state.claims.filter(
        (c) => c.personId === person.id && c.status === "open"
      );
      const dates = openClaims.map((c) => c.createdOn).sort();
      return {
        person,
        net: netPosition(person.id, state.claims),
        openClaims,
        oldestOpenOn: dates[0] ?? null,
      };
    })
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

export interface AttentionItem {
  readonly kind: "unidentified_merchant" | "stale_claim" | "unmatched_transfer" | "import_warning";
  readonly count: number;
  readonly detail: string;
}

export function needsAttention(
  state: LedgerState,
  today: ISODate,
  opts: { staleAfterDays?: number } = {}
): AttentionItem[] {
  const stale = opts.staleAfterDays ?? 14;
  const items: AttentionItem[] = [];

  const unidentified = new Set(
    state.transactions
      .filter((t) => t.categoryId === "Uncategorized" && t.merchantSource !== "enriched")
      .map((t) => t.merchantKey)
  );
  if (unidentified.size > 0) {
    items.push({
      kind: "unidentified_merchant",
      count: unidentified.size,
      detail: "the local rules did not recognize these merchants",
    });
  }

  const todayN = Date.parse(today + "T00:00:00Z");
  const staleClaims = state.claims.filter(
    (c) =>
      c.status === "open" &&
      (todayN - Date.parse(c.createdOn + "T00:00:00Z")) / 86_400_000 > stale
  );
  if (staleClaims.length > 0) {
    items.push({
      kind: "stale_claim",
      count: staleClaims.length,
      detail: `open longer than ${stale} days`,
    });
  }

  const settledTx = new Set(state.settlements.map((s) => s.transactionId));
  const unmatched = state.transactions.filter(
    (t) => t.kind === "etransfer_in" && !settledTx.has(t.id)
  );
  if (unmatched.length > 0) {
    items.push({
      kind: "unmatched_transfer",
      count: unmatched.length,
      detail: "received but not matched to a claim",
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* People merge / unmerge                                              */
/* ------------------------------------------------------------------ */

/** Redirect all claims, settlements and transactions from one person to another,
 *  combining aliases, then remove the source person. No-op when either id is
 *  absent from the roster. */
export function mergePeople(
  state: LedgerState,
  keepId: PersonId,
  mergeId: PersonId
): LedgerState {
  const keep = state.people.find((p) => p.id === keepId);
  const merge = state.people.find((p) => p.id === mergeId);
  if (!keep || !merge || keepId === mergeId) return state;

  const aliases = [...new Set([...keep.aliases, ...merge.aliases])];

  return {
    ...state,
    people: [
      ...state.people.filter((p) => p.id !== keepId && p.id !== mergeId),
      { ...keep, aliases },
    ],
    claims: state.claims.map((c) =>
      c.personId === mergeId ? { ...c, personId: keepId } : c
    ),
    settlements: state.settlements.map((s) =>
      s.personId === mergeId ? { ...s, personId: keepId } : s
    ),
    transactions: state.transactions.map((t) =>
      t.personId === mergeId ? { ...t, personId: keepId } : t
    ),
  };
}

/** Extract a person from a combined entity. Moves selected claims (by id) to a
 *  new person whose displayName comes from the given alias. Returns the new
 *  person for UI feedback; no-op when the person or alias is unknown.
 *
 *  The new person is always a fresh entry, never a dedup — the user split it
 *  out on purpose, so re-observing the alias must not collapse it back into
 *  the person they are leaving. */
export function unmergePerson(
  state: LedgerState,
  personId: PersonId,
  alias: string,
  claimIds: readonly ClaimId[]
): { state: LedgerState; person: Person | null } {
  const existing = state.people.find((p) => p.id === personId);
  if (!existing || !alias) return { state, person: null };

  const displayName = titleCase(alias);
  const taken = new Set(state.people.map((p) => p.id));
  let base = `person:${displayName.toLowerCase().replace(/\s+/g, "-")}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}~${i}`;
  const newPerson: Person = { id, displayName, aliases: [displayName] };

  const ids = new Set(claimIds);
  const claims = state.claims.map((c) =>
    ids.has(c.id) ? { ...c, personId: newPerson.id } : c
  );
  const movedTx = new Set(
    claims.filter((c) => ids.has(c.id)).map((c) => c.transactionId)
  );
  const transactions = state.transactions.map((t) =>
    t.personId === personId && movedTx.has(t.id)
      ? { ...t, personId: newPerson.id }
      : t
  );

  return { state: { ...state, people: [...state.people, newPerson], claims, transactions }, person: newPerson };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export type ExportFormat = "full" | "summary";

export interface ExportOptions {
  readonly period?: string | null;
  readonly accountId?: string | null;
  readonly format: ExportFormat;
}

function csvCell(value: string | number): string {
  const s = String(value);
  // Directive 04/EC-style quoting: wrap in quotes whenever a comma, quote or
  // newline appears, doubling embedded quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells: readonly (string | number)[]): string {
  return cells.map(csvCell).join(",");
}

/** Serialize the ledger to CSV. "full" exports every transaction field for
 *  round-tripping or analysis elsewhere; "summary" is the human-facing shape —
 *  what left, what it was, what it cost you, and who was involved. Pure string
 *  building; the browser download lives in the UI. */
export function exportCsv(state: LedgerState, options: ExportOptions): string {
  const txs = state.transactions.filter(
    (t) =>
      (!options.accountId || t.accountId === options.accountId) &&
      (options.period === null || options.period === undefined || t.date.startsWith(options.period))
  );
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : 1));
  const personName = (id: string | undefined): string => {
    if (!id) return "";
    return state.people.find((p) => p.id === id)?.displayName ?? "";
  };
  const accountLabel = (id: string): string =>
    state.accounts.find((a) => a.id === id)?.label ?? id;

  if (options.format === "summary") {
    const lines = [csvRow(["Date", "Merchant", "Category", "Account", "Amount", "Your share", "People"])];
    for (const t of sorted) {
      const share = effectiveAmount(t, state.claims);
      lines.push(
        csvRow([
          t.date,
          t.merchantName,
          t.categoryId,
          accountLabel(t.accountId),
          t.amount / 100,
          share / 100,
          personName(t.personId),
        ])
      );
    }
    return lines.join("\n") + "\n";
  }

  const keys = [
    "id", "date", "amount", "currency", "merchant", "rawDescription",
    "category", "merchantNote", "account", "person", "kind", "transferPairId",
  ] as const;
  const lines = [csvRow(keys as readonly string[])];
  for (const t of sorted) {
    lines.push(
      csvRow([
        t.id,
        t.date,
        t.amount / 100,
        t.currency,
        t.merchantName,
        t.rawDescription,
        t.categoryId,
        t.merchantNote ?? "",
        accountLabel(t.accountId),
        personName(t.personId),
        t.kind,
        t.transferPairId ?? "",
      ])
    );
  }
  return lines.join("\n") + "\n";
}

export { effectiveAmount, netPosition, proposeSettlement, ZERO };
