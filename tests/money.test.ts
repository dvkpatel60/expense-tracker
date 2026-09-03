import { describe, expect, it } from "vitest";
import { allocate, allocateEven, cents, formatCents, parseAmount, sum } from "../src/core/money.js";

describe("parseAmount", () => {
  it("reads the formats banks actually emit", () => {
    expect(parseAmount("-1,240.00")).toBe(-124000);
    expect(parseAmount("(45.10)")).toBe(-4510);
    expect(parseAmount("$18.75")).toBe(1875);
    expect(parseAmount("3120.55")).toBe(312055);
    expect(parseAmount("-.50")).toBe(-50);
    expect(parseAmount("7")).toBe(700);
  });
  it("rejects rather than guessing", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("n/a")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("12.34.56")).toBeNull();
  });
  it("does not lose a cent to float representation", () => {
    expect(parseAmount("0.07")).toBe(7);
    expect(parseAmount("29.99")).toBe(2999);
    expect(parseAmount("1234567.89")).toBe(123456789);
  });
});

describe("allocate", () => {
  it("splits an indivisible amount without losing a cent", () => {
    const parts = allocateEven(cents(10000), 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(sum(parts)).toBe(10000);
  });
  it("is deterministic across calls", () => {
    expect(allocateEven(cents(1000), 7)).toEqual(allocateEven(cents(1000), 7));
  });
  it("handles negatives symmetrically", () => {
    expect(sum(allocateEven(cents(-10000), 3))).toBe(-10000);
  });
  it("weights by proportion", () => {
    expect(allocate(cents(10000), [50, 30, 20])).toEqual([5000, 3000, 2000]);
    expect(sum(allocate(cents(10001), [1, 1, 1]))).toBe(10001);
  });
  it("falls back to even when all weights are zero", () => {
    expect(allocate(cents(300), [0, 0, 0])).toEqual([100, 100, 100]);
  });

  // The invariant the whole module exists for.
  it("always sums to the total, over many random shapes", () => {
    let seed = 1234567;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 3000; i++) {
      const total = cents(Math.floor(rand() * 2_000_00) - 100_00);
      const n = 1 + Math.floor(rand() * 9);
      const weights = Array.from({ length: n }, () => Math.floor(rand() * 100));
      expect(sum(allocate(total, weights))).toBe(total);
    }
  });
});

describe("formatCents", () => {
  it("uses a real minus sign and optional currency", () => {
    expect(formatCents(cents(-124000))).toBe("\u22121,240.00");
    expect(formatCents(cents(1875), { currency: true })).toBe("$18.75");
    expect(formatCents(cents(1875), { sign: true })).toBe("+18.75");
  });
});
