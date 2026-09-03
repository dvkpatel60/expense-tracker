import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyMerchantFacts,
  applySplit,
  clearSplit,
  editAccount as editAccountTransition,
  emptyLedger,
  exportCsv as exportCsvTransition,
  importRows,
  mergePeople as mergePeopleTransition,
  setCategory,
  settle,
  systemClock,
  unmergePerson as unmergePersonTransition,
} from "../core/ledger.js";
import type { AccountPatch, ExportOptions, ImportReport, LedgerState } from "../core/ledger.js";
import { parseStatement } from "../parsers/index.js";
import { load, save } from "../store/store.js";
import { browserStore } from "./storage.js";
import { enrichMerchants } from "../enrich/enricher.js";
import { directTransport, requestInsightsDirect } from "../enrich/direct.js";
import { fetchProviders, proxyTransport, requestInsights } from "../enrich/proxy.js";
import { coerceInsights } from "../enrich/insights.js";
import type { Insight } from "../enrich/insights.js";
import { buildInsightsDigest } from "../core/digest.js";
import { PROVIDERS, describeProviders } from "../enrich/providers.js";
import type { ProviderAvailability } from "../enrich/providers.js";
// Aliased: the hook already exposes `reconcile` for settling a transaction.
import { loadSettings, reconcile as reconcileSettings, saveSettings } from "./settings.js";
import type { EnrichmentSettings } from "./settings.js";
import type {
  Account,
  AccountKind,
  CategoryId,
  FiId,
  SplitSpec,
  TransactionId,
} from "../core/types.js";

const clock = systemClock();

export interface UseLedger {
  ledger: LedgerState;
  ready: boolean;
  status: string | null;
  busy: boolean;
  today: string;
  /** What this deployment can ask. Empty until /api/providers answers. */
  providers: readonly ProviderAvailability[];
  /** Null when nothing is configured — the app then runs on local rules only. */
  enrichment: EnrichmentSettings | null;
  chooseProvider(provider: string): void;
  chooseModel(model: string): void;
  importText(text: string, label: string, kind: AccountKind, fi?: FiId): ImportReport | null;
  /** Edit an account's label, kind, credit limit or opening balance. */
  editAccount(accountId: string, patch: AccountPatch): void;
  /** Serialize the ledger to CSV per the given options. */
  exportData(options: ExportOptions): string;
  /** Merge one person's claims, settlements and transactions into another. */
  mergePeople(keepId: string, mergeId: string): string | null;
  /** Move selected claims off a person into a new one named by an alias. */
  unmergePerson(personId: string, alias: string, claimIds: readonly string[]): string | null;
  loadSamples(
    samples: readonly { label: string; fi: FiId; kind: AccountKind; text: string }[]
  ): void;
  recategorize(id: TransactionId, category: CategoryId, applyToMerchant: boolean): void;
  split(id: TransactionId, spec: SplitSpec): void;
  unsplit(id: TransactionId): void;
  reconcile(id: TransactionId): void;
  identifyMerchants(): Promise<void>;
  /** Structured AI analysis of the current period; null until generated. */
  insights: readonly Insight[] | null;
  insightsBusy: boolean;
  generateInsights(period: string | null): Promise<void>;
  /** Show a cached analysis for this period if one exists; never calls a model. */
  peekInsights(period: string | null): Promise<void>;
  reset(): void;
  dismissStatus(): void;
}

