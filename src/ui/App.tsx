import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  categoryTotals,
  needsAttention,
  periodTotals,
  personBalances,
  spendIn,
} from "../core/ledger.js";
import { cents } from "../core/money.js";
import { effectiveAmount } from "../core/split.js";
import { detectParser } from "../parsers/index.js";
import type { Transaction } from "../core/types.js";
import { ProportionBar, SpendChart } from "./components/SpendChart.js";
import { TransactionSheet } from "./components/TransactionSheet.js";
import { Money } from "./components/Money.js";
import { dayLabel, dollarsAbs, monthLabel, relativeDays } from "./format.js";
import { SAMPLES } from "./samples.js";
import { useLedger } from "./useLedger.js";

type View = "summary" | "activity" | "people" | "import";
type Filter = "all" | "unsplit" | "split" | "transfers" | "review";

export function App() {
  const L = useLedger();
  const [view, setView] = useState<View>("summary");
  const [period, setPeriod] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const periods = useMemo(() => {
    const set = new Set(L.ledger.transactions.map((t) => t.date.slice(0, 7)));
    return [...set].sort().reverse();
  }, [L.ledger.transactions]);

  const attention = useMemo(
    () => needsAttention(L.ledger, L.today),
    [L.ledger, L.today]
  );
  const openClaims = L.ledger.claims.filter((c) => c.status === "open").length;
  const openTx = L.ledger.transactions.find((t) => t.id === openId) ?? null;
  const empty = L.ledger.transactions.length === 0;

  return (
    <div className="shell">
      <main className="page">
        {empty && view !== "import" ? (
          <Welcome onLoad={() => L.loadSamples(SAMPLES)} onImport={() => setView("import")} />
        ) : (
          <>
            {view !== "import" && (
              <div className="topline">
                <span className="period">
                  <select
                    value={period ?? "all"}
                    onChange={(e) => setPeriod(e.target.value === "all" ? null : e.target.value)}
                    aria-label="Period"
                  >
                    <option value="all">All time</option>
                    {periods.map((p) => (
                      <option key={p} value={p}>
                        {monthLabel(p)}
                      </option>
                    ))}
                  </select>
                  <svg className="period-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 4.5 6 8l3-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="accounts">
                  {L.ledger.accounts.length} account{L.ledger.accounts.length === 1 ? "" : "s"}
                </span>
              </div>
            )}

            {view === "summary" && (
              <Summary
                L={L}
                period={period}
                attention={attention}
                onGoto={(v, f) => {
                  setView(v);
                  if (f) setFilterHint(f);
                }}
              />
            )}
            {view === "activity" && (
              <Activity L={L} period={period} onOpen={setOpenId} hint={filterHint} />
            )}
            {view === "people" && <People L={L} onOpen={setOpenId} />}
            {view === "import" && <Import L={L} />}
          </>
        )}
      </main>

      <nav className="tabbar">
        {(
          [
            ["summary", "Summary", 0],
            ["activity", "Activity", 0],
            ["people", "People", openClaims],
            ["import", "Import", 0],
          ] as const
        ).map(([id, label, badge]) => (
          <button
            key={id}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
            {badge > 0 && <span className="badge">{badge}</span>}
          </button>
        ))}
      </nav>

      {openTx && (
        <TransactionSheet
          tx={openTx}
          claims={L.ledger.claims}
          people={L.ledger.people}
          onClose={() => setOpenId(null)}
          onCategory={(c, all) => L.recategorize(openTx.id, c, all)}
          onSplit={(spec) => {
            L.split(openTx.id, spec);
            setOpenId(null);
          }}
          onUnsplit={() => L.unsplit(openTx.id)}
          onReconcile={() => {
            L.reconcile(openTx.id);
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}

// Module-scope hint so a tap on an attention row lands on the right filter.
let filterHint: Filter = "all";
const setFilterHint = (f: Filter) => {
  filterHint = f;
};

/* ---------------------------------------------------------------- */

function Welcome({ onLoad, onImport }: { onLoad(): void; onImport(): void }) {
  return (
    <div className="empty">
      <h2>Nothing here yet</h2>
      <p>
        Bring in a CSV from RBC, Scotiabank or Wealthsimple and it will be categorized,
        de-duplicated and ready to split.
      </p>
      <div className="btn-stack" style={{ maxWidth: 320, margin: "0 auto" }}>
        <button className="btn" onClick={onImport}>
          Add an export
        </button>
        <button className="btn secondary" onClick={onLoad}>
          Try it with sample data
        </button>
      </div>
    </div>
  );
}

function Summary({
  L,
  period,
  attention,
  onGoto,
}: {
  L: ReturnType<typeof useLedger>;
  period: string | null;
  attention: ReturnType<typeof needsAttention>;
  onGoto(view: View, filter?: Filter): void;
}) {
  const totals = periodTotals(L.ledger, period);
  const categories = categoryTotals(L.ledger, period);
  const spend = spendIn(L.ledger, period);
  const max = categories[0]?.cashOut ?? cents(1);

  return (
    <>
      <div className="hero-label">You spent</div>
      <Money className="hero-value" value={cents(Math.abs(totals.yourShare))} />
      <div className="hero-note">
        {totals.recovered !== 0 ? (
          <>
            <span className="swatch" />
            <b>{dollarsAbs(totals.recovered)}</b> of the{" "}
            {dollarsAbs(totals.cashOut)} that left your accounts is other people&rsquo;s
          </>
        ) : (
          <>
            {dollarsAbs(totals.cashOut)} left your accounts across{" "}
            {totals.transactionCount} transactions
          </>
        )}
      </div>

      <SpendChart transactions={spend} claims={L.ledger.claims} />

      {attention.length > 0 && (
        <section className="section">
          <h2 className="section-title">Needs a look</h2>
          <div className="card attention">
            {attention.map((item) => (
              <button
                className="row"
                key={item.kind}
                onClick={() => {
                  if (item.kind === "unidentified_merchant") void L.identifyMerchants();
                  else if (item.kind === "unmatched_transfer") onGoto("activity", "transfers");
                  else onGoto("people");
                }}
              >
                <span className="dot" />
                <div className="row-body">
                  <div className="row-title">
                    {item.count}{" "}
                    {item.kind === "unidentified_merchant"
                      ? item.count === 1
                        ? "merchant unrecognized"
                        : "merchants unrecognized"
                      : item.kind === "stale_claim"
                        ? item.count === 1
                          ? "claim waiting"
                          : "claims waiting"
                        : item.count === 1
                          ? "transfer unmatched"
                          : "transfers unmatched"}
                  </div>
                  <div className="row-sub">{item.detail}</div>
                </div>
                <span className="pill">
                  {item.kind === "unidentified_merchant"
                    ? L.busy
                      ? "Working"
                      : "Identify"
                    : "Review"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="section-title">Where it went</h2>
        <div className="card">
          {categories.map((c) => (
            <div className="row" key={c.categoryId} style={{ display: "block" }}>
              <div style={{ display: "flex", gap: "0.9rem", alignItems: "baseline" }}>
                <div className="row-body">
                  <div className="row-title">{c.categoryId}</div>
                </div>
                <div className="row-amount">
                  <span className="primary">{dollarsAbs(c.yourShare)}</span>
                </div>
              </div>
              <ProportionBar share={c.yourShare} cash={c.cashOut} />
              {c.yourShare < c.cashOut && (
                <div className="row-sub" style={{ marginTop: "0.4rem" }}>
                  {dollarsAbs(c.cashOut)} paid, {dollarsAbs(cents(c.cashOut - c.yourShare))} covered by others
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {L.status && <div className="notice">{L.status}</div>}
    </>
  );
}

/* ---------------------------------------------------------------- */

function Activity({
  L,
  period,
  onOpen,
  hint,
}: {
  L: ReturnType<typeof useLedger>;
  period: string | null;
  onOpen(id: string): void;
  hint: Filter;
}) {
  const [filter, setFilter] = useState<Filter>(hint);
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    let list = L.ledger.transactions.filter(
      (t) => period === null || t.date.startsWith(period)
    );
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
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((t) =>
        (t.merchantName + t.categoryId + t.rawDescription).toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [L.ledger, period, filter, query]);

  // Virtualized: a few years across five accounts is tens of thousands of rows,
  // and rendering them all is what makes a ledger feel slow.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68,
    overscan: 8,
    // Seed a viewport so the first paint has rows before measurement lands.
    initialRect: { width: 480, height: 640 },
  });

  return (
    <>
      <input
        className="search"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="filters">
        {(
          [
            ["all", "All"],
            ["unsplit", "Not split"],
            ["split", "Split"],
            ["transfers", "e-Transfers"],
            ["review", "Needs a category"],
          ] as const
        ).map(([id, label]) => (
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

      <div ref={scrollRef} className="card" style={{ maxHeight: "62vh", overflowY: "auto" }}>
        {rows.length === 0 ? (
          <div className="row">
            <div className="row-body">
              <div className="row-sub">Nothing matches that.</div>
            </div>
          </div>
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
    </>
  );
}

function Row({
  tx,
  L,
  onOpen,
}: {
  tx: Transaction;
  L: ReturnType<typeof useLedger>;
  onOpen(id: string): void;
}) {
  const share = effectiveAmount(tx, L.ledger.claims);
  const isSplit = share !== tx.amount;
  const settled = L.ledger.settlements.some((s) => s.transactionId === tx.id);
  const unmatched = tx.kind === "etransfer_in" && !settled;

  return (
    <button className="row" onClick={() => onOpen(tx.id)}>
      <div className="row-body">
        <div className="row-title">{tx.merchantName}</div>
        <div className="row-sub">
          {dayLabel(tx.date)} · {tx.transferPairId ? "Between your accounts" : tx.categoryId}
          {unmatched ? " · unmatched" : ""}
        </div>
      </div>
      <div className={`row-amount${tx.transferPairId ? " muted" : ""}`}>
        <span className="primary">
          {tx.amount > 0 ? "+" : ""}
          {dollarsAbs(tx.amount)}
        </span>
        {isSplit && <span className="secondary">you {dollarsAbs(share)}</span>}
      </div>
    </button>
  );
}

/* ---------------------------------------------------------------- */

function People({
  L,
  onOpen,
}: {
  L: ReturnType<typeof useLedger>;
  onOpen(id: string): void;
}) {
  const balances = personBalances(L.ledger);
  if (balances.length === 0) {
    return (
      <div className="empty">
        <h2>No one yet</h2>
        <p>Split a transaction or import an e-transfer and people will show up here.</p>
      </div>
    );
  }

  return (
    <>
      <h2 className="section-title">Balances</h2>
      <div className="card">
        {balances.map((b) => (
          <div className="row" key={b.person.id} style={{ display: "block" }}>
            <div style={{ display: "flex", gap: "0.9rem", alignItems: "baseline" }}>
              <div className="row-body">
                <div className="row-title">{b.person.displayName}</div>
                <div className="row-sub">
                  {b.net === 0
                    ? "Settled up"
                    : b.net > 0
                      ? `Owes you · oldest ${relativeDays(b.oldestOpenOn ?? L.today, L.today)} days`
                      : `You owe · oldest ${relativeDays(b.oldestOpenOn ?? L.today, L.today)} days`}
                  {b.person.aliases.length > 1 && ` · also seen as ${b.person.aliases[0]}`}
                </div>
              </div>
              <div className="row-amount">
                <span
                  className="primary"
                  style={{ color: b.net > 0 ? "var(--positive)" : undefined }}
                >
                  {b.net === 0 ? "\u2014" : dollarsAbs(b.net)}
                </span>
              </div>
            </div>
            {b.openClaims.length > 0 && (
              <div className="row-sub" style={{ marginTop: "0.5rem" }}>
                {b.openClaims.map((c) => {
                  const tx = L.ledger.transactions.find((t) => t.id === c.transactionId);
                  return (
                    <button
                      key={c.id}
                      onClick={() => tx && onOpen(tx.id)}
                      style={{
                        display: "flex",
                        width: "100%",
                        gap: "0.5rem",
                        padding: "0.2rem 0",
                        color: "var(--ink-2)",
                      }}
                    >
                      <span>{tx?.merchantName ?? "Transaction"}</span>
                      <span style={{ marginLeft: "auto" }}>
                        {c.direction === "they_owe_me" ? "+" : "\u2212"}
                        {dollarsAbs(c.amount)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="fine">
        One transfer settles a whole balance. If someone owes you for dinner and you owe
        them for a fare, the difference is what needs to move.
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- */

function Import({ L }: { L: ReturnType<typeof useLedger> }) {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const detected = text.trim() ? detectParser(text) : null;

  function readFile(file: File) {
    if (!label) setLabel(file.name.replace(/\.csv$/i, ""));
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result));
    reader.readAsText(file);
  }

  return (
    <>
      <h2 className="section-title">Add an export</h2>
      <div className="dropzone">
        <p>A CSV from RBC, Scotiabank, Wealthsimple, or anything with a date and an amount.</p>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Choose a file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readFile(f);
          }}
        />
      </div>

      <textarea
        className="paste"
        placeholder="or paste the contents"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {detected && (
        <div className="detected">
          Looks like <b>{detected.parser.label}</b>
          {detected.confidence < 0.5 && ", though not confidently"}.
        </div>
      )}

      <input
        className="search"
        style={{ marginTop: "0.75rem" }}
        placeholder="Name this account"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      <div className="btn-stack">
        <button
          className="btn"
          disabled={!text.trim() || !label.trim()}
          onClick={() => {
            if (L.importText(text, label.trim())) {
              setText("");
              setLabel("");
            }
          }}
        >
          Import
        </button>
        <button className="btn secondary" onClick={() => L.loadSamples(SAMPLES)}>
          Load sample data
        </button>
      </div>

      {L.status && <div className="notice">{L.status}</div>}

      {L.ledger.accounts.length > 0 && (
        <section className="section">
          <h2 className="section-title">Accounts</h2>
          <div className="card">
            {L.ledger.accounts.map((a) => (
              <div className="row" key={a.id}>
                <div className="row-body">
                  <div className="row-title">{a.label}</div>
                  <div className="row-sub">{a.fi}</div>
                </div>
                <div className="row-amount">
                  <span className="primary">
                    {L.ledger.transactions.filter((t) => t.accountId === a.id).length}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <MerchantLookup L={L} />

      <p className="fine">
        Everything stays on this device. Re-importing an overlapping date range is safe —
        rows are fingerprinted, so duplicates are skipped. When merchants are identified,
        only the cleaned-up merchant names are sent. Amounts, dates, balances, account
        numbers and people&rsquo;s names never are.
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- */

/**
 * Provider and model picker. Built from what the deployment reports rather than
 * from a list compiled into the bundle, so configuring a key is the only step
 * needed to make a provider appear here.
 */
function MerchantLookup({ L }: { L: ReturnType<typeof useLedger> }) {
  const usable = L.providers.filter((p) => p.configured);
  const active = usable.find((p) => p.id === L.enrichment?.provider) ?? null;

  return (
    <section className="section">
      <h2 className="section-title">Merchant identification</h2>

      {usable.length === 0 ? (
        <div className="card">
          <div className="row">
            <div className="row-body">
              <div className="row-title">Not configured</div>
              <div className="row-sub">
                {L.providers.length === 0
                  ? "No lookup service is available in this build."
                  : `Set ${L.providers.map((p) => p.envVar).join(" or ")} to enable it.`}{" "}
                Every local rule still runs without it.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="field-label">Provider</div>
          <select
            className="select"
            aria-label="Provider"
            value={L.enrichment?.provider ?? ""}
            onChange={(e) => L.chooseProvider(e.target.value)}
          >
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          <div className="field-label" style={{ marginTop: "0.9rem" }}>
            Model
          </div>
          <select
            className="select"
            aria-label="Model"
            value={L.enrichment?.model ?? ""}
            onChange={(e) => L.chooseModel(e.target.value)}
          >
            {(active?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` — ${m.note}` : ""}
              </option>
            ))}
          </select>

          <div className="btn-stack">
            <button
              className="btn secondary"
              disabled={L.busy || L.ledger.transactions.length === 0}
              onClick={() => void L.identifyMerchants()}
            >
              {L.busy ? "Identifying…" : "Identify merchants"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
