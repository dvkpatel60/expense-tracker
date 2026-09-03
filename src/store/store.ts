import { emptyLedger } from "../core/ledger.js";
import type { LedgerState } from "../core/ledger.js";
import { migrate } from "./migrations.js";
import { CURRENT_VERSION, isPersisted } from "./schema.js";
import type { PersistedV2 } from "./schema.js";

/** Storage is an interface so the core never imports a browser global and the
 *  tests never need a DOM. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const KEY = "split-ledger";

export interface LoadResult {
  readonly ledger: LedgerState;
  readonly migrated: readonly string[];
  readonly warning: string | null;
}

export async function load(store: KeyValueStore): Promise<LoadResult> {
  let raw: string | null;
  try {
    raw = await store.get(KEY);
  } catch {
    return { ledger: emptyLedger(), migrated: [], warning: "Storage is unavailable. Working in memory only." };
  }
  if (!raw) return { ledger: emptyLedger(), migrated: [], warning: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ledger: emptyLedger(), migrated: [], warning: "Saved data was unreadable and has been left untouched." };
  }
  if (!isPersisted(parsed)) {
    return { ledger: emptyLedger(), migrated: [], warning: "Saved data has no version and cannot be loaded safely." };
  }

  try {
    const { data, steps, lostData } = migrate(parsed);
    return {
      ledger: { ...emptyLedger(), ...data.ledger },
      migrated: steps,
      warning: lostData
        ? "Upgraded from an older format. Merchant lookups were kept; transactions need re-importing."
        : null,
    };
  } catch (e) {
    return {
      ledger: emptyLedger(),
      migrated: [],
      warning: e instanceof Error ? e.message : "Could not migrate saved data.",
    };
  }
}

export async function save(store: KeyValueStore, ledger: LedgerState): Promise<void> {
  const payload: PersistedV2 = {
    version: CURRENT_VERSION,
    savedOn: new Date().toISOString().slice(0, 10),
    ledger,
  };
  await store.set(KEY, JSON.stringify(payload));
}
