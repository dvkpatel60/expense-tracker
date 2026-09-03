import { describe, expect, it } from "vitest";
import { emptyLedger } from "../src/core/ledger.js";
import { load, MemoryStore, save } from "../src/store/store.js";
import { migrate } from "../src/store/migrations.js";

describe("persistence", () => {
  it("round-trips a ledger", async () => {
    const store = new MemoryStore();
    const ledger = { ...emptyLedger(), people: [{ id: "p:1", displayName: "A", aliases: ["A"] }] };
    await save(store, ledger);
    const result = await load(store);
    expect(result.ledger.people).toHaveLength(1);
    expect(result.warning).toBeNull();
  });

  it("returns an empty ledger on a cold start", async () => {
    const r = await load(new MemoryStore());
    expect(r.ledger.transactions).toHaveLength(0);
  });

  it("does not throw on corrupt data", async () => {
    const store = new MemoryStore();
    await store.set("split-ledger", "{ not json");
    const r = await load(store);
    expect(r.ledger.transactions).toHaveLength(0);
    expect(r.warning).toMatch(/unreadable/i);
  });

  it("survives storage being unavailable", async () => {
    const broken = {
      get: async () => { throw new Error("no storage"); },
      set: async () => {},
      remove: async () => {},
    };
    const r = await load(broken);
    expect(r.warning).toMatch(/memory only/i);
  });

  it("refuses data from a newer build rather than mangling it", () => {
    expect(() => migrate({ version: 99 } as never)).toThrow(/version 99/);
  });
});

describe("migration", () => {
  it("carries the merchant cache forward from v1", () => {
    const v1 = {
      version: 1 as const,
      txs: [],
      claims: [],
      cache: { "BLUE DOOR COFFEE": { name: "Blue Door Coffee", category: "Coffee", note: "Cafe" } },
    };
    const { data, steps, lostData } = migrate(v1);
    expect(steps).toEqual(["1 -> 2"]);
    expect(lostData).toBe(true);
    expect(data.ledger.merchants["BLUE DOOR COFFEE"]?.name).toBe("Blue Door Coffee");
    expect(data.ledger.merchants["BLUE DOOR COFFEE"]?.categoryId).toBe("Coffee");
  });
});
