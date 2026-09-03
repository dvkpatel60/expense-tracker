import { MAX_OUTPUT_TOKENS } from "../../enrich/providers.js";
import type { UseLedger } from "../useLedger.js";

/**
 * Which model answers, and whether it can.
 *
 * Built entirely from what /api/providers reports, so a provider appears here
 * exactly when its key is set on the deployment and disappears when it is
 * removed — there is no second list to keep in step. The env var NAME is shown
 * for anything unconfigured, because that is the one thing an operator needs to
 * be told; the value never leaves the server (see enrich/providers.ts).
 *
 * One choice serves both features that talk to a model: merchant
 * identification and the copilot.
 */
export function ModelPicker({ L, compact = false }: { L: UseLedger; compact?: boolean }) {
  const usable = L.providers.filter((p) => p.configured);
  const active = usable.find((p) => p.id === L.enrichment?.provider) ?? null;

  if (L.providers.length === 0) {
    return <p className="picker-note">Checking what this deployment can do…</p>;
  }

  return (
    <div className={compact ? "model-picker compact" : "model-picker"}>
      <span className="field-label">Provider</span>
      <div
        className="provider-rows"
        role="radiogroup"
        // Only a choice when there is something to choose between. With no key
        // set this is a status list, and calling it "Provider" would promise a
        // control that is not there.
        aria-label={usable.length > 0 ? "Provider" : "Provider status"}
      >
        {L.providers.map((p) => {
          const on = active?.id === p.id;
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={on}
              disabled={!p.configured}
              className={on ? "provider-row on" : "provider-row"}
              onClick={() => L.chooseProvider(p.id)}
            >
              <span className="provider-name">{p.label}</span>
              <span className={p.configured ? "provider-state on" : "provider-state"}>
                {p.configured ? "key set" : `${p.envVar} not set`}
              </span>
              <span className="provider-models num">{p.models.length}</span>
            </button>
          );
        })}
      </div>

      {active && (
        <label className="field">
          Model
          <select
            aria-label="Model"
            value={L.enrichment?.model ?? ""}
            onChange={(e) => L.chooseModel(e.target.value)}
          >
            {active.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` — ${m.note}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* The ceiling is shared with merchant identification and is not a knob:
          a budget under the batch cap truncates the JSON mid-array. Stating it
          is honest about what a run can cost. */}
      <p className="picker-note">
        Up to <span className="num">{MAX_OUTPUT_TOKENS.toLocaleString("en-CA")}</span> output
        tokens per run.
      </p>
    </div>
  );
}
