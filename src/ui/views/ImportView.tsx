import { useMemo, useRef, useState } from "react";
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABEL, inferAccountKind } from "../../core/accounts.js";
import type { AccountKind } from "../../core/types.js";
import { PARSERS, detectParser, parseStatement } from "../../parsers/index.js";
import { SAMPLES } from "../samples.js";
import type { UseLedger } from "../useLedger.js";
import { ModelPicker } from "../components/ModelPicker.js";

export function ImportView({ L }: { L: UseLedger }) {  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AccountKind | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const detected = text.trim() ? detectParser(text) : null;
  // A full dry run, not just detection. The parsers already report every row
  // they could not read and why; showing that before the Import button is
  // pressed turns "3 rows could not be read" from a post-hoc status line into
  // something you can act on while you still have the file open.
  const preview = useMemo(() => (text.trim() ? parseStatement(text) : null), [text]);
  const rejectionGroups = useMemo(() => {
    if (!preview) return [];
    const byReason = new Map<string, number>();
    for (const r of preview.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    return [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  }, [preview]);
  // Inferred from the name until the user says otherwise. Getting this wrong
  // inverts every net-worth figure, so it is shown rather than assumed.
  const effectiveKind = kind ?? inferAccountKind(label, detected?.parser.id ?? "generic");

  function readFile(file: File) {
    if (!label) setLabel(file.name.replace(/\.csv$/i, ""));
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result));
    reader.readAsText(file);
  }

  return (
    <div className="import-grid">
      <div className="import-col">
        {/* Where you are in a three-step job. The dropzone alone gave no clue
            that naming the account and splitting bills were still ahead. */}
        <ol className="steps" aria-label="Import steps">
          <li className={text.trim() ? "step done" : "step on"}>
            <span className="step-n">1</span>
            <span className="step-body">
              <b>Detect</b>
              <span>Drop or paste an export; the parser is chosen for you</span>
            </span>
          </li>
          <li className={!text.trim() ? "step" : label.trim() ? "step done" : "step on"}>
            <span className="step-n">2</span>
            <span className="step-body">
              <b>Map</b>
              <span>Name the account and confirm what kind it is</span>
            </span>
          </li>
          <li className={L.ledger.transactions.length > 0 ? "step done" : "step"}>
            <span className="step-n">3</span>
            <span className="step-body">
              <b>Split</b>
              <span>Open a purchase in Activity and claim other people&rsquo;s share</span>
            </span>
          </li>
        </ol>

        <div
          className={drag ? "dropzone drag" : "dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) readFile(f);
          }}
        >
          <p>
            Drop a CSV from RBC, Scotiabank, Wealthsimple — or anything with a date and an
            amount.
          </p>
          <button className="btn" style={{ maxWidth: 220, margin: "0 auto" }} onClick={() => fileRef.current?.click()}>
            Choose a file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
            }}
          />
        </div>

        <details className="fi-hints">
          <summary>What each export looks like</summary>
          <ul>
            {PARSERS.map((parser) => (
              <li key={parser.id}>
                <b>{parser.label}</b>
                <span>{parser.hint}</span>
              </li>
            ))}
          </ul>
        </details>

        <textarea
          className="paste"
          placeholder="or paste the contents"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {detected && preview && (
          <div className="detected">
            <div>
              Looks like <b>{detected.parser.label}</b>
              {detected.confidence < 0.5 && ", though not confidently"}.{" "}
              <span className="num">{preview.rows.length}</span> rows readable
              {preview.rejected.length > 0 && (
                <>
                  , <span className="num">{preview.rejected.length}</span> not
                </>
              )}
              .
            </div>
            {rejectionGroups.length > 0 && (
              <details className="rejects">
                <summary>Why {preview.rejected.length} rows were skipped</summary>
                <ul>
                  {rejectionGroups.map(([reason, n]) => (
                    <li key={reason}>
                      <span className="num">{n}×</span> {reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <input
          className="text-input"
          placeholder="Name this account"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />

        <div>
          <div className="field-label">Account type</div>
          <select
            className="select"
            aria-label="Account type"
            value={effectiveKind}
            onChange={(e) => setKind(e.target.value as AccountKind)}
          >
            {ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACCOUNT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="btn-stack" style={{ marginTop: 0 }}>
          <button
            className="btn"
            disabled={!text.trim() || !label.trim()}
            onClick={() => {
              if (L.importText(text, label.trim(), effectiveKind)) {
                setText("");
                setLabel("");
                setKind(null);
              }
            }}
          >
            Import
          </button>
          <button className="btn secondary" onClick={() => L.loadSamples(SAMPLES)}>
            Load sample data
          </button>
        </div>

        <p className="fine">
          Everything stays on this device. Re-importing an overlapping date range is safe —
          rows are fingerprinted, so duplicates are skipped. When merchants are identified,
          only the cleaned-up merchant names are sent; analysis sends only category totals.
          Amounts of individual purchases, dates, balances, account numbers and
          people&rsquo;s names never leave.
        </p>
      </div>

      <div className="import-col">
        {L.ledger.accounts.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">Accounts</h2>
              <p className="panel-sub">Transactions held per imported export</p>
            </div>
            {L.ledger.accounts.map((a) => (
              <div className="row" key={a.id}>
                <div className="row-body">
                  <div className="row-title">{a.label}</div>
                  <div className="row-sub">{a.fi}</div>
                </div>
                <div className="row-amount">
                  <span className="primary">
                    {L.ledger.transactions.filter((t) => t.accountId === a.id).length}
                  </span>
                </div>
              </div>
            ))}
          </section>
        )}

        <MerchantLookup L={L} />

        <BackupSection L={L} />

        {L.ledger.transactions.length > 0 && <ExportSection L={L} />}
      </div>
    </div>
  );
}

/**
 * Backup and restore. A CSV export is for a spreadsheet; a backup is for this
 * app — the whole versioned ledger, splits, people, merchant cache and all, so
 * a restore brings the state back exactly, not an approximation re-imported row
 * by row. This is the one thing that turns a browser's localStorage (which a
 * cleared cache can wipe without warning) into something safe to rely on.
 */
function BackupSection({ L }: { L: UseLedger }) {
  const restoreRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const hasData = L.ledger.transactions.length > 0 || L.ledger.people.length > 0;

  function downloadBackup() {
    const blob = new Blob([L.backup()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `split-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function pickRestore() {
    restoreRef.current?.click();
  }

  function onRestoreFile(file: File) {
    const reader = new FileReader();
    // Read first, decide second: a restore replaces everything, so if there is
    // live data we make the user confirm before it is overwritten.
    reader.onload = () => {
      const raw = String(reader.result);
      if (hasData) setConfirming(raw);
      else L.restore(raw);
    };
    reader.readAsText(file);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Backup &amp; restore</h2>
        <p className="panel-sub">The whole ledger as one file — your safety net against a cleared browser</p>
      </div>

      {confirming ? (
        <div className="row" role="alertdialog" aria-label="Confirm restore">
          <div className="row-body">
            <div className="row-title">Replace everything with this backup?</div>
            <div className="row-sub">
              Your current {L.ledger.transactions.length} transactions will be overwritten. This
              cannot be undone — download a backup of what you have first if you are unsure.
            </div>
          </div>
          <div className="btn-stack" style={{ flexDirection: "row", gap: "0.5rem" }}>
            <button className="btn secondary" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() => {
                L.restore(confirming);
                setConfirming(null);
              }}
            >
              Replace
            </button>
          </div>
        </div>
      ) : (
        <div className="btn-stack">
          <button className="btn" onClick={downloadBackup} disabled={!hasData}>
            Download backup
          </button>
          <button className="btn secondary" onClick={pickRestore}>
            Restore from file
          </button>
        </div>
      )}

      <input
        ref={restoreRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onRestoreFile(file);
          e.target.value = "";
        }}
      />
    </section>
  );
}

/**
 * CSV export. The ledger is local-first, so the way out is the same shape as
 * the way in: a file the user keeps. Amounts are dollars; "your share" is what
 * the row actually cost you after splits.
 */
function ExportSection({ L }: { L: UseLedger }) {
  const [scope, setScope] = useState<"all" | "month">("all");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [account, setAccount] = useState<string>("all");
  const [format, setFormat] = useState<"summary" | "full">("summary");

  const period = scope === "all" ? null : month;

  function download() {
    const csv = L.exportData({
      period,
      accountId: account === "all" ? null : account,
      format,
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledger-${period ?? "all"}${account !== "all" ? `-${account}` : ""}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Export</h2>
        <p className="panel-sub">Download your ledger as CSV — a file you keep</p>
      </div>

      <div className="field-label">Range</div>
      <select className="select" aria-label="Export range" value={scope} onChange={(e) => setScope(e.target.value as "all" | "month")}>
        <option value="all">All time</option>
        <option value="month">Specific month</option>
      </select>
      {scope === "month" && (
        <input
          className="text-input"
          type="month"
          aria-label="Month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ marginTop: "0.5rem" }}
        />
      )}

      <div className="field-label" style={{ marginTop: "0.9rem" }}>Account</div>
      <select className="select" aria-label="Export account" value={account} onChange={(e) => setAccount(e.target.value)}>
        <option value="all">All accounts</option>
        {L.ledger.accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>

      <div className="field-label" style={{ marginTop: "0.9rem" }}>Format</div>
      <select className="select" aria-label="Export format" value={format} onChange={(e) => setFormat(e.target.value as "summary" | "full")}>
        <option value="summary">Summary — what it was and what it cost you</option>
        <option value="full">Full — every stored field</option>
      </select>

      <div className="btn-stack">
        <button className="btn" onClick={download}>
          Download
        </button>
      </div>
    </section>
  );
}

/**
 * Provider status and the merchant-identification action.
 *
 * The picker itself is ModelPicker, shared with the copilot on Overview: one
 * choice serves both features that talk to a model, so there is one place a
 * provider can be chosen and one place its key status is reported.
 */
function MerchantLookup({ L }: { L: UseLedger }) {
  const usable = L.providers.filter((p) => p.configured);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">AI provider</h2>
        <p className="panel-sub">Used for merchant identification and Overview analysis</p>
      </div>

      {usable.length === 0 && (
        <div className="row">
          <div className="row-body">
            <div className="row-title">Not configured</div>
            <div className="row-sub">
              {L.providers.length === 0
                ? "No lookup service is available in this build."
                : "Set one of the keys listed below on the deployment to enable merchant identification and analysis."}{" "}
              Every local rule still runs without it.
            </div>
          </div>
        </div>
      )}

      <ModelPicker L={L} />

      {usable.length > 0 && (
        <div className="btn-stack">
          <button
            className="btn secondary"
            disabled={L.busy || L.ledger.transactions.length === 0}
            onClick={() => void L.identifyMerchants()}
          >
            {L.busy ? "Identifying…" : "Identify merchants"}
          </button>
        </div>
      )}
    </section>
  );
}
