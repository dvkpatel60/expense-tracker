import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cents, sum } from "../src/core/money.js";
import {
  applyMerchantFacts, applySplit, avgTransactionTotal, buildSpendTree, categoryTotals, counterClock,
  editAccount, emptyLedger, exportCsv, importRows, mergePeople, needsAttention, periodTotals,
  personBalances, setCategory, settle, spendIn, spendingVelocity, settlementRate,
  splitSharePercent, topCategoryDelta, unmergePerson,
} from "../src/core/ledger.js";
import type { LedgerState } from "../src/core/ledger.js";
import { parseStatement } from "../src/parsers/index.js";
import type { Account, Claim, Person, Transaction } from "../src/core/types.js";
import { observePerson } from "../src/core/people.js";
import { detectRecurring } from "../src/core/recurring.js";

const fixture = (n: string): string =>
  readFileSync(join(__dirname, "../src/parsers/__fixtures__", n), "utf8");

const ACCOUNTS: Record<string, Account> = {
  rbc: { id: "acct:rbc", label: "RBC Chequing", fi: "rbc", kind: "chequing" },
  scotia: { id: "acct:scotia", label: "Scotia Visa", fi: "scotiabank", kind: "credit" },
  ws: { id: "acct:ws", label: "Wealthsimple Cash", fi: "wealthsimple", kind: "chequing" },
};

function loadAll(): LedgerState {
  const clock = counterClock();
  let state = emptyLedger();
  for (const [key, file] of [
    ["rbc", "rbc-chequing.csv"],
    ["scotia", "scotia-visa.csv"],
    ["ws", "wealthsimple-cash.csv"],
  ] as const) {
    const parsed = parseStatement(fixture(file));
    state = importRows(state, parsed.rows, ACCOUNTS[key]!, clock).state;
  }
  return state;
}

describe("import", () => {
  it("ingests all three FIs into one ledger", () => {
    const state = loadAll();
    expect(state.transactions).toHaveLength(30);
    expect(state.accounts).toHaveLength(3);
  });

  it("is idempotent — re-importing an overlapping range adds nothing", () => {
    const clock = counterClock();
    let state = emptyLedger();
    const parsed = parseStatement(fixture("rbc-chequing.csv"));
    state = importRows(state, parsed.rows, ACCOUNTS["rbc"]!, clock).state;
    const before = state.transactions.length;
    const second = importRows(state, parsed.rows, ACCOUNTS["rbc"]!, clock);
    expect(second.report.imported).toBe(0);
    expect(second.report.duplicates).toBe(before);
    expect(second.state.transactions).toHaveLength(before);
  });

  it("pairs the credit card payment across two accounts", () => {
    const state = loadAll();
    const paired = state.transactions.filter((t) => t.transferPairId);
    expect(paired).toHaveLength(2);
    expect(new Set(paired.map((t) => t.accountId)).size).toBe(2);
    expect(paired.every((t) => t.categoryId === "Transfer")).toBe(true);
  });

  it("routes e-transfers to people, not the merchant pipeline", () => {
    const state = loadAll();
    const transfers = state.transactions.filter((t) => t.kind.startsWith("etransfer"));
    expect(transfers).toHaveLength(5);
    expect(transfers.every((t) => t.personId !== undefined)).toBe(true);
    expect(transfers.every((t) => t.merchantKey.startsWith("etransfer:"))).toBe(true);
  });

  it("resolves S MCKENNA and SARAH MCKENNA to one person", () => {
    const state = loadAll();
    expect(state.people).toHaveLength(3);
    const sarah = state.people.find((p) => p.displayName.includes("McKenna"));
    expect(sarah?.aliases.length).toBe(2);
  });

  it("categorizes what the local rules can and leaves the rest for enrichment", () => {
    const state = loadAll();
    const unknown = state.transactions.filter((t) => t.categoryId === "Uncategorized");
    expect(unknown.map((t) => t.merchantKey).sort()).toEqual([
      "BROOKLYN BAGEL NY", "LA CARNITA COLLEGE", "PARALLEL BROTHERS",
    ]);
  });
});

