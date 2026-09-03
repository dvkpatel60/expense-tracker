import { describe, expect, it } from "vitest";
import { buildInsightsDigest, previousPeriod } from "../src/core/digest.js";
import { applySplit, counterClock, emptyLedger, importRows } from "../src/core/ledger.js";
import type { LedgerState } from "../src/core/ledger.js";
import { parseStatement } from "../src/parsers/index.js";
import { SAMPLES } from "../src/ui/samples.js";

function seeded(): LedgerState {
  const clock = counterClock();
  let state = emptyLedger();
  for (const s of SAMPLES) {
    const parsed = parseStatement(s.text, s.fi);
    state = importRows(
      state,
      parsed.rows,
      { id: `acct:${s.label}`, label: s.label, fi: s.fi, kind: s.kind },
      clock
    ).state;
  }
  return state;
}

describe("insights digest", () => {
  it("steps back a month, including across a year boundary", () => {
    expect(previousPeriod("2026-08")).toBe("2026-07");
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });

  /**
   * The whole point of the digest: it is what AI analysis is allowed to see,
   * so the assertion is about what is NOT in it. Serializing and searching
   * catches a leak anywhere in the tree, including in a field added later.
   */
  it("carries no transaction-level detail across the boundary", () => {
    const state = seeded();
    const serialized = JSON.stringify(buildInsightsDigest(state, null));

    // No person, no account, no raw description.
    for (const person of state.people) {
      expect(serialized).not.toContain(person.displayName);
      for (const alias of person.aliases) expect(serialized).not.toContain(alias);
    }
    for (const account of state.accounts) {
      expect(serialized).not.toContain(account.id);
      expect(serialized).not.toContain(account.label);
    }
    // No day-level dates: a YYYY-MM-DD anywhere means a transaction leaked.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // And no counterparty keys, which never belong in a merchant list.
    expect(serialized).not.toContain("etransfer:");
  });

  it("excludes counterparty merchants while still counting their category", () => {
    const state = seeded();
    const digest = buildInsightsDigest(state, null);
    expect(digest.topMerchants.every((m) => !m.merchant.startsWith("etransfer:"))).toBe(true);
    expect(digest.topMerchants.length).toBeGreaterThan(0);
  });

  it("reports your share, not cash out, once a bill is split", () => {
    const state = seeded();
    const dinner = state.transactions.find((t) => /carnita/i.test(t.merchantName))!;
    const sarah = state.people.find((p) => p.displayName.includes("McKenna"))!;
    const split = applySplit(
      state,
      dinner.id,
      { kind: "even", participants: [sarah.id], includeMe: true },
      counterClock(500)
    );

    const before = buildInsightsDigest(state, null);
    const after = buildInsightsDigest(split, null);

    // Cash out is untouched by a split; your share and recovery move.
    expect(after.totals.cashOut).toBe(before.totals.cashOut);
    expect(Math.abs(after.totals.yourShare)).toBeLessThan(Math.abs(before.totals.yourShare));
    expect(after.openClaims.count).toBe(1);

    const merchant = after.topMerchants.find((m) => m.merchant === dinner.merchantKey);
    const priorMerchant = before.topMerchants.find((m) => m.merchant === dinner.merchantKey);
    expect(merchant!.yourShare).toBeLessThan(priorMerchant!.yourShare);
  });

  it("caps the merchant list so one request cannot be inflated", () => {
    const digest = buildInsightsDigest(seeded(), null);
    expect(digest.topMerchants.length).toBeLessThanOrEqual(15);
  });

  it("has no previous period to compare against for all time", () => {
    expect(buildInsightsDigest(seeded(), null).previousTotals).toBeNull();
  });

  it("adds no day-level dates, names or counterparties in the new recurring/savings/delta fields", () => {
    const state = seeded();
    const serialized = JSON.stringify(buildInsightsDigest(state, null));
    // The new fields must obey the same boundary as everything else.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toContain("etransfer:");
    for (const person of state.people) {
      expect(serialized).not.toContain(person.displayName);
    }
  });

  it("reports recurring candidates with cadence and regularity, no expected date", () => {
    const digest = buildInsightsDigest(seeded(), null);
    for (const r of digest.recurringCandidates) {
      expect(r.merchant).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(["monthly", "weekly"]).toContain(r.frequency);
      expect(r.regularity).toBeGreaterThanOrEqual(0);
      expect(r.regularity).toBeLessThanOrEqual(1);
    }
  });

  it("reports savings opportunities only where your share exceeds the cash out", () => {
    const digest = buildInsightsDigest(seeded(), null);
    for (const s of digest.savingsOpportunity) {
      expect(s.yourShare).toBeGreaterThan(s.cashOut);
      expect(s.potentialSavings).toBe(s.yourShare - s.cashOut);
    }
  });

  it("builds merchant deltas only when a previous period exists", () => {
    const allTime = buildInsightsDigest(seeded(), null);
    expect(allTime.topMerchantDelta).toHaveLength(0);

    const monthly = buildInsightsDigest(seeded(), "2026-08");
    // May be empty if no merchant moved, but must be a bounded array never
    // carrying counterparty keys.
    expect(monthly.topMerchantDelta.length).toBeLessThanOrEqual(5);
    for (const m of monthly.topMerchantDelta) {
      expect(m.merchant).not.toContain("etransfer:");
    }
  });
});
