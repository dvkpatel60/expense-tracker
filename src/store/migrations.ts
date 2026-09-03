import { inferAccountKind } from "../core/accounts.js";
import { emptyLedger } from "../core/ledger.js";
import { CURRENT_VERSION } from "./schema.js";
import type { Persisted, PersistedV3 } from "./schema.js";

type Migration = (input: any) => any;

/**
 * Keyed by the version being migrated FROM. Running 1 -> current is composing
 * every step in between, so an old install upgrades in one load rather than
 * being silently discarded.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (v1) => ({
    version: 2,
    savedOn: new Date().toISOString().slice(0, 10),
    ledger: {
      ...emptyLedger(),
      // v1 stored a flat prototype shape with no accounts or people table. The
      // rows are not convertible without re-import, so the merchant cache is
      // carried across (it is the expensive part) and the rest is dropped.
      merchants: Object.fromEntries(
        Object.entries((v1.cache ?? {}) as Record<string, any>).map(([key, c]) => [
          key,
          {
            key,
            name: c?.name ?? key,
            note: c?.note,
            categoryId: c?.category,
            commonlyShared: c?.commonlyShared,
            retrievedOn: "1970-01-01",
          },
        ])
      ),
    },
  }),

  // Accounts predate the chequing/savings/credit distinction. The kind is
  // inferred from the label, which is a guess — but a stored guess the user can
  // correct beats refusing to load, and only net-worth rollups depend on it.
  2: (v2) => ({
    version: 3,
    savedOn: new Date().toISOString().slice(0, 10),
    ledger: {
      ...v2.ledger,
      accounts: (v2.ledger?.accounts ?? []).map((a: any) => ({
        ...a,
        kind: a.kind ?? inferAccountKind(String(a.label ?? ""), a.fi),
      })),
    },
  }),
};

export interface MigrationResult {
  readonly data: PersistedV3;
  readonly steps: readonly string[];
  readonly lostData: boolean;
}

export function migrate(input: Persisted): MigrationResult {
  let current: any = input;
  const steps: string[] = [];
  let lostData = false;

  while (current.version < CURRENT_VERSION) {
    const step = MIGRATIONS[current.version];
    if (!step) {
      throw new Error(`No migration from version ${current.version}`);
    }
    steps.push(`${current.version} -> ${current.version + 1}`);
    if (current.version === 1) lostData = true;
    current = step(current);
  }

  if (current.version > CURRENT_VERSION) {
    throw new Error(
      `Saved data is version ${current.version} but this build understands ${CURRENT_VERSION}. Upgrade before loading.`
    );
  }
  return { data: current as PersistedV3, steps, lostData };
}
