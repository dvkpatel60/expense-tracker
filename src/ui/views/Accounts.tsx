import { ACCOUNT_KIND_LABEL, isAsset, utilisation } from "../../core/accounts.js";
import { balanceSheet } from "../../core/statement.js";
import type { AccountStatement } from "../../core/statement.js";
import { dollars, dollarsAbs, monthLabel } from "../format.js";
import type { UseLedger } from "../useLedger.js";

export function Accounts({ L, period }: { L: UseLedger; period: string | null }) {
  const sheet = balanceSheet(L.ledger, period);

  if (sheet.accounts.length === 0) {
    return (
      <div className="empty">
        <h2>No accounts yet</h2>
        <p>Import an export and the account it came from will be tracked here.</p>
      </div>
    );
  }

  return (
    <>
      <BalanceSheetPanel L={L} period={period} />

      <div className="people-grid" style={{ marginTop: "0.85rem" }}>
        {sheet.accounts.map((s) => (
          <AccountCard key={s.account.id} statement={s} />
        ))}
      </div>
    </>
  );
}

/**
 * Assets, liabilities and what is left. Reusable on Overview, where it answers
 * the question the spend report cannot: not what this month cost, but where it
 * left you.
 */
export function BalanceSheetPanel({ L, period }: { L: UseLedger; period: string | null }) {
  const sheet = balanceSheet(L.ledger, period);
  const delta = sheet.netWorthDelta;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Balance sheet</h2>
        <p className="panel-sub">
          {period ? `Closing position, ${monthLabel(period)}` : "Closing position across every imported month"}
        </p>
      </div>

      <div className="sheet-figures">
        <div>
          <span className="eyebrow">Assets</span>
          <span className="sheet-figure num">{dollarsAbs(sheet.assets)}</span>
        </div>
        <div>
          <span className="eyebrow">Liabilities</span>
          <span className="sheet-figure num owing">{dollarsAbs(sheet.liabilities)}</span>
        </div>
        <div>
          <span className="eyebrow">Net worth</span>
          <span className="sheet-figure num strong">{dollars(sheet.netWorth)}</span>
          {delta !== null && delta !== 0 && (
            <span className={`sheet-delta ${delta > 0 ? "up" : "down"}`}>
              {delta > 0 ? "▲" : "▼"} <span className="num">{dollarsAbs(delta)}</span> on last month
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function AccountCard({ statement: s }: { statement: AccountStatement }) {
  const used = utilisation(s.account, s.closing);

  return (
    <section className="panel">
      <div className="person-head">
        <div>
          <div className="person-name">{s.account.label}</div>
          <div className="person-sub">
            {ACCOUNT_KIND_LABEL[s.account.kind]} · {s.account.fi} · {s.transactionCount}{" "}
            {s.transactionCount === 1 ? "transaction" : "transactions"}
          </div>
        </div>
        <span className={`bal-net ${isAsset(s.account.kind) ? "owed" : "owing"}`}>
          {dollarsAbs(s.closing)}
        </span>
      </div>

      {used !== null && (
        <div style={{ marginTop: "0.75rem" }}>
          <div className="util-head">
            <span>{Math.round(used * 100)}% of limit used</span>
            <span className="num">{dollarsAbs(s.account.creditLimit!)}</span>
          </div>
          <div className="bar">
            <i style={{ width: "100%" }}>
              <b
                style={{
                  width: `${Math.min(100, used * 100)}%`,
                  background: used > 0.7 ? "var(--red)" : "var(--accent)",
                }}
              />
            </i>
          </div>
        </div>
      )}

      <dl className="statement">
        <div>
          <dt>Opening</dt>
          <dd className="num">{dollarsAbs(s.opening)}</dd>
        </div>
        <div>
          <dt>In</dt>
          <dd className="num in">{dollarsAbs(s.inflows)}</dd>
        </div>
        <div>
          <dt>Out</dt>
          <dd className="num">{dollarsAbs(s.outflows)}</dd>
        </div>
        <div>
          <dt>Closing</dt>
          <dd className="num strong">{dollarsAbs(s.closing)}</dd>
        </div>
      </dl>

      {!s.balanceReported && (
        <p className="fine" style={{ marginTop: "0.6rem" }}>
          This export carried no balance column, so these are totalled from the
          transactions rather than reported by the bank.
        </p>
      )}
    </section>
  );
}
