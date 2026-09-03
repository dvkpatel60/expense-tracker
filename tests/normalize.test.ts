import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "../src/core/normalize.js";
import { stripGeography } from "../src/core/geography.js";

describe("normalizeMerchant", () => {
  const cases: [string, string][] = [
    ["SQ *BLUE DOOR COFFEE TORONTO ON", "BLUE DOOR COFFEE"],
    ["TST*BAR RAVAL TORONTO ON", "BAR RAVAL"],
    ["TST-PARALLEL BROTHERS TORONTO ON", "PARALLEL BROTHERS"],
    ["IDP PURCHASE - 4321 | LOBLAWS #1052 TORONTO ON", "LOBLAWS"],
    ["IDP PURCHASE - 4321 | METRO #0987 NORTH YORK ON", "METRO"],
    ["NETFLIX.COM 866-579-7172 ON", "NETFLIX"],
    ["AMZN Mktp CA*2H4KL9 WWW.AMAZON.CA ON", "AMAZON"],
    ["PAYPAL *STEAMGAMES 4029357733", "STEAMGAMES"],
    ["SPEND | SPOTIFY P3A9F2 STOCKHOLM", "SPOTIFY STOCKHOLM"],
    ["SPEND | TST*OTTO'S BIERHALLE TORONTO ON", "OTTO'S BIERHALLE"],
    ["POINT OF SALE PURCHASE ESSO CIRCLE K 1123 CALGARY AB", "ESSO CIRCLE K"],
    ["PRE-AUTHORIZED DEBIT | TORONTO HYDRO ELECTRIC", "TORONTO HYDRO ELECTRIC"],
    ["ABM WITHDRAWAL | BRANCH 04321", "ABM WITHDRAWAL BRANCH"],
  ];
  it.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizeMerchant(input)).toBe(expected);
  });

  it("never reduces a merchant to nothing", () => {
    for (const [input] of cases) expect(normalizeMerchant(input).length).toBeGreaterThan(0);
    expect(normalizeMerchant("TORONTO ON")).toBeTruthy();
    expect(normalizeMerchant("ON")).toBeTruthy();
  });

  it("keeps short brand names that look like ids", () => {
    expect(normalizeMerchant("A&W #2241 TORONTO ON")).toBe("A&W");
    expect(normalizeMerchant("7-ELEVEN 34112 VANCOUVER BC")).toBe("7-ELEVEN");
    expect(normalizeMerchant("M&M FOOD MARKET BURNABY BC")).toBe("M&M FOOD MARKET");
  });

  it("is stable across visits so the enrichment cache actually hits", () => {
    const a = normalizeMerchant("SQ *BLUE DOOR COFFEE TORONTO ON");
    const b = normalizeMerchant("SQ *BLUE DOOR COFFEE #22 TORONTO ON");
    const c = normalizeMerchant("SQ *BLUE DOOR COFFEE 4166891234 TORONTO ON");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("is idempotent", () => {
    for (const [input] of cases) {
      const once = normalizeMerchant(input);
      expect(normalizeMerchant(once)).toBe(once);
    }
  });
});

describe("stripGeography", () => {
  // The regression that motivated the city list: a greedy rule took
  // BLUE DOOR COFFEE TORONTO ON down to BLUE.
  it("does not eat the merchant name", () => {
    expect(stripGeography("BLUE DOOR COFFEE TORONTO ON")).toBe("BLUE DOOR COFFEE");
    expect(stripGeography("LA CARNITA COLLEGE TORONTO ON")).toBe("LA CARNITA COLLEGE");
    expect(stripGeography("PORTER AIRLINES TORONTO ON")).toBe("PORTER AIRLINES");
  });
  it("reverts rather than returning empty", () => {
    expect(stripGeography("TORONTO ON")).toBeTruthy();
  });
});
