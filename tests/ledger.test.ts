import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cents } from "../src/core/money.js";
import {
  applyMerchantFacts, applySplit, categoryTotals, counterClock, emptyLedger,
  importRows, needsAttention, periodTotals, personBalances, setCategory, settle, spendIn,
} from "../src/core/ledger.js";
import type { LedgerState } from "../src/core/ledger.js";
import { parseStatement } from "../src/parsers/index.js";
import type { Account } from "../src/core/types.js";

const fixture = (n: string): string =>
  readFileSync(join(__dirname, "../src/parsers/__fixtures__", n), "utf8");

const ACCOUNTS: Record<string, Account> = {
  rbc: { id: "acct:rbc", label: "RBC Chequing", fi: "rbc" },
  scotia: { id: "acct:scotia", label: "Scotia Visa", fi: "scotiabank" },
  ws: { id: "acct:ws", label: "Wealthsimple Cash", fi: "wealthsimple" },
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