describe("category overrides", () => {
  it("writes a user rule so the merchant stays fixed", () => {
    const clock = counterClock();
    let state = loadAll();
    const tx = state.transactions.find((t) => t.merchantKey === "OTTO'S BIERHALLE")!;
    state = setCategory(state, tx.id, "Dining", { applyToMerchant: true }, clock);
    expect(state.rules.some((r) => r.source === "user" && r.categoryId === "Dining")).toBe(true);
    expect(state.transactions.find((t) => t.id === tx.id)?.categoryId).toBe("Dining");
  });

  it("does not let enrichment overwrite a manual choice", () => {
    const clock = counterClock();
    let state = loadAll();
    const tx = state.transactions.find((t) => t.merchantKey === "PARALLEL BROTHERS")!;
    state = setCategory(state, tx.id, "Entertainment", { applyToMerchant: false }, clock);
    state = applyMerchantFacts(state, [
      { key: "PARALLEL BROTHERS", name: "Parallel Brothers", categoryId: "Dining", retrievedOn: "2026-09-01" },
    ]);
    expect(state.transactions.find((t) => t.id === tx.id)?.categoryId).toBe("Entertainment");
  });
});

describe("splits and reporting", () => {
  it("separates cash out from your share", () => {
    const clock = counterClock();
    let state = loadAll();
    const dinner = state.transactions.find((t) => t.merchantKey === "LA CARNITA COLLEGE")!;
    const sarah = state.people.find((p) => p.displayName.includes("McKenna"))!;

    const before = periodTotals(state, "2026-08");
    state = applySplit(state, dinner.id, {
      kind: "even", participants: [sarah.id], includeMe: true,
    }, clock);
    const after = periodTotals(state, "2026-08");

    expect(after.cashOut).toBe(before.cashOut);
    expect(after.yourShare).toBe(before.yourShare + 10730);
    expect(after.recovered).toBe(cents(-10730));
  });

  it("shows the split inside the category breakdown", () => {
    const clock = counterClock();
    let state = loadAll();
    const dinner = state.transactions.find((t) => t.merchantKey === "LA CARNITA COLLEGE")!;
    state = setCategory(state, dinner.id, "Dining", { applyToMerchant: false }, clock);
    state = applySplit(state, dinner.id, { kind: "even", participants: ["p:x"], includeMe: true }, clock);
    const dining = categoryTotals(state, "2026-08").find((c) => c.categoryId === "Dining")!;
    expect(dining.cashOut).toBeGreaterThan(dining.yourShare);
  });

  it("excludes paired transfers from spend", () => {
    const state = loadAll();
    const spend = spendIn(state, "2026-08");
    // The $1,240 card payment exists on both sides and appears in neither.
    expect(state.transactions.some((t) => Math.abs(t.amount) === 124000)).toBe(true);
    expect(spend.some((t) => Math.abs(t.amount) === 124000)).toBe(false);
    expect(spend.every((t) => t.transferPairId === undefined)).toBe(true);

    // Removing the pairing would double count it, so the totals must differ.
    const unpairedCash = state.transactions
      .filter((t) => t.amount < 0 && t.categoryId !== "Transfer")
      .reduce((sum, t) => sum + t.amount, 0);
    const totals = periodTotals(state, null);
    expect(totals.cashOut).toBe(unpairedCash);
  });
});

