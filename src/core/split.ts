import { abs, add, allocate, allocateEven, cents, sub, sum, ZERO } from "./money.js";
import type { Cents } from "./money.js";
import type {
  Claim,
  ClaimDirection,
  ClaimId,
  PersonId,
  SplitResult,
  SplitSpec,
  Transaction,
} from "./types.js";

/**
 * The invariant this whole module exists to hold:
 *
 *   sum(claims) + myShare === abs(transaction.amount)
 *
 * Every strategy allocates through `allocate`, which is exact by construction.
 * Nothing here rounds independently, because two independent roundings is how
 * a split ends up a cent short.
 */

export class SplitError extends Error {}

export function computeSplit(tx: Transaction, spec: SplitSpec): SplitResult {
  const total = abs(tx.amount);
  const direction: ClaimDirection = tx.amount < 0 ? "they_owe_me" : "i_owe_them";

  const parts = allocateFor(total, spec);
  const mine = parts.myShare;

  const claims: Omit<Claim, "id" | "status" | "createdOn">[] = parts.shares
    .filter((s) => s.amount !== 0)
    .map((s) => ({
      transactionId: tx.id,
      personId: s.personId,
      amount: s.amount,
      direction,
      ...(spec.kind === "itemized" && s.memo ? { memo: s.memo } : {}),
    }));

  const check = add(sum(claims.map((c) => c.amount)), mine);
  if (check !== total) {
    throw new SplitError(
      `Split does not reconcile: parts sum to ${check} but the transaction is ${total}`
    );
  }
  return { claims, myShare: mine };
}

interface Share {
  personId: PersonId;
  amount: Cents;
  memo?: string;
}

function allocateFor(total: Cents, spec: SplitSpec): { shares: Share[]; myShare: Cents } {
  switch (spec.kind) {
    case "even": {
      const heads = spec.participants.length + (spec.includeMe ? 1 : 0);
      if (heads === 0) throw new SplitError("An even split needs at least one participant");
      const parts = allocateEven(total, heads);
      const shares = spec.participants.map((personId, i) => ({
        personId,
        amount: parts[i] ?? ZERO,
      }));
      const myShare = spec.includeMe ? parts[parts.length - 1] ?? ZERO : ZERO;
      return { shares, myShare };
    }

    case "percent": {
      const weights = [...spec.shares.map((s) => s.percent), spec.myPercent];
      const totalPct = weights.reduce((t, w) => t + w, 0);
      if (Math.abs(totalPct - 100) > 0.001) {
        throw new SplitError(`Percentages must total 100, got ${totalPct}`);
      }
      const parts = allocate(total, weights);
      const shares = spec.shares.map((s, i) => ({
        personId: s.personId,
        amount: parts[i] ?? ZERO,
      }));
      return { shares, myShare: parts[parts.length - 1] ?? ZERO };
    }

    case "amounts": {
      // Explicit amounts for others; whatever is left is mine. This is the
      // form that matches a receipt where you know what each person ordered.
      const assigned = sum(spec.shares.map((s) => s.amount));
      if (assigned > total) {
        throw new SplitError(
          `Assigned amounts (${assigned}) exceed the transaction (${total})`
        );
      }
      return {
        shares: spec.shares.map((s) => ({ personId: s.personId, amount: s.amount })),
        myShare: sub(total, assigned),
      };
    }

    case "itemized": {
      const itemTotal = sum(spec.items.map((i) => i.amount));
      if (itemTotal > total) {
        throw new SplitError(`Items (${itemTotal}) exceed the transaction (${total})`);
      }
      const byPerson = new Map<PersonId, number>();
      let mine = 0;
      for (const item of spec.items) {
        const heads = item.participants.length + (item.includeMe ? 1 : 0);
        if (heads === 0) throw new SplitError(`Item "${item.label}" has nobody on it`);
        const parts = allocateEven(item.amount, heads);
        item.participants.forEach((p, i) => {
          byPerson.set(p, (byPerson.get(p) ?? 0) + (parts[i] ?? 0));
        });
        if (item.includeMe) mine += parts[parts.length - 1] ?? 0;
      }
      // Tax, tip and anything not itemized ride on the shares already assigned.
      const unallocated = sub(total, itemTotal);
      if (unallocated !== 0) {
        const keys = [...byPerson.keys()];
        const weights = [...keys.map((k) => byPerson.get(k) ?? 0), mine];
        const spread = allocate(unallocated, weights);
        keys.forEach((k, i) => byPerson.set(k, (byPerson.get(k) ?? 0) + (spread[i] ?? 0)));
        mine += spread[spread.length - 1] ?? 0;
      }
      return {
        shares: [...byPerson.entries()].map(([personId, amount]) => ({
          personId,
          amount: cents(amount),
        })),
        myShare: cents(mine),
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Effective spend                                                     */
/* ------------------------------------------------------------------ */

/**
 * What the transaction actually cost you. Claims owed to you offset the spend;
 * claims you owe add to it. Void claims are ignored, settled ones are not —
 * a settled claim still means that money was never yours to spend.
 */
export function effectiveAmount(tx: Transaction, claims: readonly Claim[]): Cents {
  let total: number = tx.amount;
  for (const c of claims) {
    if (c.transactionId !== tx.id || c.status === "void") continue;
    total += c.direction === "they_owe_me" ? c.amount : -c.amount;
  }
  return cents(total);
}

/** Positive means they owe you. */
export function netPosition(personId: PersonId, claims: readonly Claim[]): Cents {
  let net = 0;
  for (const c of claims) {
    if (c.personId !== personId || c.status !== "open") continue;
    net += c.direction === "they_owe_me" ? c.amount : -c.amount;
  }
  return cents(net);
}

/* ------------------------------------------------------------------ */
/* Settlement                                                          */
/* ------------------------------------------------------------------ */

export interface SettlementProposal {
  readonly personId: PersonId;
  readonly claimIds: readonly ClaimId[];
  readonly netPosition: Cents;
  readonly incoming: Cents;
  /** Difference between the transfer and the net. Non-zero is not an error;
   *  people round, or pay part of what they owe. */
  readonly residual: Cents;
  readonly exact: boolean;
}

/**
 * A rotating-group ledger accumulates claims in both directions with the same
 * person. Sarah owes you $40 for dinner and you owe her $15 for the cab, so a
 * single $25 transfer closes both. Matching one claim at a time never finds
 * that, which is why proposals are built against the net position.
 */
export function proposeSettlement(
  personId: PersonId,
  incoming: Cents,
  claims: readonly Claim[],
  opts: { toleranceCents?: number } = {}
): SettlementProposal | null {
  const open = claims.filter((c) => c.personId === personId && c.status === "open");
  if (open.length === 0) return null;

  const net = netPosition(personId, claims);
  const residual = cents(net - Math.abs(incoming));
  const tolerance = opts.toleranceCents ?? 50;

  return {
    personId,
    claimIds: open.map((c) => c.id),
    netPosition: net,
    incoming: abs(incoming),
    residual,
    exact: Math.abs(residual) <= tolerance,
  };
}
