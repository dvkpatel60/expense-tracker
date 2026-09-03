/**
 * Money is integer cents, always. Split math on floats produces shares that
 * don't sum back to the total, and a ledger that is off by a cent is a ledger
 * nobody trusts. The brand stops raw numbers being passed in by accident.
 */
export type Cents = number & { readonly __brand: "Cents" };

export const ZERO = 0 as Cents;

export function cents(n: number): Cents {
  if (!Number.isFinite(n)) throw new RangeError(`Not a finite amount: ${n}`);
  if (!Number.isInteger(n)) throw new RangeError(`Cents must be whole: ${n}`);
  return n as Cents;
}

/** Parse the amount strings banks actually emit: "-1,240.00", "(45.10)", "$18.75". */
export function parseAmount(raw: unknown): Cents | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$\s,]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;

  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  const value = Number(whole) * 100 + Number(fracPadded || "0");
  if (!Number.isSafeInteger(value)) return null;
  return cents(negative ? -value : value);
}

export const add = (a: Cents, b: Cents): Cents => cents(a + b);
export const sub = (a: Cents, b: Cents): Cents => cents(a - b);
export const neg = (a: Cents): Cents => cents(-a);
export const abs = (a: Cents): Cents => cents(Math.abs(a));
export const sum = (xs: readonly Cents[]): Cents => cents(xs.reduce<number>((t, x) => t + x, 0));
export const isZero = (a: Cents): boolean => a === 0;

/**
 * Distribute `total` across `weights` so the parts sum to exactly `total`.
 * Largest-remainder: floor everything, then hand the leftover cents to the
 * parts with the biggest fractional loss. Ties break by index so the result is
 * deterministic and a re-render can't reshuffle who absorbs the extra cent.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new RangeError("Weights must be finite and non-negative");
  }
  const totalWeight = weights.reduce((t, w) => t + w, 0);
  if (totalWeight === 0) return allocate(total, weights.map(() => 1));

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const exact = weights.map((w) => (magnitude * w) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = magnitude - floors.reduce((t, x) => t + x, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (let k = 0; remainder > 0; k++, remainder--) {
    const slot = order[k % order.length];
    if (slot) out[slot.i] = (out[slot.i] ?? 0) + 1;
  }
  return out.map((x) => cents(sign * x));
}

/** Even split across n ways, exact to the cent. */
export const allocateEven = (total: Cents, n: number): Cents[] =>
  allocate(total, new Array(Math.max(0, Math.floor(n))).fill(1));

export function formatCents(a: Cents, opts: { sign?: boolean; currency?: boolean } = {}): string {
  const body = (Math.abs(a) / 100).toLocaleString("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = opts.sign ? (a < 0 ? "\u2212" : "+") : a < 0 ? "\u2212" : "";
  return `${prefix}${opts.currency ? "$" : ""}${body}`;
}