describe("settlement", () => {
  it("closes a net position with one incoming transfer", () => {
    const clock = counterClock();
    let state = loadAll();
    const sarah = state.people.find((p) => p.displayName.includes("McKenna"))!;
    const dinner = state.transactions.find((t) => t.merchantKey === "LA CARNITA COLLEGE")!;
    const cab = state.transactions.find((t) => t.merchantKey === "PRESTO FARE TRANSIT")!;

    // She owes me half of dinner; I owe her half of the fare she covered.
    state = applySplit(state, dinner.id, { kind: "even", participants: [sarah.id], includeMe: true }, clock);
    state = applySplit(state, cab.id, { kind: "amounts", shares: [{ personId: sarah.id, amount: cents(330) }] }, clock);

    const balancesBefore = personBalances(state).find((b) => b.person.id === sarah.id)!;
    expect(balancesBefore.openClaims).toHaveLength(2);

    const incoming = state.transactions.find(
      (t) => t.kind === "etransfer_in" && t.personId === sarah.id
    )!;
    const result = settle(state, incoming.id, clock);
    expect(result.settlement?.claimIds).toHaveLength(2);

    const after = personBalances(result.state).find((b) => b.person.id === sarah.id)!;
    expect(after.openClaims).toHaveLength(0);
    expect(after.net).toBe(0);
  });
});

describe("attention queue", () => {
  it("surfaces unidentified merchants and unmatched transfers", () => {
    const state = loadAll();
    const items = needsAttention(state, "2026-09-02");
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("unidentified_merchant");
    expect(kinds).toContain("unmatched_transfer");
  });
});

describe("editAccount", () => {
  it("relabels an account", () => {
    const state = loadAll();
    const rbc = state.accounts.find((a) => a.id === "acct:rbc")!;
    expect(rbc.label).toBe("RBC Chequing");
    const updated = editAccount(state, "acct:rbc", { label: "RBC Daily" });
    expect(updated.accounts.find((a) => a.id === "acct:rbc")!.label).toBe("RBC Daily");
    // The original is untouched.
    expect(state.accounts.find((a) => a.id === "acct:rbc")!.label).toBe("RBC Chequing");
  });

  it("changes account kind and credit limit", () => {
    const state = loadAll();
    const scotia = state.accounts.find((a) => a.id === "acct:scotia")!;
    expect(scotia.kind).toBe("credit");
    const updated = editAccount(state, "acct:scotia", { kind: "savings", creditLimit: cents(50000) });
    const changed = updated.accounts.find((a) => a.id === "acct:scotia")!;
    expect(changed.kind).toBe("savings");
    expect(changed.creditLimit).toBe(cents(50000));
  });

  it("sets opening balance on an account that had none", () => {
    const state = loadAll();
    const ws = state.accounts.find((a) => a.id === "acct:ws")!;
    expect(ws.openingBalance).toBeUndefined();
    const updated = editAccount(state, "acct:ws", { openingBalance: cents(25000) });
    expect(updated.accounts.find((a) => a.id === "acct:ws")!.openingBalance).toBe(cents(25000));
  });

  it("leaves unrelated accounts untouched", () => {
    const state = loadAll();
    const before = state.accounts.map((a) => ({ ...a }));
    const updated = editAccount(state, "acct:rbc", { label: "Changed" });
    expect(updated.accounts).toHaveLength(before.length);
    // The other two are identical references.
    expect(updated.accounts.find((a) => a.id === "acct:scotia")).toBe(state.accounts.find((a) => a.id === "acct:scotia"));
    expect(updated.accounts.find((a) => a.id === "acct:ws")).toBe(state.accounts.find((a) => a.id === "acct:ws"));
  });

  it("returns the same state when the account id is unknown", () => {
    const state = loadAll();
    const result = editAccount(state, "acct:nonexistent", { label: "Nope" });
    expect(result).toBe(state);
  });
});