export function useLedger(): UseLedger {
  const [ledger, setLedger] = useState<LedgerState>(emptyLedger);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<readonly ProviderAvailability[]>([]);
  const [enrichment, setEnrichment] = useState<EnrichmentSettings | null>(null);
  const [insights, setInsights] = useState<readonly Insight[] | null>(null);
  const [insightsBusy, setInsightsBusy] = useState(false);
  const store = useRef(browserStore());
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  useEffect(() => {
    let live = true;
    void load(store.current).then((r) => {
      if (!live) return;
      setLedger(r.ledger);
      if (r.warning) setStatus(r.warning);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // Ask the deployment what it can do, then reconcile the stored choice against
  // it. The single-file build has no function behind it, so its catalogue is
  // whatever was compiled in and nothing is reported as configured.
  useEffect(() => {
    let live = true;
    const discover = async (): Promise<void> => {
      const available =
        import.meta.env.VITE_ENRICH_MODE === "direct"
          ? describeProviders(() => false)
          : await fetchProviders();
      const stored = await loadSettings(store.current);
      if (!live) return;
      setProviders(available);
      setEnrichment(reconcileSettings(stored, available));
    };
    void discover();
    return () => {
      live = false;
    };
  }, []);

  // Debounced so a burst of edits writes once.
  useEffect(() => {
    if (!ready) return;
    const handle = setTimeout(() => {
      void save(store.current, ledger).catch(() => {
        setStatus("Could not save. Your work is still here but will not survive a reload.");
      });
    }, 500);
    return () => clearTimeout(handle);
  }, [ledger, ready]);

  const importText = useCallback(
    (text: string, label: string, kind: AccountKind, fi?: FiId): ImportReport | null => {
      const parsed = fi ? parseStatement(text, fi) : parseStatement(text);
      if (parsed.rows.length === 0) {
        setStatus(
          parsed.rejected[0]?.reason ??
            "No transactions found. Check that the file has a date and an amount column."
        );
        return null;
      }
      const account: Account = { id: `acct:${label}`, label, fi: parsed.fi, kind };
      const result = importRows(ledger, parsed.rows, account, clock);
      setLedger(result.state);

      const bits = [`Added ${result.report.imported} transactions from ${label}.`];
      if (result.report.duplicates > 0)
        bits.push(`Skipped ${result.report.duplicates} already imported.`);
      if (result.report.pairsFound > 0)
        bits.push(
          `Matched ${result.report.pairsFound} transfer${result.report.pairsFound > 1 ? "s" : ""} between your accounts.`
        );
      if (parsed.rejected.length > 0)
        bits.push(`${parsed.rejected.length} rows could not be read.`);
      setStatus(bits.join(" "));
      return result.report;
    },
    [ledger]
  );

  const loadSamples = useCallback(
    (samples: readonly { label: string; fi: FiId; kind: AccountKind; text: string }[]) => {
      let next = emptyLedger();
      let rows = 0;
      for (const s of samples) {
        const parsed = parseStatement(s.text, s.fi);
        const account: Account = { id: `acct:${s.label}`, label: s.label, fi: s.fi, kind: s.kind };
        const r = importRows(next, parsed.rows, account, clock);
        next = r.state;
        rows += r.report.imported;
      }
      setLedger(next);
      setStatus(`Loaded ${rows} sample transactions across three institutions.`);
    },
    []
  );

  const recategorize = useCallback(
    (id: TransactionId, category: CategoryId, applyToMerchant: boolean) => {
      setLedger((prev) => setCategory(prev, id, category, { applyToMerchant }, clock));
    },
    []
  );

  const split = useCallback((id: TransactionId, spec: SplitSpec) => {
    setLedger((prev) => applySplit(prev, id, spec, clock));
  }, []);

  const unsplit = useCallback((id: TransactionId) => {
    setLedger((prev) => clearSplit(prev, id));
  }, []);

  const reconcile = useCallback((id: TransactionId) => {
    setLedger((prev) => {
      const r = settle(prev, id, clock);
      if (r.settlement) {
        const n = r.settlement.claimIds.length;
        setStatus(`Closed ${n} claim${n > 1 ? "s" : ""}.`);
      }
      return r.state;
    });
  }, []);

  const editAccount = useCallback((accountId: string, patch: AccountPatch) => {
    setLedger((prev) => editAccountTransition(prev, accountId, patch));
  }, []);

  const exportData = useCallback((options: ExportOptions): string => {
    return exportCsvTransition(ledger, options);
  }, [ledger]);

  const mergePeople = useCallback((keepId: string, mergeId: string): string | null => {
    const keep = ledger.people.find((p) => p.id === keepId);
    const merge = ledger.people.find((p) => p.id === mergeId);
    if (!keep || !merge) return null;
    const next = mergePeopleTransition(ledger, keepId, mergeId);
    if (next === ledger) return null;
    setLedger(next);
    return `Merged ${merge.displayName} into ${keep.displayName}.`;
  }, [ledger]);

  const unmergePerson = useCallback((
    personId: string,
    alias: string,
    claimIds: readonly string[]
  ): string | null => {
    const r = unmergePersonTransition(ledger, personId, alias, claimIds);
    if (!r.person) return null;
    setLedger(r.state);
    return `Moved ${claimIds.length} claim(s) to ${r.person.displayName}.`;
  }, [ledger]);

  const chooseProvider = useCallback(
    (provider: string) => {
      const spec = providers.find((p) => p.id === provider);
      if (!spec) return;
      const next: EnrichmentSettings = { provider: spec.id, model: spec.defaultModel };
      setEnrichment(next);
      void saveSettings(store.current, next);
    },
    [providers]
  );

  const chooseModel = useCallback((model: string) => {
    setEnrichment((prev) => {
      if (!prev) return prev;
      const next: EnrichmentSettings = { provider: prev.provider, model };
      void saveSettings(store.current, next);
      return next;
    });
  }, []);

  const identifyMerchants = useCallback(async () => {
    const keys = ledger.transactions.map((t) => t.merchantKey);
    const direct = import.meta.env.VITE_ENRICH_MODE === "direct";
    if (!direct && !enrichment) {
      setStatus(
        "No merchant lookup is configured on this deployment. Every local rule still runs."
      );
      return;
    }
    setBusy(true);
    // A deployed build routes through our own function so no API key is ever
    // shipped to the browser. The single-file build has no server behind it.
    const provider = enrichment?.provider ?? PROVIDERS[0]!.id;
    const transport = direct
      ? directTransport({
          provider,
          today,
          ...(enrichment ? { model: enrichment.model } : {}),
        })
      : proxyTransport({
          provider,
          today,
          ...(enrichment ? { model: enrichment.model } : {}),
        });
    const result = await enrichMerchants(transport, keys, ledger.merchants);
    if (result.facts.length > 0) {
      setLedger((prev) => applyMerchantFacts(prev, result.facts));
    }
    setBusy(false);
    if (result.requested === 0) {
      setStatus("Every merchant is already identified.");
    } else if (result.failed) {
      setStatus(
        `Identified ${result.facts.length} of ${result.requested}. ${result.error ?? "The rest kept their local categories."}`
      );
    } else {
      const via = providers.find((p) => p.id === enrichment?.provider)?.label ?? "the provider";
      setStatus(
        `Identified ${result.facts.length} merchants via ${via}. They are cached from now on.`
      );
    }
  }, [ledger.transactions, ledger.merchants, today, enrichment, providers]);

  // Answers are remembered per digest, so revisiting a period is free and no
  // model is ever called without a click. Editing the ledger changes the
  // digest, which is exactly when a fresh analysis is worth paying for.
  const insightsKey = (period: string | null, digest: unknown): string =>
    `split-ledger:insights:${period ?? "all"}:${fnv1a(JSON.stringify(digest))}`;

  const peekInsights = useCallback(
    async (period: string | null) => {
      const digest = buildInsightsDigest(ledger, period);
      const cached = await store.current.get(insightsKey(period, digest)).catch(() => null);
      if (!cached) {
        setInsights(null);
        return;
      }
      try {
        setInsights(coerceInsights(JSON.parse(cached)));
      } catch {
        setInsights(null);
      }
    },
    [ledger]
  );

  const generateInsights = useCallback(
    async (period: string | null) => {
      const digest = buildInsightsDigest(ledger, period);
      const key = insightsKey(period, digest);
      const direct = import.meta.env.VITE_ENRICH_MODE === "direct";
      if (!direct && !enrichment) {
        setStatus("No AI provider is configured on this deployment, so analysis is unavailable.");
        return;
      }
      setInsightsBusy(true);
      try {
        const provider = enrichment?.provider ?? PROVIDERS[0]!.id;
        const args = {
          digest,
          provider,
          ...(enrichment ? { model: enrichment.model } : {}),
        };
        const result = direct ? await requestInsightsDirect(args) : await requestInsights(args);
        setInsights(result);
        void store.current.set(key, JSON.stringify(result)).catch(() => {});
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Analysis failed.");
      } finally {
        setInsightsBusy(false);
      }
    },
    [ledger, enrichment]
  );

  const reset = useCallback(() => {
    setLedger(emptyLedger());
    void store.current.remove("split-ledger").catch(() => {});
    setStatus("Cleared.");
  }, []);

  return {
    ledger,
    ready,
    status,
    busy,
    today,
    providers,
    enrichment,
    chooseProvider,
    chooseModel,
    importText,
    loadSamples,
    recategorize,
    split,
    unsplit,
    reconcile,
    editAccount,
    exportData,
    mergePeople,
    unmergePerson,
    identifyMerchants,
    insights,
    insightsBusy,
    generateInsights,
    peekInsights,
    reset,
    dismissStatus: () => setStatus(null),
  };
}

/** Tiny stable hash for cache keys; collisions merely re-ask the model. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
