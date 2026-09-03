import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GroupId } from "../../core/categorize.js";
import type { SpendCategory, SpendGroup } from "../../core/ledger.js";
import type { Cents } from "../../core/money.js";
import { effectiveAmount } from "../../core/split.js";
import type { CategoryId, Claim, Transaction } from "../../core/types.js";
import { categoryColor, dayLabel, dollarsAbs, groupColor } from "../format.js";

const PREVIEW = 5;
const TOP_MERCHANTS = 3;

/**
 * What the lens is looking at. Built from the same buildSpendTree pass that
 * feeds the ring and the ranked list, so the lens can never quote a figure the
 * panel behind it disagrees with — the reason the tree exists at all.
 */
export interface LensTarget {
  readonly kind: "category" | "group";
  readonly id: string;
  readonly label: string;
  /** The reading level this sits in; a group is its own context. */
  readonly context: GroupId;
  readonly color: string;
  readonly yourShare: Cents;
  readonly cashOut: Cents;
  readonly transactionCount: number;
  readonly merchantTotals: Readonly<Record<string, Cents>>;
  /** Which categories a transaction must be in to belong here. */
  readonly categoryIds: readonly CategoryId[];
}

export function lensTargetForCategory(c: SpendCategory): LensTarget {
  return {
    kind: "category",
    id: c.categoryId,
    label: c.categoryId,
    context: c.groupId,
    color: categoryColor(c.categoryId),
    yourShare: c.yourShare,
    cashOut: c.cashOut,
    transactionCount: c.transactionCount,
    merchantTotals: c.merchantTotals,
    categoryIds: [c.categoryId],
  };
}

export function lensTargetForGroup(g: SpendGroup): LensTarget {
  // Merchant totals are per category in the tree; a group is the union, and a
  // merchant that appears under two categories is one merchant to the reader.
  const merchantTotals: Record<string, number> = {};
  for (const c of g.categories) {
    for (const [key, val] of Object.entries(c.merchantTotals)) {
      merchantTotals[key] = (merchantTotals[key] ?? 0) + val;
    }
  }
  return {
    kind: "group",
    id: g.groupId,
    label: g.groupId,
    context: g.groupId,
    color: groupColor(g.groupId),
    yourShare: g.yourShare,
    cashOut: g.cashOut,
    transactionCount: g.transactionCount,
    merchantTotals: merchantTotals as Readonly<Record<string, Cents>>,
    categoryIds: g.categories.map((c) => c.categoryId),
  };
}

/**
 * Hover or focus a slice, a ring key or a ranked row and see what is actually
 * inside it — the split, the merchants that drive it, and the transactions.
 *
 * The breakdown answers "how much" and immediately raises "on what"; this
 * answers it without spending a navigation, which is the whole point of a lens
 * rather than a link.
 *
 * Two modes, because one panel cannot be both. Unhovered it is a tooltip:
 * pointer-events: none, so the pointer can leave the row without the panel
 * eating the mouse-out that closes it, and nothing inside it is interactive —
 * the old pager rendered buttons inside a pointer-events: none box, so they
 * could never be clicked and automation saw a panel intercepting the page.
 * Pinned (click the row) it is a real dialog: interactive, scrollable, in the
 * tab order, dismissed with Escape or a click outside.
 *
 * Positioned fixed against the trigger's own rect rather than by nesting,
 * because the row it belongs to lives inside a panel that scrolls and clips.
 */
