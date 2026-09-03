import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TONE, workflowFor } from "../enrich/insights.js";
import type { AnalysisOptions, ToneId, WorkflowId } from "../enrich/insights.js";
import type { CategoryId } from "../core/types.js";
import type { UseLedger } from "./useLedger.js";

export interface UseCopilot {
  /** The question currently on screen — the last one actually asked. */
  workflow: WorkflowId;
  tone: ToneId;
  setTone(id: ToneId): void;
  /** Exactly what the next run will send. Nothing else crosses the wire. */
  asked: AnalysisOptions;
  run(workflow?: WorkflowId): Promise<void>;
}

/**
 * The copilot's own state: which question, in what voice, about what.
 *
 * Separate from useLedger, which owns the ledger and the request. Nothing here
 * is persisted — no transcript, no history, no chat. The one thing that
 * survives is the answer itself, cached against the question it answers,
 * exactly as the old analysis panel already cached against the digest.
 *
 * The question that is *asked* is the state, not the controls. A category
 * arrives from a pinned lens, and the reader closes that lens the moment they
 * start reading the answer; tracking the live selection instead would make the
 * answer disappear at exactly that point. Changing the tone likewise leaves the
 * current answer alone until the next run, rather than blanking the panel for a
 * question nobody has asked yet.
 */
export function useCopilot(
  L: UseLedger,
  period: string | null,
  focus: CategoryId | null
): UseCopilot {
  const [tone, setTone] = useState<ToneId>(DEFAULT_TONE);
  const [asked, setAsked] = useState<AnalysisOptions>({
    workflow: "explain",
    tone: DEFAULT_TONE,
  });
  const key = JSON.stringify(asked);

  // Surface the cached answer to this exact question without asking a model
  // anything. Held off while a run is in flight, so the peek cannot race the
  // answer it is about to find and blank it.
  useEffect(() => {
    if (L.insightsBusy) return;
    void L.peekInsights(period, JSON.parse(key) as AnalysisOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.peekInsights, L.insightsBusy, period, key]);

  const run = useCallback(
    async (which?: WorkflowId) => {
      const id = which ?? asked.workflow ?? "explain";
      const spec = workflowFor(id);
      // A category workflow with nothing in focus is an instruction the model
      // cannot follow; the server refuses it, so the UI does not send it.
      if (spec?.needsFocus && !focus) return;
      const next: AnalysisOptions = {
        workflow: id,
        tone,
        ...(spec?.needsFocus && focus ? { focus } : {}),
      };
      setAsked(next);
      await L.generateInsights(period, next);
    },
    [L, period, asked.workflow, tone, focus]
  );

  return { workflow: asked.workflow ?? "explain", tone, setTone, asked, run };
}
