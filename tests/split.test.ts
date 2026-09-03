import { describe, expect, it } from "vitest";
import { cents, sum } from "../src/core/money.js";
import { computeSplit, effectiveAmount, netPosition, proposeSettlement, SplitError } from "../src/core/split.js";
import type { Claim, Transaction } from "../src/core/types.js";

const tx = (amount: number, id = "tx:1"): Transaction => ({
  id, importHash: id, accountId: "a", fi: "rbc", date: "2026-08-08",
  amount: cents(amount), currency: "CAD", rawDescription: "", merchantKey: "M",
  merchantName: "M", merchantSource: "rule", categoryId: "Dining",
  categorySource: "rule", kind: "purchase",
});

const claim = (over: Partial<Claim>): Claim => ({
  id: "c", transactionId: "tx:1", personId: "p", amount: cents(1000),
  direction: "they_owe_me", status: "open", createdOn: "2026-08-08", ...over,
});

describe("computeSplit", () => {
  it("splits evenly and gives me a share", () => {
    const r = computeSplit(tx(-21460), { kind: "even", participants: ["a", "b", "c"], includeMe: true });
    expect(r.claims.map((c) => c.amount)).toEqual([5365, 5365, 5365]);
    expect(r.myShare).toBe(5365);
  });

  it("keeps the invariant when the amount does not divide", () => {
    const r = computeSplit(tx(-10000), { kind: "even", participants: ["a", "b"], includeMe: true });
    expect(sum([...r.claims.map((c) => c.amount), r.myShare])).toBe(10000);
  });

  it("excludes me when I did not partake", () => {
    const r = computeSplit(tx(-9000), { kind: "even", participants: ["a", "b"], includeMe: false });
    expect(r.myShare).toBe(0);
    expect(sum(r.claims.map((c) => c.amount))).toBe(9000);
  });

  it("splits by percentage", () => {
    const r = computeSplit(tx(-10000), {
      kind: "percent", shares: [{ personId: "a", percent: 60 }], myPercent: 40,
    });
    expect(r.claims[0]?.amount).toBe(6000);
    expect(r.myShare).toBe(4000);
  });

  it("rejects percentages that do not total 100", () => {
    expect(() =>
      computeSplit(tx(-10000), { kind: "percent", shares: [{ personId: "a", percent: 60 }], myPercent: 30 })
    ).toThrow(SplitError);
  });

  it("assigns explicit amounts and leaves the remainder to me", () => {
    const r = computeSplit(tx(-10000), {
      kind: "amounts", shares: [{ personId: "a", amount: cents(2500) }, { personId: "b", amount: cents(3000) }],
    });
    expect(r.myShare).toBe(4500);
  });

  it("refuses to assign more than the transaction", () => {
    expect(() =>
      computeSplit(tx(-5000), { kind: "amounts", shares: [{ personId: "a", amount: cents(6000) }] })
    ).toThrow(SplitError);
  });

  it("itemizes and spreads tax and tip proportionally", () => {
    // $100 bill: $30 item for me, $50 item shared with A, $20 unallocated tip.
    const r = computeSplit(tx(-10000), {
      kind: "itemized",
      items: [
        { label: "my main", amount: cents(3000), participants: [], includeMe: true },
        { label: "shared plates", amount: cents(5000), participants: ["a"], includeMe: true },
      ],
    });
    expect(sum([...r.claims.map((c) => c.amount), r.myShare])).toBe(10000);
    // A had $25 of $80 allocated, so takes 25/80 of the $20 tip.
    expect(r.claims[0]?.amount).toBe(3125);
    expect(r.myShare).toBe(6875);
  });

  it("flips direction when someone else fronted the money", () => {
    const r = computeSplit(tx(4200), { kind: "even", participants: ["a"], includeMe: true });
    expect(r.claims[0]?.direction).toBe("i_owe_them");
  });

  it("holds the invariant across many random splits", () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const amount = -(1 + Math.floor(rand() * 500_00));
      const n = 1 + Math.floor(rand() * 6);
      const r = computeSplit(tx(amount), {
        kind: "even",
        participants: Array.from({ length: n }, (_, k) => `p${k}`),
        includeMe: rand() > 0.3,
      });
      expect(sum([...r.claims.map((c) => c.amount), r.myShare])).toBe(Math.abs(amount));
    }
  });
});

describe("effectiveAmount", () => {
  it("offsets spend by what others owe", () => {
    const t = tx(-10000);
    const claims = [claim({ id: "c1", amount: cents(2500) }), claim({ id: "c2", amount: cents(2500) })];
    expect(effectiveAmount(t, claims)).toBe(-5000);
  });
  it("counts a settled claim, because that money was never yours", () => {
    const t = tx(-10000);
    expect(effectiveAmount(t, [claim({ amount: cents(5000), status: "settled" })])).toBe(-5000);
  });
  it("ignores voided claims", () => {
    const t = tx(-10000);
    expect(effectiveAmount(t, [claim({ amount: cents(5000), status: "void" })])).toBe(-10000);
  });
});

describe("proposeSettlement", () => {
  // The rotating-group case: claims run both directions with the same person.
  it("nets opposing claims so one transfer closes both", () => {
    const claims = [
      claim({ id: "c1", personId: "p:sarah", amount: cents(4000), direction: "they_owe_me" }),
      claim({ id: "c2", personId: "p:sarah", amount: cents(1500), direction: "i_owe_them" }),
    ];
    expect(netPosition("p:sarah", claims)).toBe(2500);
    const p = proposeSettlement("p:sarah", cents(2500), claims);
    expect(p?.claimIds).toEqual(["c1", "c2"]);
    expect(p?.exact).toBe(true);
    expect(p?.residual).toBe(0);
  });

  it("reports a residual instead of refusing a partial payment", () => {
    const claims = [claim({ id: "c1", personId: "p:sarah", amount: cents(4000) })];
    const p = proposeSettlement("p:sarah", cents(3000), claims);
    expect(p?.residual).toBe(1000);
    expect(p?.exact).toBe(false);
  });

  it("returns nothing when there is no open position", () => {
    expect(proposeSettlement("p:nobody", cents(2500), [])).toBeNull();
  });
});