export function CategoryLens({
  target,
  transactions,
  claims,
  anchor,
  pinned,
  onClose,
  onOpenTransaction,
  onOpenActivity,
  onAnalyze,
}: {
  target: LensTarget;
  transactions: readonly Transaction[];
  claims: readonly Claim[];
  anchor: DOMRect;
  /** Pinned lenses hold the pointer and the keyboard; hovered ones never do. */
  pinned: boolean;
  onClose(): void;
  onOpenTransaction(id: string): void;
  onOpenActivity(): void;
  /** Present only for a pinned category: asks the copilot about this one
   *  category. Sends its id, never its transactions. */
  onAnalyze?(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);

  const inScope = useMemo(() => new Set<string>(target.categoryIds), [target.categoryIds]);
  const rows = useMemo(
    () =>
      transactions
        .filter((t) => inScope.has(t.categoryId))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [transactions, inScope]
  );

  // Merchant keys are normalized strings; the reader wants the name they saw on
  // the statement, so the display name comes off the transactions themselves.
  const merchants = useMemo(() => {
    const names = new Map<string, string>();
    for (const t of rows) if (!names.has(t.merchantKey)) names.set(t.merchantKey, t.merchantName);
    return Object.entries(target.merchantTotals)
      .map(([key, total]) => ({ key, total, name: names.get(key) ?? key }))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_MERCHANTS);
  }, [target.merchantTotals, rows]);

  // A new target under the cursor is a new list; a cursor into the old one is
  // meaningless against it.
  useEffect(() => {
    setCursor(0);
  }, [target.id]);

  // Pinning is a deliberate act, so focus follows it and comes back to whatever
  // opened it. Without this, Tab from a pinned row walks on to the next
  // category instead of into the panel that just appeared.
  //
  // Only on an in-place dismissal, though. When the lens hands off to the
  // drawer or to Activity, that destination takes the focus; sending it back to
  // the row re-opened the hovered lens on top of the thing the reader had just
  // asked for.
  const returnTo = useRef<Element | null>(null);
  const handedOff = useRef(false);
  useEffect(() => {
    if (!pinned) return;
    returnTo.current = document.activeElement;
    ref.current?.focus();
    return () => {
      if (!handedOff.current && returnTo.current instanceof HTMLElement) {
        returnTo.current.focus();
      }
    };
  }, [pinned]);

  const handOff = (go: () => void): void => {
    handedOff.current = true;
    go();
  };

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Capture, so a click that lands on another row pins that one instead of
    // being swallowed by this one closing first.
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [pinned, onClose]);

  // Escape closes a hovered lens too, but only that: no click handling, since a
  // hovered lens is not on the page as far as the pointer is concerned.
  useEffect(() => {
    if (pinned) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned, onClose]);

  const onListKey = useCallback(
    (e: ReactKeyboardEvent<HTMLUListElement>): void => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      const el = ref.current?.querySelectorAll<HTMLButtonElement>(".lens-row")[next];
      el?.focus();
    },
    [cursor, rows.length]
  );

  if (rows.length === 0) return null;

  const listed = pinned ? rows : rows.slice(0, PREVIEW);
  const hidden = rows.length - listed.length;
  const mine = target.cashOut === 0 ? 1 : target.yourShare / target.cashOut;
  const recovered = (target.cashOut - target.yourShare) as Cents;

  // Flip above the trigger when there is no room below, and keep the panel on
  // screen horizontally rather than letting it hang off the edge.
  //
  // The estimate decides *placement* only. It used to cap the height as well,
  // and being an estimate it under-counted: the panel came out shorter than its
  // content, and because the box is a flex column the last child was squeezed
  // under the one above it rather than scrolling. The cap is the viewport now,
  // which cannot be wrong about how much room there is.
  const width = 340;
  const estimated = 200 + listed.length * 32 + merchants.length * 24;
  const ceiling = Math.round(window.innerHeight * 0.7);
  const placed = Math.min(estimated, ceiling);
  const below = anchor.bottom + 8;
  const top = below + placed > window.innerHeight ? Math.max(8, anchor.top - placed - 8) : below;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));

  return (
    <div
      ref={ref}
      className={pinned ? "lens pinned" : "lens"}
      style={{ top, left, width, maxHeight: `${ceiling}px` }}
      role={pinned ? "dialog" : "tooltip"}
      aria-label={`${target.label} breakdown`}
      {...(pinned ? { tabIndex: -1 } : { "aria-hidden": true })}
    >
      <div className="lens-head">
        <i className="lens-dot" style={{ background: target.color }} />
        <span className="lens-title">{target.label}</span>
        {target.kind === "category" && <span className="lens-context">{target.context}</span>}
        {pinned && (
          <button className="lens-close" onClick={onClose} aria-label="Close breakdown">
            &times;
          </button>
        )}
      </div>

      <div className="lens-figures">
        <div className="lens-fig">
          <span className="lens-fig-label">Your share</span>
          <span className="lens-fig-value num">{dollarsAbs(target.yourShare)}</span>
        </div>
        <div className="lens-fig">
          <span className="lens-fig-label">Cash out</span>
          <span className="lens-fig-value num">{dollarsAbs(target.cashOut)}</span>
        </div>
        <div className="lens-fig">
          <span className="lens-fig-label">Purchases</span>
          <span className="lens-fig-value num">{target.transactionCount}</span>
        </div>
      </div>

      {/* The solid run is your share of what left the account; the rest came
          back from other people. Same encoding as the ranked list's bar. */}
      <div className="lens-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(2, Math.min(100, mine * 100))}%`, background: target.color }} />
      </div>
      <p className="lens-note">
        {recovered > 0 ? (
          <>
            <span className="num">{dollarsAbs(recovered)}</span> of this was covered by other people
          </>
        ) : (
          <>all of this was yours</>
        )}
      </p>

      {merchants.length > 0 && (
        <ul className="lens-merchants">
          {merchants.map((m) => (
            <li key={m.key}>
              <span className="lens-merchant">{m.name}</span>
              <span className="num">{dollarsAbs(m.total as Cents)}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="lens-list" onKeyDown={pinned ? onListKey : undefined}>
        {listed.map((t, i) => {
          const share = effectiveAmount(t, claims);
          const body = (
            <>
              <span className="lens-date">{dayLabel(t.date)}</span>
              <span className="lens-merchant">{t.merchantName}</span>
              <span className="lens-amount num">{dollarsAbs(t.amount)}</span>
              {share !== t.amount && <span className="lens-share num">you {dollarsAbs(share)}</span>}
            </>
          );
          return (
            <li key={t.id}>
              {pinned ? (
                <button
                  className="lens-row"
                  tabIndex={i === cursor ? 0 : -1}
                  onFocus={() => setCursor(i)}
                  onClick={() => handOff(() => onOpenTransaction(t.id))}
                >
                  {body}
                </button>
              ) : (
                <span className="lens-row">{body}</span>
              )}
            </li>
          );
        })}
      </ul>

      {pinned ? (
        <div className="lens-actions">
          {onAnalyze && (
            <button className="lens-analyze" onClick={onAnalyze}>
              <span className="spark" aria-hidden="true">✦</span> Analyze this category
            </button>
          )}
          <button className="lens-all" onClick={() => handOff(onOpenActivity)}>
            See all {rows.length} in Activity &rarr;
          </button>
        </div>
      ) : (
        <p className="lens-hint">
          {hidden > 0 ? `${hidden} more — click to pin` : "Click to pin"}
        </p>
      )}
    </div>
  );
}
