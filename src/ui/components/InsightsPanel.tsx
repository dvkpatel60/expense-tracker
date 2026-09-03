import type { Insight } from "../../enrich/insights.js";
import { categoryColor } from "../format.js";
import type { UseLedger } from "../useLedger.js";
import type { ActivityIntent } from "../views/Activity.js";

type View = "summary" | "activity" | "people" | "import";

/**
 * Structured analysis, not a chat box. The model answers in typed insights the
 * UI renders natively, and any insight about one category is a link into
 * Activity filtered to it — analysis that cannot be acted on is trivia.
 *
 * Nothing here fires without a click, answers are remembered per digest, and
 * only the aggregates digest ever leaves the device (see core/digest.ts).
 */
export function InsightsPanel({
  L,
  period,
  onGoto,
}: {
  L: UseLedger;
  period: string | null;
  onGoto(view: View, intent?: ActivityIntent): void;
}) {
  const direct = import.meta.env.VITE_ENRICH_MODE === "direct";
  const configured = direct || L.enrichment !== null;
  const headline = L.insights?.find((i) => i.kind === "headline") ?? null;
  const actions = (L.insights ?? []).filter((i) => i.kind === "action");
  const observed = (L.insights ?? []).filter(
    (i) => i.kind !== "headline" && i.kind !== "action"
  );

  return (
    <section className="panel insights-panel">
      <div className="insights-head">
        <h2 className="panel-title">
          <span className="spark" aria-hidden="true">✦</span>
          Analysis
          {L.insights && L.insights.length > 0 && (
            <span className="insights-count">{L.insights.length}</span>
          )}
        </h2>
        <button
          className="btn-primary"
          disabled={!configured || L.insightsBusy || L.ledger.transactions.length === 0}
          onClick={() => void L.generateInsights(period)}
        >
          {L.insightsBusy ? "Analyzing…" : L.insights ? "Refresh" : "Analyze"}
        </button>
      </div>

      {!configured ? (
        <div className="insights-empty">
          Analysis needs an AI provider. Set{" "}
          {L.providers.map((p) => p.envVar).join(" or ") || "an API key"} on the deployment and
          it appears here — the rest of the app doesn&rsquo;t need it.
        </div>
      ) : L.insights === null ? (
        <div className="insights-empty">
          One click gets a structured read on this period: what moved, what looks unusual, and
          what it costs you specifically — not what left your accounts.
        </div>
      ) : (
        <>
          {headline && <div className="headline">{headline.text}</div>}
          {actions.length > 0 && (
            <div className="insight-group">
              <span className="eyebrow">Needs action</span>
              {actions.map((insight, i) => (
                <InsightRow key={i} insight={insight} onGoto={onGoto} />
              ))}
            </div>
          )}
          {observed.length > 0 && (
            <div className="insight-group">
              <span className="eyebrow">Observed</span>
              {observed.map((insight, i) => (
                <InsightRow key={i} insight={insight} onGoto={onGoto} />
              ))}
            </div>
          )}
          {L.insights.length === 0 && (
            <div className="insights-empty">The model had nothing notable to report.</div>
          )}
        </>
      )}

      <p className="privacy-note">
        Only category and merchant totals leave this device — never individual transactions,
        dates, balances, accounts or names.
      </p>
    </section>
  );
}

function InsightRow({
  insight,
  onGoto,
}: {
  insight: Insight;
  onGoto(view: View, intent?: ActivityIntent): void;
}) {
  const tags = (
    <span className="insight-tags">
      <i className={`insight-dot ${insight.kind}`} aria-hidden="true" />
      <span className="insight-kind">{insight.kind}</span>
      {insight.categoryId && (
        <span className="chip">
          <i style={{ background: categoryColor(insight.categoryId) }} />
          {insight.categoryId}
        </span>
      )}
    </span>
  );

  if (!insight.categoryId) {
    return (
      <div className="insight">
        {tags}
        {insight.text}
      </div>
    );
  }
  return (
    <button
      className="insight"
      onClick={() => onGoto("activity", { kind: "all", categoryId: insight.categoryId! })}
    >
      {tags}
      {insight.text}
      <span className="insight-link">Show these transactions &rarr;</span>
    </button>
  );
}