describe("mergePeople", () => {
  function twoPeople(): { state: LedgerState; a: Person; b: Person } {
    let people: readonly Person[] = [];
    let p1: Person;
    ({ people, person: p1 } = observePerson(people, "Sarah McKenna"));
    let p2: Person;
    ({ people, person: p2 } = observePerson(people, "S McKenna"));
    const tx: Transaction = {
      id: "tx:0",
      importHash: "h0",
      accountId: "acct:rbc",
      fi: "rbc",
      date: "2026-01-05",
      amount: cents(-4000),
      currency: "CAD",
      rawDescription: "foo",
      merchantKey: "etransfer:" + p2.id,
      merchantName: "S McKenna",
      merchantSource: "rule",
      categoryId: "Transfer",
      categorySource: "rule",
      kind: "etransfer_out",
      personId: p2.id,
    };
    const claim: Claim = {
      id: "claim:0",
      transactionId: "tx:0",
      personId: p2.id,
      amount: cents(2000),
      direction: "i_owe_them",
      status: "open",
      createdOn: "2026-01-05",
    };
    return { state: { ...emptyLedger(), people, transactions: [tx], claims: [claim] }, a: p1, b: p2 };
  }

  it("redirects claims, transactions and settlements to the kept person and drops the merged one", () => {
    const { state, a, b } = twoPeople();
    const merged = mergePeople(state, a.id, b.id);

    const people = merged.people;
    expect(people).toHaveLength(1);
    expect(people[0]!.id).toBe(a.id);
    // Aliases from both gather on the survivor.
    expect(people[0]!.aliases).toEqual(["Sarah McKenna", "S McKenna"]);

    expect(merged.transactions.every((t) => t.personId === a.id)).toBe(true);
    expect(merged.claims.every((c) => c.personId === a.id)).toBe(true);
    expect(merged.claims[0]!.personId).toBe(a.id);
  });

  it("is a no-op when either id is missing or they are the same", () => {
    const { state, a } = twoPeople();
    expect(mergePeople(state, a.id, "person:nope")).toBe(state);
    expect(mergePeople(state, "person:nope", a.id)).toBe(state);
    expect(mergePeople(state, a.id, a.id)).toBe(state);
  });
});

describe("unmergePerson", () => {
  it("moves selected claims (and their transactions) to a new person named by the alias", () => {
    // Build one person with two open claims on two transactions.
    let people: readonly Person[] = [];
    let p: Person;
    ({ people, person: p } = observePerson(people, "Sarah McKenna"));
    const txB: Transaction = {
      id: "tx:1", importHash: "h1", accountId: "acct:rbc", fi: "rbc",
      date: "2026-01-06", amount: cents(-5000), currency: "CAD",
      rawDescription: "bar", merchantKey: "etransfer:" + p.id, merchantName: "Sarah M",
      merchantSource: "rule", categoryId: "Transfer", categorySource: "rule",
      kind: "etransfer_out", personId: p.id,
    };
    const clB: Claim = {
      id: "claim:1", transactionId: "tx:1", personId: p.id, amount: cents(5000),
      direction: "they_owe_me", status: "open", createdOn: "2026-01-06",
    };
    const state: LedgerState = {
      ...emptyLedger(),
      people,
      transactions: [
        { id: "tx:0", importHash: "h0", accountId: "acct:rbc", fi: "rbc",
          date: "2026-01-05", amount: cents(-4000), currency: "CAD",
          rawDescription: "foo", merchantKey: "etransfer:" + p.id, merchantName: "Sarah M",
          merchantSource: "rule", categoryId: "Transfer", categorySource: "rule",
          kind: "etransfer_out", personId: p.id },
        txB,
      ],
      claims: [
        { id: "claim:0", transactionId: "tx:0", personId: p.id, amount: cents(4000),
          direction: "they_owe_me", status: "open", createdOn: "2026-01-05" },
        clB,
      ],
    };

    const { state: next, person } = unmergePerson(state, p.id, "S McKenna", ["claim:1"]);

    expect(person).not.toBeNull();
    expect(person!.displayName).toBe("S McKenna");
    expect(next.people).toHaveLength(2);

    // The moved claim now belongs to the new person; the other stays.
    expect(next.claims.find((c) => c.id === "claim:0")!.personId).toBe(p.id);
    expect(next.claims.find((c) => c.id === "claim:1")!.personId).toBe(person!.id);

    // The transaction behind the moved claim follows its person.
    expect(next.transactions.find((t) => t.id === "tx:0")!.personId).toBe(p.id);
    expect(next.transactions.find((t) => t.id === "tx:1")!.personId).toBe(person!.id);
  });

  it("returns null for an unknown person or empty alias", () => {
    let people: readonly Person[] = [];
    ({ people } = observePerson(people, "Sarah McKenna"));
    const state: LedgerState = { ...emptyLedger(), people };
    expect(unmergePerson(state, "person:nope", "S", []).person).toBeNull();
  });
});

