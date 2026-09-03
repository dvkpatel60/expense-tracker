import { describe, expect, it } from "vitest";
import {
  MAX_INSIGHTS,
  buildInsightsPrompt,
  coerceInsights,
  parseInsights,
  validateDigest,
} from "../src/enrich/insights.js";
import type { InsightsDigest } from "../src/core/digest.js";
import { cents } from "../src/core/money.js";

const digest = (over: Partial<InsightsDigest> = {}): InsightsDigest => ({
  period: "2026-08",
  totals: {
    cashOut: cents(-100000),
    yourShare: cents(-80000),
    recovered: cents(-20000),
    transactionCount: 12,
  },
  previousTotals: {
    cashOut: cents(-90000),
    yourShare: cents(-90000),
    recovered: cents(0),
    transactionCount: 10,
  },
  categories: [
    {
      categoryId: "Dining",
      yourShare: cents(40000),
      cashOut: cents(60000),
      transactionCount: 6,
      previousYourShare: cents(20000),
    },
  ],
  topMerchants: [{ merchant: "LA CARNITA COLLEGE", yourShare: cents(10730), transactionCount: 1 }],
  openClaims: { count: 2, total: cents(15000) },
  recurringCandidates: [],
  savingsOpportunity: [],
  topMerchantDelta: [],
  ...over,
});

describe("insights prompt", () => {
  it("states figures and the categories the model may choose from", () => {
    const prompt = buildInsightsPrompt(digest());
    expect(prompt).toContain("$800.00");
    expect(prompt).toContain("LA CARNITA COLLEGE");
    expect(prompt).toContain("Dining");
    expect(prompt).toMatch(/JSON array/i);
  });

  it("omits the comparison when there is no previous period", () => {
    const prompt = buildInsightsPrompt(digest({ period: null, previousTotals: null }));
    expect(prompt).toContain("all time");
    expect(prompt).not.toMatch(/Previous period/);
  });
});

describe("parsing the model's answer", () => {
  const array = JSON.stringify([
    { kind: "headline", text: "Dining doubled." },
    { kind: "trend", text: "Up $200 on last month.", categoryId: "Dining" },
  ]);

  it("survives code fences, which models add unbidden", () => {
    expect(parseInsights("```json\n" + array + "\n```")).toHaveLength(2);
  });

  it("keeps a category only when it is one we know", () => {
    const [, trend] = parseInsights(array);
    expect(trend?.categoryId).toBe("Dining");
    const bogus = parseInsights(
      JSON.stringify([{ kind: "trend", text: "x", categoryId: "Yachts" }])
    );
    // exactOptionalPropertyTypes: absent, not present-and-undefined.
    expect("categoryId" in bogus[0]!).toBe(false);
  });

  it("drops malformed elements instead of failing the whole answer", () => {
    const mixed = coerceInsights([
      { kind: "headline", text: "Good." },
      { kind: "prophecy", text: "Bad kind." },
      { kind: "trend", text: "   " },
      null,
      "not an object",
    ]);
    expect(mixed).toHaveLength(1);
  });

  it("caps how many insights one answer can produce", () => {
    const many = Array.from({ length: 50 }, () => ({ kind: "habit", text: "Coffee daily." }));
    expect(coerceInsights(many)).toHaveLength(MAX_INSIGHTS);
  });

  it("accepts and keeps the savings kind with its category", () => {
    const out = coerceInsights([
      { kind: "savings", text: "Friends owe you back ~$20 on groceries; split more often.", categoryId: "Groceries" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("savings");
    expect(out[0]!.categoryId).toBe("Groceries");
  });

  it("refuses anything that is not an array", () => {
    expect(() => parseInsights("{}")).toThrow();
    expect(() => parseInsights("")).toThrow();
  });
});

/**
 * The server-side half of the privacy boundary. The client promises to send
 * aggregates; this is what makes it true even when the client is not ours.
 */
describe("digest validation", () => {
  it("accepts a real digest", () => {
    expect(validateDigest(digest())).toBeNull();
  });

  it("refuses a counterparty key smuggled into the merchant list", () => {
    const bad = digest({
      topMerchants: [
        { merchant: "etransfer:person:mckenna|s", yourShare: cents(100), transactionCount: 1 },
      ],
    });
    expect(validateDigest(bad)).toMatch(/counterparty/i);
  });

  it("refuses a day-level date in the period field", () => {
    expect(validateDigest(digest({ period: "2026-08-14" as string }))).toMatch(/YYYY-MM/);
  });

  it("refuses an unbounded merchant list", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      merchant: `SHOP ${i}`,
      yourShare: cents(1),
      transactionCount: 1,
    }));
    expect(validateDigest(digest({ topMerchants: many }))).toMatch(/at most/i);
  });

  it("refuses an unknown category", () => {
    const bad = digest({
      categories: [
        {
          categoryId: "Yachts" as never,
          yourShare: cents(1),
          cashOut: cents(1),
          transactionCount: 1,
          previousYourShare: cents(0),
        },
      ],
    });
    expect(validateDigest(bad)).toMatch(/unknown category/i);
  });

  it("refuses figures that are not finite numbers", () => {
    expect(validateDigest(digest({ openClaims: { count: 1, total: "lots" as never } }))).toBeTruthy();
    expect(validateDigest(digest({ totals: { cashOut: NaN } as never }))).toBeTruthy();
  });

  it("refuses a merchant string long enough to be a payload", () => {
    const bad = digest({
      topMerchants: [{ merchant: "x".repeat(500), yourShare: cents(1), transactionCount: 1 }],
    });
    expect(validateDigest(bad)).toMatch(/120 characters/);
  });

  it("refuses a body that is not a digest at all", () => {
    expect(validateDigest(undefined)).toBeTruthy();
    expect(validateDigest("give me everything")).toBeTruthy();
  });

  it("refuses a counterparty key in the recurring or delta fields", () => {
    const badRecurring = digest({
      recurringCandidates: [
        { merchant: "etransfer:mckenna|s", avgAmount: cents(100), frequency: "monthly", regularity: 0.9 },
      ],
    });
    expect(validateDigest(badRecurring)).toMatch(/counterpart/i);
    const badDelta = digest({
      topMerchantDelta: [
        { merchant: "etransfer:mckenna|s", currentShare: cents(1), previousShare: cents(0) },
      ],
    });
    expect(validateDigest(badDelta)).toMatch(/counterpart/i);
  });

  it("refuses a cadence that is not weekly or monthly", () => {
    const bad = digest({
      recurringCandidates: [
        { merchant: "NETFLIX", avgAmount: cents(100), frequency: "annual" as never, regularity: 0.9 },
      ],
    });
    expect(validateDigest(bad)).toMatch(/cadence/i);
  });

  it("refuses a savings opportunity on an unknown category", () => {
    const bad = digest({
      savingsOpportunity: [
        { categoryId: "Gold Bars" as never, yourShare: cents(1), cashOut: cents(1), potentialSavings: cents(0) },
      ],
    });
    expect(validateDigest(bad)).toMatch(/unknown category/i);
  });
});
