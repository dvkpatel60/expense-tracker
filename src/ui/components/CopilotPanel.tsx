import { useState } from "react";
import { TONES, WORKFLOWS } from "../../enrich/insights.js";
import type { CategoryId } from "../../core/types.js";
import type { UseCopilot } from "../useCopilot.js";
import type { UseLedger } from "../useLedger.js";
import type { ActivityIntent } from "../views/Activity.js";
import { InsightsList } from "./InsightsPanel.js";
import { ModelPicker } from "./ModelPicker.js";

type View = "summary" | "activity" | "people" | "import";

/**
 * The Analysis rail as a copilot: predefined questions, not a chat box.
 *
 * Free-form chat would be the obvious thing to build and the wrong one. The
 * privacy boundary is a shape (core/digest.ts), and a text box is an invitation
 * to type a name, an account or a date into it. Workflows keep the wire
 * identical to what it has always carried — the aggregates digest — and change
 * only which part of it the model is told to look at. Nothing here can widen
 * that boundary, because none of it is data.
 *
 * Nothing fires without a click, answers are remembered per question, and no
 * transcript is stored.
 */
export function CopilotPanel({
  L,
  copilot,
  focus,
  onGoto,
}: {
  L: UseLedger;
  /** Owned by Overview: the pinned lens drives the same copilot this panel
   *  does, and two components sharing state is when it moves up. */
  copilot: UseCopilot;
  /** The category the reader has pinned, if any. Only workflows that are about
   *  one category ever send it. */
  focus: CategoryId | null;
  onGoto(view: View, intent?: ActivityIntent): void;
}) {
  const [showSettings, setShowSettings] = useState(false);

  const direct = import.meta.env.VITE_ENRICH_MODE === "direct";
  const configured = direct || L.enrichment !== null;
  const empty = L.ledger.transactions.length === 0;

  return (
    <section className="panel copilot">
      <div className="insights-head">
        <h2 className="panel-title">
          <span className="spark" aria-hidden="true">✦</span>
          Analysis
          {L.insights && L.insights.length > 0 && (
            <span className="insights-count">{L.insights.length}</span>
          )}
        </h2>
        <button
          className="copilot-settings-toggle"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((v) => !v)}
        >
          {showSettings ? "Hide setup" : "Setup"}
        </button>
      </div>

      {showSettings && (
        <div className="copilot-setup">
          <ModelPicker L={L} compact />
          <span className="field-label">Tone</span>
          <div className="tone-row" role="radiogroup" aria-label="Tone">
            {TONES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={copilot.tone === t.id}
                className={copilot.tone === t.id ? "tone on" : "tone"}
                onClick={() => copilot.setTone(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!configured ? (
        <div className="insights-empty">
          Analysis needs an AI provider. Set{" "}
          {L.providers.map((p) => p.envVar).join(" or ") || "an API key"} on the deployment and
          the workflows below light up — the rest of the app doesn&rsquo;t need it.
        </div>
      ) : (
        <>
          <div className="workflows">
            {WORKFLOWS.map((w) => {
              const blocked = Boolean(w.needsFocus) && focus === null;
              return (
                <button
                  key={w.id}
                  className={copilot.workflow === w.id ? "workflow on" : "workflow"}
                  disabled={blocked || L.insightsBusy || empty}
                  onClick={() => void copilot.run(w.id)}
                >
                  <span className="workflow-label">
                    {w.id === "category" && focus ? `Summarize ${focus}` : w.label}
                  </span>
                  <span className="workflow-hint">
                    {blocked ? "Pin a category first" : w.hint}
                  </span>
                </button>
              );
            })}
          </div>

          {L.insightsBusy ? (
            <div className="insights-empty">Analyzing…</div>
          ) : L.insights === null ? (
            <div className="insights-empty">
              {empty
                ? "Import a statement and the copilot has something to read."
                : "Pick a question above. Answers are kept per question, so revisiting one is free."}
            </div>
          ) : (
            <InsightsList insights={L.insights} onGoto={onGoto} />
          )}
        </>
      )}

      {/* What actually leaves the device, stated where the button is rather
          than in a settings page nobody opens. */}
      <p className="privacy-note">
        Only category and merchant totals leave this device — never individual transactions,
        dates, balances, accounts or names. A workflow changes the question, never the data.
      </p>
    </section>
  );
}
