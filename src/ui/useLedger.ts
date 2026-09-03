import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyMerchantFacts,
  applySplit,
  clearSplit,
  emptyLedger,
  importRows,
  setCategory,
  settle,
  systemClock,
} from "../core/ledger.js";
import type { ImportReport, LedgerState } from "../core/ledger.js";
import { parseStatement } from "../parsers/index.js";
import { load, save } from "../store/store.js";
import { browserStore } from "./storage.js";
import { enrichMerchants } from "../enrich/enricher.js";
import { anthropicTransport } from "../enrich/anthropic.js";
import { proxyTransport } from "../enrich/proxy.js";
import type {
  Account,
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
  importText(text: string, label: string, fi?: FiId): ImportReport | null;
  loadSamples(samples: readonly { label: string; fi: FiId; text: string }[]): void;
  recategorize(id: TransactionId, category: CategoryId, applyToMerchant: boolean): void;
  split(id: TransactionId, spec: SplitSpec): void;
  unsplit(id: TransactionId): void;
  reconcile(id: TransactionId): void;
  identifyMerchants(): Promise<void>;
  reset(): void;
  dismissStatus(): void;
}

export function useLedger(): UseLedger {
  const [ledger, setLedger] = useState<LedgerState>(emptyLedger);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    (text: string, label: string, fi?: FiId): ImportReport | null => {
      const parsed = fi ? parseStatement(text, fi) : parseStatement(text);
      if (parsed.rows.length === 0) {
        setStatus(
          parsed.rejected[0]?.reason ??
            "No transactions found. Check that the file has a date and an amount column."
        );
        return null;
      }
      const account: Account = { id: `acct:${label}`, label, fi: parsed.fi };
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
    (samples: readonly { label: string; fi: FiId; text: string }[]) => {
      let next = emptyLedger();
      let rows = 0;
      for (const s of samples) {
        const parsed = parseStatement(s.text, s.fi);
        const account: Account = { id: `acct:${s.label}`, label: s.label, fi: s.fi };
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

  const identifyMerchants = useCallback(async () => {
    const keys = ledger.transactions.map((t) => t.merchantKey);
    setBusy(true);
    // A deployed build routes through our own function so the API key is never
    // shipped to the browser. The single-file build has no server behind it.
    const transport =
      import.meta.env.VITE_ENRICH_MODE === "direct"
        ? anthropicTransport({ today })
        : proxyTransport({ today });
    const result = await enrichMerchants(transport, keys, ledger.merchants);
    if (result.facts.length > 0) {
      setLedger((prev) => applyMerchantFacts(prev, result.facts));
    }
    setBusy(false);
    if (result.requested === 0) {
      setStatus("Every merchant is already identified.");
    } else if (result.failed) {
      setStatus(
        `Identified ${result.facts.length} of ${result.requested}. The rest kept their local categories.`
      );
    } else {
      setStatus(`Identified ${result.facts.length} merchants. They are cached from now on.`);
    }
  }, [ledger.transactions, ledger.merchants, today]);

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
    importText,
    loadSamples,
    recategorize,
    split,
    unsplit,
    reconcile,
    identifyMerchants,
    reset,
    dismissStatus: () => setStatus(null),
  };
}
