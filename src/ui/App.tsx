import { useMemo, useState } from "react";
import { TransactionSheet } from "./components/TransactionSheet.js";
import { monthLabel } from "./format.js";
import { SAMPLES } from "./samples.js";
import { useLedger } from "./useLedger.js";
import { Activity } from "./views/Activity.js";
import type { ActivityIntent } from "./views/Activity.js";
import { Accounts } from "./views/Accounts.js";
import { ImportView } from "./views/ImportView.js";
import { Overview } from "./views/Overview.js";
import { People } from "./views/People.js";

type View = "summary" | "activity" | "accounts" | "people" | "import";

const TITLES: Record<View, string> = {
  summary: "Overview",
  activity: "Activity",
  accounts: "Accounts",
  people: "People",
  import: "Import",
};

export function App() {
  const L = useLedger();
  const [view, setView] = useState<View>("summary");
  const [period, setPeriod] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [intent, setIntent] = useState<ActivityIntent | null>(null);

  const periods = useMemo(() => {
    const set = new Set(L.ledger.transactions.map((t) => t.date.slice(0, 7)));
    return [...set].sort().reverse();
  }, [L.ledger.transactions]);

  const openClaims = L.ledger.claims.filter((c) => c.status === "open").length;
  const openTx = L.ledger.transactions.find((t) => t.id === openId) ?? null;
  const empty = L.ledger.transactions.length === 0;

  const inPeriod = L.ledger.transactions.filter(
    (t) => period === null || t.date.startsWith(period)
  ).length;
  const accounts = L.ledger.accounts.length;
  const subtitle =
    view === "people"
      ? `${L.ledger.people.length} ${L.ledger.people.length === 1 ? "person" : "people"} · ${openClaims} open ${openClaims === 1 ? "claim" : "claims"}`
      : view === "accounts"
        ? `${accounts} ${accounts === 1 ? "account" : "accounts"} · ${period ? monthLabel(period) : "all imported months"}`
        : view === "import"
          ? `${accounts} ${accounts === 1 ? "account" : "accounts"} · ${L.ledger.transactions.length} transactions held`
          : `${inPeriod} transactions · ${accounts} ${accounts === 1 ? "account" : "accounts"} · ${period ? monthLabel(period) : "all time"}`;

  const goto = (v: View, i?: ActivityIntent): void => {
    setIntent(i ?? null);
    setView(v);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" aria-hidden="true" />
          Split Ledger
        </div>
        <nav className="nav" aria-label="Main">
          {(
            [
              ["summary", <IconOverview key="i" />, 0],
              ["activity", <IconActivity key="i" />, 0],
              ["accounts", <IconAccounts key="i" />, 0],
              ["people", <IconPeople key="i" />, openClaims],
              ["import", <IconImport key="i" />, 0],
            ] as const
          ).map(([id, icon, badge]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => goto(id)}
            >
              {icon}
              {TITLES[id]}
              {badge > 0 && <span className="badge">{badge}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <b>
            {L.ledger.accounts.length} account{L.ledger.accounts.length === 1 ? "" : "s"}
          </b>
          <br />
          Local-first. Your ledger never leaves this device.
        </div>
      </aside>

      <main className="main">
        {empty && view !== "import" ? (
          <div className="content">
            <Welcome onLoad={() => L.loadSamples(SAMPLES)} onImport={() => goto("import")} />
          </div>
        ) : (
          <>
            <header className="topbar">
              <div className="topbar-titles">
                <h1 className="view-title">{TITLES[view]}</h1>
                <p className="view-sub">{subtitle}</p>
              </div>
            </header>

            {(view === "summary" || view === "activity" || view === "accounts") && (
              <div className="filterbar">
                <span className="filter-label">Time period</span>
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
              </div>
            )}

            <div className="content">
              {L.status && (
                <div className="notice" style={{ marginBottom: "0.85rem" }} role="status">
                  {L.status} <button onClick={L.dismissStatus}>Dismiss</button>
                </div>
              )}

              {view === "summary" && <Overview L={L} period={period} onGoto={goto} />}
              {view === "activity" && (
                <Activity L={L} period={period} intent={intent} onOpen={setOpenId} />
              )}
              {view === "accounts" && <Accounts L={L} period={period} />}
              {view === "people" && <People L={L} onOpen={setOpenId} />}
              {view === "import" && <ImportView L={L} />}
            </div>
          </>
        )}
      </main>

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

/* 16px stroke icons, inline so the CSP stays image-source free. */

const icon = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function IconOverview() {
  return (
    <svg {...icon}>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg {...icon}>
      <path d="M2 4h12M2 8h12M2 12h8" />
    </svg>
  );
}

function IconAccounts() {
  return (
    <svg {...icon}>
      <rect x="2" y="5" width="12" height="8" rx="1.5" />
      <path d="M2 8h12" />
      <circle cx="11.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconPeople() {
  return (
    <svg {...icon}>
      <circle cx="5.5" cy="5" r="2.5" />
      <path d="M1.5 14c0-2.2 1.8-4 4-4s4 1.8 4 4" />
      <circle cx="11.5" cy="5.5" r="2" />
      <path d="M11 10.2c2 .2 3.5 1.9 3.5 3.8" />
    </svg>
  );
}

function IconImport() {
  return (
    <svg {...icon}>
      <path d="M8 1.5v8M4.8 6.5 8 9.7l3.2-3.2" />
      <path d="M2 11v2.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V11" transform="translate(0 -1)" />
    </svg>
  );
}
