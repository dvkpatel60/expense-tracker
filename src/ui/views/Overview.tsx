import { useEffect } from "react";
import type { ReactNode } from "react";
import { categoryTotals, needsAttention, periodTotals, spendIn } from "../../core/ledger.js";
import { previousPeriod } from "../../core/digest.js";
import { cents } from "../../core/money.js";
import type { Cents } from "../../core/money.js";
import { InsightsPanel } from "../components/InsightsPanel.js";
import { ProportionBar, SpendChart } from "../components/SpendChart.js";
import { Money } from "../components/Money.js";
import { categoryColor, dollarsAbs, monthLabel } from "../format.js";
import type { UseLedger } from "../useLedger.js";
import type { ActivityIntent } from "./Activity.js";

type View = "summary" | "activity" | "people" | "import";

export function Overview({
  L,
  period,
  onGoto,
}: {
  L: UseLedger;
  period: string | null;
  onGoto(view: View, intent?: ActivityIntent): void;
}) {
  const totals = periodTotals(L.ledger, period);
  const previous = period === null ? null : periodTotals(L.ledger, previousPeriod(period));
  const categories = categoryTotals(L.ledger, period);
  const spend = spendIn(L.ledger, period);
  const attention = needsAttention(L.ledger, L.today);

  // Surface a cached analysis for this period without asking a model anything.
  useEffect(() => {
    void L.peekInsights(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.peekInsights, period]);

  return (
    <div className="overview">
      <div className="ov-main">
        <div className="kpi-grid">
          <Kpi
            hero
            label="Your spend"
            value={cents(Math.abs(totals.yourShare))}
            sub={delta(totals.yourShare, previous?.yourShare, period)}
          />
          <Kpi
            label="Cash out"
            value={cents(Math.abs(totals.cashOut))}
            sub={<>{totals.transactionCount} transactions left your accounts</>}
          />
          <Kpi
            label="Recovered"
            value={cents(Math.abs(totals.recovered))}
            sub={
              totals.recovered !== 0 ? (
                <>covered by other people, not you</>
              ) : (
                <>nothing outstanding is covered by others</>
              )
            }
          />
        </div>

        <section className="panel">
          <h2 className="panel-title">Cumulative spend</h2>
          <SpendChart transactions={spend} claims={L.ledger.claims} />
        </section>

        <section className="panel">
          <h2 className="panel-title">Where it went</h2>
          {categories.map((c) => (
            <button
              className="cat-row"
              key={c.categoryId}
              onClick={() => onGoto("activity", { kind: "all", categoryId: c.categoryId })}
            >
              <span className="cat-head">
                <i className="cat-swatch" style={{ background: categoryColor(c.categoryId) }} />
                <span className="cat-name">{c.categoryId}</span>
                <span className="cat-count">{c.transactionCount}×</span>
                <span className="cat-amounts">
                  <span className="num">{dollarsAbs(c.yourShare)}</span>
                  {c.yourShare < c.cashOut && (
                    <span className="cash num">of {dollarsAbs(c.cashOut)} paid</span>
                  )}
                </span>
              </span>
              <ProportionBar share={c.yourShare} cash={c.cashOut} />
            </button>
          ))}
          {categories.length === 0 && (
            <div className="insights-empty">No spending in {period ? monthLabel(period) : "this range"}.</div>
          )}
        </section>
      </div>

      <div className="ov-rail">
        <InsightsPanel L={L} period={period} onGoto={onGoto} />

        {attention.length > 0 && (
          <section className="panel attention">
            <h2 className="panel-title">Needs a look</h2>
            {attention.map((item) => (
              <button
                className="row"
                key={item.kind}
                onClick={() => {
                  if (item.kind === "unidentified_merchant") void L.identifyMerchants();
                  else if (item.kind === "unmatched_transfer") onGoto("activity", { kind: "transfers" });
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
                <span className="pill act">
                  {item.kind === "unidentified_merchant"
                    ? L.busy
                      ? "Working"
                      : "Identify"
                    : "Review"}
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  hero = false,
}: {
  label: string;
  value: Cents;
  sub: ReactNode;
  hero?: boolean;
}) {
  return (
    <div className={hero ? "kpi hero-kpi" : "kpi"}>
      <div className="kpi-label">{label}</div>
      <Money className="kpi-value" value={value} />
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

/** Spend deltas read in the direction of the wallet: up costs you, down is
 *  relief — colored accordingly, not by sign convention. */
function delta(
  current: Cents,
  prior: Cents | undefined,
  period: string | null
): ReactNode {
  if (period === null || prior === undefined) return <>across every imported month</>;
  const diff = Math.abs(current) - Math.abs(prior);
  if (prior === 0) return <>no spend recorded in {monthLabel(previousPeriod(period))}</>;
  if (diff === 0) return <>level with last month</>;
  return (
    <span className={diff > 0 ? "delta-up" : "delta-down"}>
      {diff > 0 ? "▲" : "▼"} <span className="num">{dollarsAbs(cents(diff))}</span> vs last month
    </span>
  );
}