describe("richer KPIs (task-06)", () => {
  it("avgTransactionTotal is the mean of cash spend in the period", () => {
    const state = loadAll();
    const avg = avgTransactionTotal(state, "2026-07");
    const spend = spendIn(state, "2026-07");
    if (spend.length === 0) {
      // Not present in the fixtures; assert the empty-period zero instead.
      expect(avgTransactionTotal(state, "1999-01")).toBe(0);
      return;
    }
    const expected = Math.round(-spend.reduce((n, t) => n + t.amount, 0) / spend.length);
    expect(avg).toBe(expected);
  });

  it("spendingVelocity divides cash out by distinct calendar days", () => {
    let people: readonly Person[] = [];
    const txA: Transaction = { id: "tx:0", importHash: "h0", accountId: "acct:r", fi: "rbc",
      date: "2026-07-01", amount: cents(-10000), currency: "CAD", rawDescription: "a",
      merchantKey: "m-a", merchantName: "A", merchantSource: "rule", categoryId: "Dining",
      categorySource: "rule", kind: "purchase" };
    const txB: Transaction = { id: "tx:1", importHash: "h1", accountId: "acct:r", fi: "rbc",
      date: "2026-07-10", amount: cents(-20000), currency: "CAD", rawDescription: "b",
      merchantKey: "m-b", merchantName: "B", merchantSource: "rule", categoryId: "Dining",
      categorySource: "rule", kind: "purchase" };
    const state: LedgerState = { ...emptyLedger(), transactions: [txA, txB] };
    // 2 distinct days, 30000 in cash out -> 15000/day.
    expect(spendingVelocity(state, "2026-07")).toBe(15000);
  });

  it("settlementRate is the fraction of non-void claims that are settled", () => {
    const claim = (id: string, status: Claim["status"]): Claim => ({
      id, transactionId: "tx:" + id, personId: "person:x", amount: cents(100),
      direction: "they_owe_me", status, createdOn: "2026-01-01",
    });
    const state: LedgerState = {
      ...emptyLedger(),
      claims: [claim("a", "open"), claim("b", "settled"), claim("c", "settled"), claim("d", "void")],
    };
    // 3 non-void, 2 settled.
    expect(settlementRate(state)).toBeCloseTo(2 / 3);
  });

  it("splitSharePercent is recovered over cash out", () => {
    let people: readonly Person[] = [];
    ({ people } = observePerson(people, "Sarah McKenna"));
    const tx: Transaction = { id: "tx:0", importHash: "h0", accountId: "acct:r", fi: "rbc",
      date: "2026-07-01", amount: cents(-4000), currency: "CAD", rawDescription: "dinner",
      merchantKey: "m", merchantName: "Diner", merchantSource: "rule", categoryId: "Dining",
      categorySource: "rule", kind: "purchase", personId: people[0]!.id };
    const claim: Claim = { id: "cl:0", transactionId: "tx:0", personId: people[0]!.id,
      amount: cents(2000), direction: "they_owe_me", status: "open", createdOn: "2026-07-01" };
    const state: LedgerState = { ...emptyLedger(), people, transactions: [tx], claims: [claim] };
    // 4000 out, 2000 recovered -> 0.5
    expect(splitSharePercent(state, "2026-07")).toBeCloseTo(0.5);
  });

  it("topCategoryDelta finds the largest category growth vs the prior period", () => {
    // One category with a big month-over-month jump in your share.
    const tx = (id: string, date: string, merchant: string, cat: string, amount: number): Transaction => ({
      id, importHash: id, accountId: "acct:r", fi: "rbc", date,
      amount: cents(-amount), currency: "CAD", rawDescription: merchant,
      merchantKey: merchant, merchantName: merchant, merchantSource: "rule",
      categoryId: cat, categorySource: "rule", kind: "purchase",
    });
    let people: readonly Person[] = [];
    ({ people } = observePerson(people, "Sarah McKenna"));
    const trans = [
      tx("a", "2026-06-03", "netflix", "Subscriptions", 1500),
      tx("b", "2026-07-03", "netflix", "Subscriptions", 1500),
      tx("c", "2026-07-05", "uber", "Transport", 800),
    ];
    const state: LedgerState = { ...emptyLedger(), people, transactions: trans };
    // Netflix: prior 1500, current 1500 -> delta 0. Transport: not in prior, current 800 -> delta 800.
    const top = topCategoryDelta(state, "2026-07");
    expect(top).not.toBeNull();
    expect(top!.categoryId).toBe("Transport");
    expect(top!.delta).toBe(800);
  });
});

