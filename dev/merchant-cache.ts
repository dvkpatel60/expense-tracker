import Database from "better-sqlite3";
import type { MerchantFacts } from "../src/core/types.js";

/**
 * In-memory merchant cache for the local dev server.
 *
 * The browser already caches facts in the ledger, but that cache dies with a
 * hard reload and is per-device. While iterating locally you reload constantly,
 * and every reload otherwise re-buys the same merchant identifications. This
 * sits in front of the provider for the life of the dev process.
 *
 * `:memory:` deliberately: nothing here is worth persisting, and a file would
 * be one more thing to gitignore and invalidate. It is also why this is a
 * devDependency — the deployed functions are per-request and would get no
 * benefit from a cache that dies with the instance, and better-sqlite3 is a
 * native module that would need special handling to bundle for Netlify.
 */
export interface MerchantCache {
  get(keys: readonly string[]): { hits: MerchantFacts[]; misses: string[] };
  put(facts: readonly MerchantFacts[]): void;
  size(): number;
}

export function createMerchantCache(): MerchantCache {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant (
      key             TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      note            TEXT,
      category_id     TEXT,
      commonly_shared INTEGER,
      retrieved_on    TEXT NOT NULL
    );
  `);

  const selectOne = db.prepare<[string]>("SELECT * FROM merchant WHERE key = ?");
  const upsert = db.prepare(`
    INSERT INTO merchant (key, name, note, category_id, commonly_shared, retrieved_on)
    VALUES (@key, @name, @note, @categoryId, @commonlyShared, @retrievedOn)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      note = excluded.note,
      category_id = excluded.category_id,
      commonly_shared = excluded.commonly_shared,
      retrieved_on = excluded.retrieved_on
  `);
  const count = db.prepare("SELECT COUNT(*) AS n FROM merchant");

  interface Row {
    key: string;
    name: string;
    note: string | null;
    category_id: string | null;
    commonly_shared: number | null;
    retrieved_on: string;
  }

  const toFacts = (r: Row): MerchantFacts => ({
    key: r.key,
    name: r.name,
    // Optional properties are omitted rather than set to undefined, because
    // exactOptionalPropertyTypes is on across this project.
    ...(r.note ? { note: r.note } : {}),
    ...(r.category_id ? { categoryId: r.category_id } : {}),
    ...(r.commonly_shared === null ? {} : { commonlyShared: r.commonly_shared === 1 }),
    retrievedOn: r.retrieved_on,
  });

  const putMany = db.transaction((facts: readonly MerchantFacts[]) => {
    for (const f of facts) {
      upsert.run({
        key: f.key,
        name: f.name,
        note: f.note ?? null,
        categoryId: f.categoryId ?? null,
        commonlyShared: f.commonlyShared === undefined ? null : f.commonlyShared ? 1 : 0,
        retrievedOn: f.retrievedOn,
      });
    }
  });

  return {
    get(keys) {
      const hits: MerchantFacts[] = [];
      const misses: string[] = [];
      for (const key of keys) {
        const row = selectOne.get(key) as Row | undefined;
        if (row) hits.push(toFacts(row));
        else misses.push(key);
      }
      return { hits, misses };
    },
    put(facts) {
      if (facts.length > 0) putMany(facts);
    },
    size() {
      return (count.get() as { n: number }).n;
    },
  };
}
