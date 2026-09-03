import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferAccountKind, towardsNetWorth, utilisation } from "../src/core/accounts.js";
import { counterClock, emptyLedger, importRows } from "../src/core/ledger.js";
import type { LedgerState } from "../src/core/ledger.js";
import { cents } from "../src/core/money.js";
import { accountStatement, balanceSheet } from "../src/core/statement.js";
import { parseStatement } from "../src/parsers/index.js";
import type { Account } from "../src/core/types.js";

const CHEQUING: Account = {
  id: "acct:chq",
  label: "Everyday Chequing",
  fi: "generic",
  kind: "chequing",
};

/** The August fixture the user supplied: 94 rows carrying a real balance
 *  column, opening $9,240.17 and closing $7,451.67. */
function august(): LedgerState {
  const text = readFileSync(join(__dirname, "../aug-2026-chequing.csv"), "utf8");
  const parsed = parseStatement(text);
  return importRows(emptyLedger(), parsed.rows, CHEQUING, counterClock()).state;
}

describe("account kinds", () => {
  it("infers a card from its label", () => {
    expect(inferAccountKind("Scotia Visa", "scotiabank")).toBe("credit");
    expect(inferAccountKind("Amex Cobalt", "generic")).toBe("credit");
    expect(inferAccountKind("TFSA Savings", "generic")).toBe("savings");
    expect(inferAccountKind("RBC Chequing", "rbc")).toBe("chequing");
  });

  // A chequing balance of $2,000 and a card balance of $2,000 are opposite
  // facts, and card exports disagree about which sign means "owed".
  it("counts a card against net worth whichever sign the export used", () => {
    expect(towardsNetWorth("chequing", cents(200000))).toBe(200000);
    expect(towardsNetWorth("credit", cents(200000))).toBe(-200000);
    expect(towardsNetWorth("credit", cents(-200000))).toBe(-200000);
  });

  it("reports utilisation only when a limit is known", () => {
    const card: Account = { id: "c", label: "Visa", fi: "rbc", kind: "credit" };
    expect(utilisation(card, cents(50000))).toBeNull();
    expect(utilisation({ ...card, creditLimit: cents(200000) }, cents(50000))).toBeCloseTo(0.25);
    expect(utilisation({ ...CHEQUING, creditLimit: cents(1) }, cents(50000))).toBeNull();
  });
});

describe("account statement", () => {
  it("reports the bank's own opening and closing balances", () => {
    const s = accountStatement(august(), CHEQUING, "2026-08");
    expect(s.balanceReported).toBe(true);
    // Straight from the file: the balance before row one, and after row 94.
    expect(s.opening).toBe(cents(924017));
    expect(s.closing).toBe(cents(745167));
    expect(s.transactionCount).toBe(94);
  });

  // The whole point of carrying the bank's figure rather than computing one.
  it("reconciles: opening plus every flow equals the reported closing", () => {
    const s = accountStatement(august(), CHEQUING, "2026-08");
    expect(s.opening + s.inflows + s.outflows).toBe(s.closing);
  });

  it("separates inflows from outflows", () => {
    const s = accountStatement(august(), CHEQUING, "2026-08");
    expect(s.inflows).toBe(cents(990032));
    expect(s.outflows).toBe(cents(-1168882));
  });

  it("falls back to flows, and says so, when the export has no balance column", () => {
    const text = "Date,Description,Amount\n2026-08-01,COFFEE,-5.00\n2026-08-02,PAY,100.00\n";
    const parsed = parseStatement(text);
    const account: Account = { ...CHEQUING, openingBalance: cents(10000) };
    const state = importRows(emptyLedger(), parsed.rows, account, counterClock()).state;
    const s = accountStatement(state, account, "2026-08");
    expect(s.balanceReported).toBe(false);
    expect(s.closing).toBe(cents(19500));
  });

  it("is an empty statement, not a crash, for a period with no rows", () => {
    const s = accountStatement(august(), CHEQUING, "1999-01");
    expect(s.transactionCount).toBe(0);
    expect(s.closing).toBe(cents(0));
  });
});

describe("balance sheet", () => {
  it("puts assets and liabilities on opposite sides", () => {
    const clock = counterClock();
    const chq: Account = { ...CHEQUING, openingBalance: cents(500000) };
    const card: Account = {
      id: "acct:visa",
      label: "Visa",
      fi: "scotiabank",
      kind: "credit",
      openingBalance: cents(0),
      creditLimit: cents(1000000),
    };
    let state = importRows(
      emptyLedger(),
      parseStatement("Date,Description,Amount\n2026-08-02,PAY,1000.00\n").rows,
      chq,
      clock
    ).state;
    state = importRows(
      state,
      parseStatement("Date,Description,Amount\n2026-08-03,LAPTOP,-1500.00\n").rows,
      card,
      clock
    ).state;

    const sheet = balanceSheet(state, "2026-08");
    expect(sheet.assets).toBe(cents(600000));
    // Owed is reported positive whichever way the card's sign ran.
    expect(sheet.liabilities).toBe(cents(150000));
    expect(sheet.netWorth).toBe(cents(450000));
  });

  it("has no delta to report for all time", () => {
    expect(balanceSheet(august(), null).netWorthDelta).toBeNull();
  });

  it("gives every account a line, including untouched ones", () => {
    const sheet = balanceSheet(august(), "2026-08");
    expect(sheet.accounts).toHaveLength(1);
    expect(sheet.accounts[0]?.account.id).toBe(CHEQUING.id);
  });
});
