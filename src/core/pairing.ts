import type { Transaction } from "./types.js";

export interface PairingOptions {
  /** Statements post on different days across FIs. Three days catches a card
   *  payment posting Friday on one side and Monday on the other. */
  readonly windowDays?: number;
}

const DAY = 86_400_000;
const dayNumber = (iso: string): number => Date.parse(iso + "T00:00:00Z") / DAY;

/**
 * Detect the same money appearing twice across accounts: a credit card payment
 * is a debit in chequing and a credit on the card. Unpaired, it double counts
 * and "Transfer" swallows the report. This is the highest-value cleanup step in
 * a multi-account ledger and the reason 3-5 accounts needs it and 1 does not.
 *
 * Deliberately conservative. It requires opposite sign, exactly equal
 * magnitude, different accounts, and a short window. A false pair silently
 * removes real spending from the report, which is worse than a missed pair the
 * user can flag by hand.
 */
export function pairInternalTransfers(
  transactions: readonly Transaction[],
  opts: PairingOptions = {}
): Transaction[] {
  const windowDays = opts.windowDays ?? 3;
  const out: Transaction[] = transactions.map((t) => {
    const { transferPairId: _drop, ...rest } = t;
    return rest as Transaction;
  });

  // Index by magnitude so this is not quadratic on a real ledger.
  const byMagnitude = new Map<number, number[]>();
  out.forEach((t, i) => {
    if (t.kind === "etransfer_in" || t.kind === "etransfer_out") return;
    const key = Math.abs(t.amount);
    const bucket = byMagnitude.get(key);
    if (bucket) bucket.push(i);
    else byMagnitude.set(key, [i]);
  });

  const claimed = new Set<number>();
  let counter = 0;

  for (const indices of byMagnitude.values()) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length; a++) {
      const i = indices[a]!;
      if (claimed.has(i)) continue;
      const left = out[i]!;
      for (let b = a + 1; b < indices.length; b++) {
        const j = indices[b]!;
        if (claimed.has(j)) continue;
        const right = out[j]!;
        if (left.accountId === right.accountId) continue;
        if (Math.sign(left.amount) === Math.sign(right.amount)) continue;
        if (Math.abs(dayNumber(left.date) - dayNumber(right.date)) > windowDays) continue;

        const pairId = `pair:${counter++}`;
        out[i] = { ...left, transferPairId: pairId, kind: "internal_transfer", categoryId: "Transfer" };
        out[j] = { ...right, transferPairId: pairId, kind: "internal_transfer", categoryId: "Transfer" };
        claimed.add(i);
        claimed.add(j);
        break;
      }
    }
  }
  return out;
}
