import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cents } from "../src/core/money.js";
import {
  applyMerchantFacts, applySplit, categoryTotals, counterClock, editAccount, emptyLedger,
  importRows, mergePeople, needsAttention, periodTotals, personBalances, setCategory, settle,
  spendIn, unmergePerson,
} from "../src/core/ledger.js";
import type { LedgerState } from "../src/core/ledger.js";
import { parseStatement } from "../src/parsers/index.js";
import type { Account, Claim, Person, Transaction } from "../src/core/types.js";
import { observePerson } from "../src/core/people.js";

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
