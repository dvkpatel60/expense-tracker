import { describe, expect, it } from "vitest";
import { emptyLedger } from "../src/core/ledger.js";
import { load, MemoryStore, restoreBackup, save, serializeBackup } from "../src/store/store.js";
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

describe("backup and restore", () => {
  const seeded = () => ({
    ...emptyLedger(),
    people: [{ id: "p:1", displayName: "Ada", aliases: ["Ada"] }],
    accounts: [{ id: "a:1", label: "RBC Chequing", fi: "rbc" as const, kind: "chequing" as const }],
  });

  it("round-trips the whole ledger through a file", () => {
    const before = seeded();
    const file = serializeBackup(before, "2026-09-03");
    const result = restoreBackup(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ledger.people).toHaveLength(1);
      expect(result.ledger.people[0]?.displayName).toBe("Ada");
      expect(result.ledger.accounts[0]?.label).toBe("RBC Chequing");
      expect(result.migrated).toHaveLength(0);
    }
  });

  it("stamps the file so it can be told apart from a stray JSON", () => {
    const file = serializeBackup(emptyLedger(), "2026-09-03");
    expect(JSON.parse(file).app).toBe("split-ledger");
    expect(JSON.parse(file).version).toBe(3);
  });

  it("upgrades an older backup on the way in, through the same migration path", () => {
    // A v2 file a user backed up before accounts grew a kind.
    const v2File = JSON.stringify({
      version: 2,
      savedOn: "2026-01-01",
      ledger: { ...emptyLedger(), accounts: [{ id: "a", label: "Scotia Visa", fi: "scotiabank" }] },
    });
    const result = restoreBackup(v2File);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migrated).toEqual(["2 -> 3"]);
      expect(result.ledger.accounts[0]?.kind).toBe("credit");
    }
  });

  it("refuses unreadable JSON without touching the live ledger", () => {
    const result = restoreBackup("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/readable JSON/i);
  });

  it("refuses a JSON that is not one of our backups", () => {
    const result = restoreBackup(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a Split Ledger backup/i);
  });

  it("refuses a backup from a newer build rather than mangling it", () => {
    const result = restoreBackup(JSON.stringify({ version: 99, savedOn: "x", ledger: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/version 99/i);
  });

  it("a saved ledger and a backup file describe the same thing", async () => {
    const store = new MemoryStore();
    const before = seeded();
    await save(store, before);
    const fromStore = await load(store);
    const fromFile = restoreBackup(serializeBackup(before, "2026-09-03"));
    expect(fromFile.ok).toBe(true);
    if (fromFile.ok) expect(fromFile.ledger).toEqual(fromStore.ledger);
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
    // Migrations compose: a v1 install upgrades all the way in one load.
    expect(steps).toEqual(["1 -> 2", "2 -> 3"]);
    expect(lostData).toBe(true);
    expect(data.version).toBe(3);
    expect(data.ledger.merchants["BLUE DOOR COFFEE"]?.name).toBe("Blue Door Coffee");
    expect(data.ledger.merchants["BLUE DOOR COFFEE"]?.categoryId).toBe("Coffee");
  });

  it("gives v2 accounts a kind inferred from their label", () => {
    const v2 = {
      version: 2 as const,
      savedOn: "2026-08-01",
      ledger: {
        ...emptyLedger(),
        accounts: [
          { id: "a", label: "RBC Chequing", fi: "rbc" },
          { id: "b", label: "Scotia Visa", fi: "scotiabank" },
          { id: "c", label: "TFSA Savings", fi: "generic" },
        ],
      },
    } as never;
    const { data, steps, lostData } = migrate(v2);
    expect(steps).toEqual(["2 -> 3"]);
    // Nothing is discarded going to v3 — only a field is added.
    expect(lostData).toBe(false);
    expect(data.ledger.accounts.map((a) => a.kind)).toEqual([
      "chequing",
      "credit",
      "savings",
    ]);
  });

  it("keeps a kind a v2 install somehow already had", () => {
    const v2 = {
      version: 2 as const,
      savedOn: "2026-08-01",
      ledger: {
        ...emptyLedger(),
        accounts: [{ id: "a", label: "Everyday Visa", fi: "rbc", kind: "savings" }],
      },
    } as never;
    expect(migrate(v2).data.ledger.accounts[0]?.kind).toBe("savings");
  });
});