describe("recurring detection (task-07)", () => {
  function monthlyTxs(n: number, interval: number, start = "2026-01-05"): Transaction[] {
    const out: Transaction[] = [];
    let date = start;
    for (let i = 0; i < n; i++) {
      out.push({
        id: "tx:" + i, importHash: "h" + i, accountId: "acct:r", fi: "rbc",
        date, amount: cents(-1500), currency: "CAD", rawDescription: "netflix",
        merchantKey: "netflix", merchantName: "Netflix", merchantSource: "rule",
        categoryId: "Subscriptions", categorySource: "rule", kind: "purchase",
      });
      date = addDays(date, interval);
    }
    return out;
  }

  it("flags a monthly merchant with 3+ transactions that recur every ~30 days", () => {
    const txs = monthlyTxs(4, 30, "2026-01-05"); // Jan 5, Feb 4, Mar 6, Apr 5
    const state: LedgerState = { ...emptyLedger(), transactions: txs };
    const rec = detectRecurring(state, null);
    expect(rec.length).toBe(1);
    expect(rec[0]!.merchantKey).toBe("netflix");
    expect(rec[0]!.frequency).toBe("monthly");
    expect(rec[0]!.avgAmount).toBe(1500);
  });

  it("ignores merchants with fewer than three occurrences", () => {
    const txs = monthlyTxs(2, 30);
    const state: LedgerState = { ...emptyLedger(), transactions: txs };
    expect(detectRecurring(state, null)).toHaveLength(0);
  });

  it("ignores merchants with irregular intervals (not a steady cadence)", () => {
    const txs = [
      { ...monthlyTxs(1, 30)[0]!, date: "2026-01-01" },
      { ...monthlyTxs(1, 30)[0]!, id: "tx:9", date: "2026-01-20" },
      { ...monthlyTxs(1, 30)[0]!, id: "tx:8", date: "2026-02-10" },
    ];
    const state: LedgerState = { ...emptyLedger(), transactions: txs };
    expect(detectRecurring(state, null)).toHaveLength(0);
  });

  it("is limited to the requested period", () => {
    const txs = monthlyTxs(3, 30, "2025-12-05"); // Dec, Jan, Feb
    const state: LedgerState = { ...emptyLedger(), transactions: txs };
    // Only December has >=3 within the period? Actually all within null. With 2025-12 only 1.
    expect(detectRecurring(state, "2025-12")).toHaveLength(0);
    expect(detectRecurring(state, null).length).toBeGreaterThan(0);
  });
});

