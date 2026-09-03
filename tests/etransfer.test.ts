import { describe, expect, it } from "vitest";
import { parseETransfer } from "../src/core/etransfer.js";
import { observePerson, personIdFor } from "../src/core/people.js";

describe("parseETransfer", () => {
  it("reads the name across FI phrasings", () => {
    // RBC joins two description fields, so the name follows a separator.
    expect(parseETransfer("INTERAC E-TRANSFER SENT | DEVON OKAFOR", -9500)).toMatchObject({
      direction: "out",
      counterpartyName: "Devon Okafor",
    });
    expect(parseETransfer("INTERAC E-TRANSFER RECEIVED | SARAH MCKENNA", 11250)).toMatchObject({
      direction: "in",
      counterpartyName: "Sarah McKenna",
    });
    expect(
      parseETransfer("E_TRANSFER_IN | Interac e-Transfer from PRIYA RAMASWAMY", 7800)
    ).toMatchObject({ direction: "in", counterpartyName: "Priya Ramaswamy" });
    expect(
      parseETransfer("E_TRANSFER_OUT | Interac e-Transfer to DEVON OKAFOR", -4200)
    ).toMatchObject({ direction: "out", counterpartyName: "Devon Okafor" });
  });

  it("never reads an inbound transfer as a send", () => {
    const r = parseETransfer("Interac e-Transfer from JORDAN SENT-WILLIAMS", 5000);
    expect(r?.direction).toBe("in");
  });

  it("falls back on direction when the name is missing", () => {
    const r = parseETransfer("INTERAC E-TRF", -2500);
    expect(r).toMatchObject({ direction: "out", named: false });
  });

  it("ignores non-transfers", () => {
    expect(parseETransfer("LOBLAWS #1052 TORONTO ON", -18642)).toBeNull();
  });
});

describe("person aliasing", () => {
  it("unifies the initial-only form banks emit", () => {
    expect(personIdFor("SARAH MCKENNA")).toBe(personIdFor("S MCKENNA"));
    expect(personIdFor("Sarah McKenna")).toBe(personIdFor("s. mckenna"));
  });
  it("keeps different people apart", () => {
    expect(personIdFor("DEVON OKAFOR")).not.toBe(personIdFor("DEVON OSEI"));
    expect(personIdFor("SARAH MCKENNA")).not.toBe(personIdFor("JAMES MCKENNA"));
  });
  it("records every spelling and prefers the fullest for display", () => {
    let people = observePerson([], "S MCKENNA").people;
    const result = observePerson(people, "SARAH MCKENNA");
    expect(result.person.displayName).toBe("Sarah McKenna");
    expect(result.person.aliases).toEqual(["S McKenna", "Sarah McKenna"]);
    expect(result.people).toHaveLength(1);
  });
});
