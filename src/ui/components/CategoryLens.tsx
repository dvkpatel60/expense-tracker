import { useEffect, useMemo, useRef, useState } from "react";
import { effectiveAmount } from "../../core/split.js";
import type { Claim, Transaction } from "../../core/types.js";
import { categoryColor, dayLabel, dollarsAbs } from "../format.js";

const PAGE = 5;

/**
 * Hover or focus a category and see what is actually in it, five at a time.
 *
 * The breakdown answers "how much" and immediately raises "on what" — this
 * answers it without spending a navigation, which is the whole point of a
 * lens rather than a link.
 *
 * Positioned fixed against the trigger's own rect rather than by nesting,
 * because the row it belongs to lives inside a panel that scrolls and clips.
 * Opens on focus as well as hover, so it is reachable from the keyboard, and
 * paging is real buttons so a long category is not truncated silently.
 */
export function CategoryLens({
  categoryId,
  transactions,
  claims,
  anchor,
  onClose,
}: {
  categoryId: string;
  transactions: readonly Transaction[];
  claims: readonly Claim[];
  anchor: DOMRect;
  onClose(): void;
}) {
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      transactions
        .filter((t) => t.categoryId === categoryId)
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    [transactions, categoryId]
  );

  // A new category under the cursor is a new list; page 3 of the old one is
  // meaningless against it.
  useEffect(() => {
    setPage(0);
  }, [categoryId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (rows.length === 0) return null;

  const pages = Math.ceil(rows.length / PAGE);
  const clamped = Math.min(page, pages - 1);
  const slice = rows.slice(clamped * PAGE, clamped * PAGE + PAGE);

  // Flip above the trigger when there is no room below, and keep the panel on
  // screen horizontally rather than letting it hang off the edge.
  const width = 320;
  const estimated = 96 + slice.length * 34;
  const below = anchor.bottom + 8;
  const top = below + estimated > window.innerHeight ? Math.max(8, anchor.top - estimated - 8) : below;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));

  return (
    <div ref={ref} className="lens" style={{ top, left, width }} role="dialog" aria-label={`Recent ${categoryId}`}>
      <div className="lens-head">
        <i className="lens-dot" style={{ background: categoryColor(categoryId) }} />
        <span className="lens-title">{categoryId}</span>
        <span className="lens-count">
          {rows.length} {rows.length === 1 ? "transaction" : "transactions"}
        </span>
      </div>

      <ul className="lens-list">
        {slice.map((t) => {
          const share = effectiveAmount(t, claims);
          return (
            <li key={t.id}>
              <span className="lens-date">{dayLabel(t.date)}</span>
              <span className="lens-merchant">{t.merchantName}</span>
              <span className="lens-amount num">{dollarsAbs(t.amount)}</span>
              {share !== t.amount && (
                <span className="lens-share num">you {dollarsAbs(share)}</span>
              )}
            </li>
          );
        })}
      </ul>

      {pages > 1 && (
        <div className="lens-pager">
          <button
            disabled={clamped === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Previous transactions"
          >
            &larr;
          </button>
          <span className="num">
            {clamped + 1} / {pages}
          </span>
          <button
            disabled={clamped >= pages - 1}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            aria-label="More transactions"
          >
            &rarr;
          </button>
        </div>
      )}
    </div>
  );
}
