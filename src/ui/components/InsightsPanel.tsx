import type { Insight } from "../../enrich/insights.js";
import { categoryColor } from "../format.js";
import type { ActivityIntent } from "../views/Activity.js";

type View = "summary" | "activity" | "people" | "import";

/**
 * The insight-kind renderer.
 *
 * Structured analysis, not a chat log: the model answers in typed insights the
 * UI renders natively, and any insight about one category is a link into
 * Activity filtered to it — analysis that cannot be acted on is trivia.
 *
 * This is only the rendering half. What gets asked, of which model, and in what
 * voice belongs to CopilotPanel; keeping them apart means a new workflow does
 * not touch the card layout and a new insight kind does not touch the controls.
 */
export function InsightsList({
  insights,
  onGoto,
}: {
  insights: readonly Insight[];
  onGoto(view: View, intent?: ActivityIntent): void;
}) {
  const headline = insights.find((i) => i.kind === "headline") ?? null;
  const summary = insights.find((i) => i.kind === "summary") ?? null;
  const actions = insights.filter((i) => i.kind === "action");
  const observed = insights.filter(
    (i) => i.kind !== "headline" && i.kind !== "summary" && i.kind !== "action"
  );

  if (insights.length === 0) {
    return <div className="insights-empty">The model had nothing notable to report.</div>;
  }

  return (
    <>
      {headline && <div className="headline">{headline.text}</div>}
      {/* Prose, not a card: the summary answers the question that was asked,
          and the cards below break it into things to act on. */}
      {summary && <p className="insight-summary">{summary.text}</p>}
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
    </>
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
