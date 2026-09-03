import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  GROUPS,
  categoriesIn,
  groupOf,
} from "../src/core/categorize.js";
import { counterClock, emptyLedger, groupTotals, importRows, categoryTotals } from "../src/core/ledger.js";
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

describe("macro grouping", () => {
  // A category with no group would silently vanish from the ring, which is the
  // one failure mode a breakdown must not have.
  it("assigns every category to exactly one group", () => {
    const seen = new Set<string>();
    for (const group of GROUPS) {
      for (const c of categoriesIn(group)) {
        expect(seen.has(c), `${c} appears in two groups`).toBe(false);
        seen.add(c);
      }
    }
    for (const c of CATEGORIES) expect(seen.has(c), `${c} has no group`).toBe(true);
    expect(seen.size).toBe(CATEGORIES.length);
  });

  it("puts a category in the group that claims it", () => {
    expect(groupOf("Coffee")).toBe("Food & Drink");
    expect(groupOf("Housing")).toBe("Living");
    expect(groupOf("Uncategorized")).toBe("Unsorted");
  });

  // An old store or a hand-edited rule can carry a category the app retired.
  it("treats an unknown category as unsorted rather than throwing", () => {
    expect(groupOf("Yachts")).toBe("Unsorted");
  });
});

describe("groupTotals", () => {
  it("sums to the same money as categoryTotals", () => {
    const state = seeded();
    const cats = categoryTotals(state, null);
    const groups = groupTotals(state, null);
    const catCash = cats.reduce((n, c) => n + c.cashOut, 0);
    const groupCash = groups.reduce((n, g) => n + g.cashOut, 0);
    expect(groupCash).toBe(catCash);
    expect(groups.reduce((n, g) => n + g.transactionCount, 0)).toBe(
      cats.reduce((n, c) => n + c.transactionCount, 0)
    );
  });

  it("carries the categories inside each group, already ranked", () => {
    const groups = groupTotals(seeded(), null);
    for (const g of groups) {
      expect(g.categories.length).toBeGreaterThan(0);
      for (const c of g.categories) expect(groupOf(c.categoryId)).toBe(g.groupId);
      const shares = g.categories.map((c) => c.yourShare);
      expect([...shares].sort((a, b) => b - a)).toEqual(shares);
      expect(g.cashOut).toBe(g.categories.reduce((n, c) => n + c.cashOut, 0));
    }
  });

  it("ranks groups by your share, biggest first", () => {
    const shares = groupTotals(seeded(), null).map((g) => g.yourShare);
    expect([...shares].sort((a, b) => b - a)).toEqual(shares);
  });

  it("is empty for a period with no spend rather than throwing", () => {
    expect(groupTotals(seeded(), "1999-01")).toEqual([]);
  });
});
