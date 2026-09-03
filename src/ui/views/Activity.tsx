import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { effectiveAmount } from "../../core/split.js";
import {
  avgTransactionTotal,
  categoryTotals,
  periodTotals,
  splitSharePercent,
} from "../../core/ledger.js";
import { detectRecurring } from "../../core/recurring.js";
import type { CategoryId, Transaction } from "../../core/types.js";
import { categoryColor, dayLabel, dollarsAbs } from "../format.js";
import type { UseLedger } from "../useLedger.js";

export type Filter = "all" | "unsplit" | "split" | "transfers" | "review" | "recurring";

/** What another view wants Activity opened on: a kind of row, a category, or
 *  both. Real lifted state — it used to be a module-scope variable, which is
 *  the kind of thing that works until two navigations race. */
export interface ActivityIntent {
  readonly kind: Filter;
  readonly categoryId?: CategoryId;
}

const KIND_FILTERS: readonly (readonly [Filter, string])[] = [
  ["all", "All"],
  ["unsplit", "Not split"],
  ["split", "Split"],
  ["transfers", "e-Transfers"],
  ["review", "Needs a category"],
  ["recurring", "Recurring"],
];

export function Activity({
  L,
  period,
  intent,
  onOpen,
}: {
  L: UseLedger;
  period: string | null;
  intent: ActivityIntent | null;
  onOpen(id: string): void;
}) {
  const [filter, setFilter] = useState<Filter>(intent?.kind ?? "all");
  const [categories, setCategories] = useState<readonly CategoryId[]>(
    intent?.categoryId ? [intent.categoryId] : []
  );
  const [account, setAccount] = useState<string>("all");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // A one-line read on what this period was, so a row list is never the only
  // thing on the screen. Mirrors the KPIs on Overview but lives where users
  // are actually looking at rows.
  const summary = useMemo(() => {
    const totals = periodTotals(L.ledger, period);
    const categories = categoryTotals(L.ledger, period).slice(0, 3);
    return {
      totals,
      avg: avgTransactionTotal(L.ledger, period),
      split: splitSharePercent(L.ledger, period),
      top: categories,
    };
  }, [L.ledger, period]);

  const inPeriod = useMemo(
    () => L.ledger.transactions.filter((t) => period === null || t.date.startsWith(period)),
    [L.ledger.transactions, period]
  );

  // Only categories that actually occur are offered — a facet with nothing
  // behind it is a dead end dressed up as a choice.
  const presentCategories = useMemo(() => {
    const seen = new Map<CategoryId, number>();
    for (const t of inPeriod) seen.set(t.categoryId, (seen.get(t.categoryId) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [inPeriod]);

  const rows = useMemo(() => {
    let list = inPeriod;
    if (filter === "split")
      list = list.filter((t) => L.ledger.claims.some((c) => c.transactionId === t.id));
    if (filter === "unsplit")
      list = list.filter(
        (t) =>
          t.amount < 0 &&
          t.kind === "purchase" &&
          !t.transferPairId &&
          !L.ledger.claims.some((c) => c.transactionId === t.id)
      );
    if (filter === "transfers") list = list.filter((t) => t.kind.startsWith("etransfer"));
    if (filter === "review") list = list.filter((t) => t.categoryId === "Uncategorized");
    if (filter === "recurring") {
      const recurringKeys = new Set(detectRecurring(L.ledger, period).map((r) => r.merchantKey));
      list = list.filter((t) => recurringKeys.has(t.merchantKey));
    }
    if (categories.length > 0) list = list.filter((t) => categories.includes(t.categoryId));
    if (account !== "all") list = list.filter((t) => t.accountId === account);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((t) =>
        (t.merchantName + t.categoryId + t.rawDescription).toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [L.ledger.claims, inPeriod, filter, categories, account, query]);

  // Virtualized: a few years across five accounts is tens of thousands of rows,
  // and rendering them all is what makes a ledger feel slow.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 50,
    overscan: 8,
    // Seed a viewport so the first paint has rows before measurement lands.
    initialRect: { width: 960, height: 640 },
  });

  const toggleCategory = (id: CategoryId): void => {
    setCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  return (
    <>
      <div className="activity-summary" aria-label="Period summary">
        <div className="as-figure">
          <span className="as-label">Cash out</span>
          <span className="as-value num">{dollarsAbs(summary.totals.cashOut)}</span>
        </div>
        <div className="as-figure">
          <span className="as-label">Transactions</span>
          <span className="as-value num">{summary.totals.transactionCount}</span>
        </div>
        <div className="as-figure">
          <span className="as-label">Avg size</span>
          <span className="as-value num">{dollarsAbs(summary.avg)}</span>
        </div>
        {summary.split > 0 && (
          <div className="as-figure">
            <span className="as-label">Split with others</span>
            <span className="as-value num">{Math.round(summary.split * 100)}%</span>
          </div>
        )}
        {summary.top.length > 0 && (
          <div className="as-top">
            <span className="as-label">Top</span>
            <div className="as-chips">
              {summary.top.map((c) => (
                <button
                  key={c.categoryId}
                  className="filter cat"
                  style={{ "--chipc": categoryColor(c.categoryId) } as CSSProperties}
                  aria-pressed={categories.includes(c.categoryId)}
                  onClick={() => toggleCategory(c.categoryId)}
                >
                  <i />
                  {c.categoryId}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="facets">
        <div className="facet-row">
          <input
            className="search"
            placeholder="Search merchants, categories, raw descriptions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {L.ledger.accounts.length > 1 && (
            <select
              className="select-inline"
              aria-label="Account"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="all">All accounts</option>
              {L.ledger.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
          {KIND_FILTERS.map(([id, label]) => (
            <button
              key={id}
              className="filter"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="facet-row">
          {presentCategories.map((id) => (
            <button
              key={id}
              className="filter cat"
              style={{ "--chipc": categoryColor(id) } as CSSProperties}
              aria-pressed={categories.includes(id)}
              onClick={() => toggleCategory(id)}
            >
              <i />
              {id}
            </button>
          ))}
        </div>
      </div>

      <div className="table">
        <div className="thead" aria-hidden="true">
          <span>Date</span>
          <span>Merchant</span>
          <span>Category</span>
          <span>Account</span>
          <span className="r">Amount</span>
          <span className="r">Yours</span>
        </div>
        <div ref={scrollRef} className="tbody">
          {rows.length === 0 ? (
            <div className="table-empty">Nothing matches that.</div>
          ) : (
            <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
              {virtual.getVirtualItems().map((item) => {
                const tx = rows[item.index]!;
                return (
                  <div
                    key={tx.id}
                    ref={virtual.measureElement}
                    data-index={item.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <Row tx={tx} L={L} onOpen={onOpen} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Row({
  tx,
  L,
  onOpen,
}: {
  tx: Transaction;
  L: UseLedger;
  onOpen(id: string): void;
}) {
  const share = effectiveAmount(tx, L.ledger.claims);
  const isSplit = share !== tx.amount;
  const settled = L.ledger.settlements.some((s) => s.transactionId === tx.id);
  const unmatched = tx.kind === "etransfer_in" && !settled;
  const internal = Boolean(tx.transferPairId);
  const account = L.ledger.accounts.find((a) => a.id === tx.accountId);

  return (
    <button className="trow" onClick={() => onOpen(tx.id)}>
      <span className="trow-date">{dayLabel(tx.date)}</span>
      <span className="trow-merchant" title={tx.rawDescription}>
        {tx.merchantName}
        {unmatched && <span className="note">unmatched</span>}
      </span>
      <span className="trow-cat">
        <span className="chip" style={internal ? { color: "var(--ink-3)" } : undefined}>
          <i
            style={{
              background: internal ? "var(--cat-transfer)" : categoryColor(tx.categoryId),
            }}
          />
          {internal ? "Internal" : tx.categoryId}
        </span>
      </span>
      <span className="trow-account">{account?.label ?? ""}</span>
      <span className={`trow-amount${tx.amount > 0 ? " in" : ""}${internal ? " muted" : ""}`}>
        {tx.amount > 0 ? "+" : ""}
        {dollarsAbs(tx.amount)}
      </span>
      <span className={`trow-share${isSplit ? "" : " full"}`}>
        {isSplit ? `you ${dollarsAbs(share)}` : "·"}
      </span>
    </button>
  );
}
