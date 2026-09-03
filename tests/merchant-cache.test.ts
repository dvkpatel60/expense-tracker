import { describe, expect, it } from "vitest";
import { createMerchantCache } from "../dev/merchant-cache.js";
import type { MerchantFacts } from "../src/core/types.js";

const fact = (over: Partial<MerchantFacts> & { key: string }): MerchantFacts => ({
  name: over.key,
  retrievedOn: "2026-09-01",
  ...over,
});

describe("dev merchant cache", () => {
  it("splits a lookup into hits and misses", () => {
    const cache = createMerchantCache();
    cache.put([fact({ key: "LOBLAWS", name: "Loblaws" })]);
    const { hits, misses } = cache.get(["LOBLAWS", "BLUE DOOR COFFEE"]);
    expect(hits.map((h) => h.name)).toEqual(["Loblaws"]);
    expect(misses).toEqual(["BLUE DOOR COFFEE"]);
  });

  it("round-trips every optional field", () => {
    const cache = createMerchantCache();
    cache.put([
      fact({
        key: "TIM HORTONS",
        name: "Tim Hortons",
        note: "Canadian coffee chain",
        categoryId: "Coffee",
        commonlyShared: true,
      }),
    ]);
    expect(cache.get(["TIM HORTONS"]).hits[0]).toEqual({
      key: "TIM HORTONS",
      name: "Tim Hortons",
      note: "Canadian coffee chain",
      categoryId: "Coffee",
      commonlyShared: true,
      retrievedOn: "2026-09-01",
    });
  });

  // exactOptionalPropertyTypes is on: an absent field must be absent, not
  // present-and-undefined, or it overwrites a real value when spread.
  it("omits absent fields rather than storing undefined", () => {
    const cache = createMerchantCache();
    cache.put([fact({ key: "MYSTERY" })]);
    const hit = cache.get(["MYSTERY"]).hits[0]!;
    expect("note" in hit).toBe(false);
    expect("categoryId" in hit).toBe(false);
    expect("commonlyShared" in hit).toBe(false);
  });

  it("distinguishes commonlyShared false from unset", () => {
    const cache = createMerchantCache();
    cache.put([fact({ key: "RENT", commonlyShared: false })]);
    expect(cache.get(["RENT"]).hits[0]?.commonlyShared).toBe(false);
  });

  it("overwrites on re-identification instead of duplicating", () => {
    const cache = createMerchantCache();
    cache.put([fact({ key: "A", name: "First" })]);
    cache.put([fact({ key: "A", name: "Second" })]);
    expect(cache.size()).toBe(1);
    expect(cache.get(["A"]).hits[0]?.name).toBe("Second");
  });

  it("starts empty — it is in-memory, so nothing leaks between processes", () => {
    expect(createMerchantCache().size()).toBe(0);
  });
});
