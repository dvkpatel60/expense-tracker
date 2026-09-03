import { emptyLedger } from "../core/ledger.js";
import type { LedgerState } from "../core/ledger.js";
import { migrate } from "./migrations.js";
import { CURRENT_VERSION, isPersisted } from "./schema.js";
import type { Persisted, PersistedV3 } from "./schema.js";

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
    const h = hydrate(parsed);
    return {
      ledger: h.ledger,
      migrated: h.migrated,
      warning: h.lostData
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

/** The one place a persisted blob becomes a live ledger: migrate it forward,
 *  then fill any field a still-older shape lacked. Both load() (from storage)
 *  and restoreBackup() (from a file the user hands us) go through here, so a
 *  backup can never carry a shape the app itself would refuse. Throws on a
 *  version from a newer build, exactly as migrate() does. */
function hydrate(parsed: Persisted): {
  ledger: LedgerState;
  migrated: readonly string[];
  lostData: boolean;
} {
  const { data, steps, lostData } = migrate(parsed);
  return { ledger: { ...emptyLedger(), ...data.ledger }, migrated: steps, lostData };
}

export async function save(store: KeyValueStore, ledger: LedgerState): Promise<void> {
  const payload: PersistedV3 = {
    version: CURRENT_VERSION,
    savedOn: new Date().toISOString().slice(0, 10),
    ledger,
  };
  await store.set(KEY, JSON.stringify(payload));
}

/** A backup file is exactly what we persist — the same versioned wrapper — so a
 *  restore is just a load from somewhere other than localStorage, and the whole
 *  migration chain protects it for free. Pretty-printed because a human holds
 *  this file, and stamped with `app` so a stray JSON can be told apart from
 *  ours before we try to read it. */
export function serializeBackup(ledger: LedgerState, savedOn: string): string {
  const payload: PersistedV3 & { app: "split-ledger" } = {
    app: "split-ledger",
    version: CURRENT_VERSION,
    savedOn,
    ledger,
  };
  return JSON.stringify(payload, null, 2);
}

export type RestoreResult =
  | {
      readonly ok: true;
      readonly ledger: LedgerState;
      readonly migrated: readonly string[];
      readonly lostData: boolean;
    }
  | { readonly ok: false; readonly error: string };

/** Read a backup file back into a ledger. Unlike load(), a failure here never
 *  substitutes an empty ledger — the caller still has the user's live data and
 *  must not lose it to a mistyped paste, so restore reports the problem and
 *  changes nothing. Success goes through the same hydrate() path as load, so an
 *  older backup upgrades on the way in. */
export function restoreBackup(raw: string): RestoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "That file is not readable JSON." };
  }
  if (!isPersisted(parsed)) {
    return { ok: false, error: "That file is not a Split Ledger backup." };
  }
  try {
    const h = hydrate(parsed);
    return { ok: true, ledger: h.ledger, migrated: h.migrated, lostData: h.lostData };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "That backup could not be restored." };
  }
}