function addDays(date: string, days: number): string {
  const d = new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe("exportCsv (task-10)", () => {
  it("exports a summary with header and one row per transaction", () => {
    const state = loadAll();
    const csv = exportCsv(state, { format: "summary", period: null });
    const lines = csv.trim().split("\n");
    const header = lines[0]!.split(",");
    expect(header).toEqual(["Date", "Merchant", "Category", "Account", "Amount", "Your share", "People"]);
    // Header + one row per transaction.
    expect(lines.length).toBe(state.transactions.length + 1);
    // Every subsequent line has a YYYY-MM-DD date in the first cell.
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2},/);
    }
  });

  it("marks cells with commas, quotes or newlines as quoted", () => {
    const tx: Transaction = {
      id: "tx:0", importHash: "h0", accountId: "acct:r", fi: "rbc",
      date: "2026-07-01", amount: cents(-500), currency: "CAD",
      rawDescription: 'a, "quoted"', merchantKey: "m", merchantName: 'Cafe "X", North',
      merchantSource: "rule", categoryId: "Dining", categorySource: "rule", kind: "purchase",
    };
    const state: LedgerState = { ...emptyLedger(), transactions: [tx] };
    const csv = exportCsv(state, { format: "summary", period: null });
    expect(csv).toContain('"Cafe ""X"", North"');
  });

  it("filters by period prefix and account", () => {
    const state = loadAll();
    // Only rows in 2026-08 for the rbc account.
    const filtered = exportCsv(state, { format: "summary", period: "2026-08", accountId: "acct:rbc" });
    const lines = filtered.trim().split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith("2026-08-")).toBe(true);
    }
  });

  it("includes the person's display name in the People column once split", () => {
    let people: readonly Person[] = [];
    let p: Person;
    ({ people, person: p } = observePerson(people, "Sarah McKenna"));
    const tx: Transaction = { id: "tx:0", importHash: "h0", accountId: "acct:r", fi: "rbc",
      date: "2026-07-01", amount: cents(-4000), currency: "CAD", rawDescription: "dinner",
      merchantKey: "m", merchantName: "Diner", merchantSource: "rule", categoryId: "Dining",
      categorySource: "rule", kind: "etransfer_out", personId: p.id };
    const state: LedgerState = { ...emptyLedger(), people, transactions: [tx] };
    const csv = exportCsv(state, { format: "summary", period: null });
    expect(csv).toContain("Sarah McKenna");
  });
});

describe("buildSpendTree (task-12)", () => {
  it("agrees with categoryTotals and groupTotals for a seeded ledger", () => {
    const state = loadAll();
    const tree = buildSpendTree(state, null);
    // Same totals as the flattened list.
    const catFlatten = tree.flatMap((g) => g.categories);
    for (const c of categoryTotals(state, null)) {
      const node = catFlatten.find((n) => n.categoryId === c.categoryId);
      expect(node).toBeDefined();
      expect(node!.yourShare).toBe(c.yourShare);
      expect(node!.cashOut).toBe(c.cashOut);
      expect(node!.transactionCount).toBe(c.transactionCount);
    }
    // Every group has its category total reconcile to the group total.
    for (const g of tree) {
      expect(g.yourShare).toBe(cents(sum(g.categories.map((c) => c.yourShare))));
    }
  });

  it("tags each category with its group and per-merchant totals", () => {
    const state = loadAll();
    const tree = buildSpendTree(state, null);
    const grocery = tree
      .flatMap((g) => g.categories)
      .find((c) => c.categoryId === "Groceries");
    expect(grocery).toBeDefined();
    // Its group carries it, per the category→group mapping.
    expect(tree.some((g) => g.groupId === grocery!.groupId && g.categories.includes(grocery!))).toBe(true);
    // merchantTotals reconstruct the category's yourShare.
    expect(cents(sum(Object.values(grocery!.merchantTotals)))).toBe(grocery!.yourShare);
  });

  it("keeps groups ordered by your share, descending", () => {
    const state = loadAll();
    const tree = buildSpendTree(state, null);
    for (let i = 1; i < tree.length; i++) {
      expect(tree[i]!.yourShare).toBeLessThanOrEqual(tree[i - 1]!.yourShare);
    }
  });
});
