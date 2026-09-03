import type { LedgerState } from "../core/ledger.js";

export const CURRENT_VERSION = 3;

/** What actually goes to disk. Versioned from day one, because a stored blob
 *  with no version is a blob you can never change the shape of. */
export interface PersistedV1 {
  readonly version: 1;
  readonly txs: unknown[];
  readonly claims: unknown[];
  readonly cache: Record<string, unknown>;
}

export interface PersistedV2 {
  readonly version: 2;
  readonly savedOn: string;
  readonly ledger: LedgerState;
}

/** v3 adds Account.kind. The shape is otherwise identical to v2, so the
 *  wrapper is the same and only the accounts inside it changed. */
export interface PersistedV3 {
  readonly version: 3;
  readonly savedOn: string;
  readonly ledger: LedgerState;
}

export type Persisted = PersistedV1 | PersistedV2 | PersistedV3;

export function isPersisted(value: unknown): value is Persisted {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof (value as { version: unknown }).version === "number"
  );
}
