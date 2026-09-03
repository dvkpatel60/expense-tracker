import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectParser, parseStatement } from "../src/parsers/index.js";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "../src/parsers/__fixtures__", name), "utf8");

describe("detection", () => {
  it("picks the right parser for each FI", () => {
    expect(detectParser(fixture("rbc-chequing.csv")).parser.id).toBe("rbc");
    expect(detectParser(fixture("scotia-visa.csv")).parser.id).toBe("scotiabank");
    expect(detectParser(fixture("wealthsimple-cash.csv")).parser.id).toBe("wealthsimple");
  });
  it("falls back to generic with low confidence", () => {
    const d = detectParser("Date,Amount,Payee\n2026-01-01,-10.00,Someone");
    expect(d.parser.id).toBe("generic");
    expect(d.confidence).toBeLessThan(0.5);
  });

  // A balance column is common to most bank exports. Scoring on it alone let
  // Wealthsimple claim a chequing CSV it cannot read and reject every row.
  it("does not claim a plain chequing export just because it has a balance", () => {
    const text =
      "Date,Description,Withdrawals,Deposits,Balance\n" +
      '8/1/2026,"LOBLAWS #1052 TORONTO ON",147.92,,6390.17\n' +
      '8/14/2026,"DIRECT DEPOSIT PAYROLL",,4812.66,11202.83\n';
    expect(detectParser(text).parser.id).toBe("generic");

    const r = parseStatement(text);
    expect(r.rows).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
    expect(r.rows[0]?.amount).toBe(-14792);
    expect(r.rows[1]?.amount).toBe(481266);
    // Days above 12 prove M/D/Y, so August is not read as the 1st of the month.
    expect(r.rows[1]?.date).toBe("2026-08-14");
  });
});

describe("RBC", () => {
  const r = parseStatement(fixture("rbc-chequing.csv"), "rbc");
  it("reads every row", () => {
    expect(r.rows).toHaveLength(12);
    expect(r.rejected).toHaveLength(0);
  });
  it("keeps both description fields separate", () => {
    expect(r.rows[0]?.descriptionParts).toEqual(["IDP PURCHASE - 4321", "LOBLAWS #1052 TORONTO ON"]);
  });
  it("does not drop USD rows when the CAD column is empty", () => {
    const usd = r.rows.find((x) => x.currency === "USD");
    expect(usd?.amount).toBe(-1420);
    expect(usd?.descriptionParts[1]).toContain("BROOKLYN BAGEL");
  });
  it("reads M/D/Y", () => {
    expect(r.rows[0]?.date).toBe("2026-08-02");
  });
});

describe("Scotiabank", () => {
  const r = parseStatement(fixture("scotia-visa.csv"), "scotiabank");
  it("reads the headerless four-column shape", () => {
    expect(r.rows).toHaveLength(11);
    expect(r.rows[0]?.descriptionParts[0]).toBe("TST*BAR RAVAL TORONTO ON");
    expect(r.rows[0]?.amount).toBe(-7244);
  });
  it("infers D/M/Y from a day above 12 rather than transposing the month", () => {
    const dmy = parseStatement(fixture("scotia-dmy-ambiguous.csv"), "scotiabank");
    expect(dmy.rows[0]?.date).toBe("2026-08-25");
    expect(dmy.rows[1]?.date).toBe("2026-08-03");
  });
  it("warns when a file cannot prove its date order", () => {
    const r2 = parseStatement("01/02/2026,-10.00,,\"SOMETHING\"", "scotiabank");
    expect(r2.rejected[0]?.reason).toMatch(/date order/i);
  });
});

describe("Wealthsimple", () => {
  const r = parseStatement(fixture("wealthsimple-cash.csv"), "wealthsimple");
  it("carries the machine transaction type through", () => {
    expect(r.rows).toHaveLength(7);
    expect(r.rows[1]?.typeHint).toBe("E_TRANSFER_IN");
  });
  it("reads ISO dates", () => {
    expect(r.rows[0]?.date).toBe("2026-08-03");
  });
});

describe("rejections", () => {
  it("explains bad rows instead of silently dropping them", () => {
    const r = parseStatement('Date,Amount,Description\nnot-a-date,-10.00,"X"\n2026-01-02,,"Y"', "generic");
    expect(r.rows).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]?.reason).toMatch(/date/i);
    expect(r.rejected[1]?.reason).toMatch(/amount/i);
  });
});
