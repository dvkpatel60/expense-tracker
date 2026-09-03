import { useRef, useState } from "react";
import { detectParser } from "../../parsers/index.js";
import { SAMPLES } from "../samples.js";
import type { UseLedger } from "../useLedger.js";

export function ImportView({ L }: { L: UseLedger }) {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const detected = text.trim() ? detectParser(text) : null;

  function readFile(file: File) {
    if (!label) setLabel(file.name.replace(/\.csv$/i, ""));
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result));
    reader.readAsText(file);
  }

  return (
    <div className="import-grid">
      <div className="import-col">
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

        <textarea
          className="paste"
          placeholder="or paste the contents"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {detected && (
          <div className="detected">
            Looks like <b>{detected.parser.label}</b>
            {detected.confidence < 0.5 && ", though not confidently"}.
          </div>
        )}

        <input
          className="text-input"
          placeholder="Name this account"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />

        <div className="btn-stack" style={{ marginTop: 0 }}>
          <button
            className="btn"
            disabled={!text.trim() || !label.trim()}
            onClick={() => {
              if (L.importText(text, label.trim())) {
                setText("");
                setLabel("");
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
            <h2 className="panel-title">Accounts</h2>
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
      </div>
    </div>
  );
}

/**
 * Provider and model picker. Built from what the deployment reports rather than
 * from a list compiled into the bundle, so configuring a key is the only step
 * needed to make a provider appear here. One choice serves both features that
 * talk to a model: merchant identification and the Overview analysis.
 */
function MerchantLookup({ L }: { L: UseLedger }) {
  const usable = L.providers.filter((p) => p.configured);
  const active = usable.find((p) => p.id === L.enrichment?.provider) ?? null;

  return (
    <section className="panel">
      <h2 className="panel-title">AI provider</h2>

      {usable.length === 0 ? (
        <div className="row">
          <div className="row-body">
            <div className="row-title">Not configured</div>
            <div className="row-sub">
              {L.providers.length === 0
                ? "No lookup service is available in this build."
                : `Set ${L.providers.map((p) => p.envVar).join(" or ")} to enable merchant identification and analysis.`}{" "}
              Every local rule still runs without it.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="field-label">Provider</div>
          <select
            className="select"
            aria-label="Provider"
            value={L.enrichment?.provider ?? ""}
            onChange={(e) => L.chooseProvider(e.target.value)}
          >
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          <div className="field-label" style={{ marginTop: "0.9rem" }}>
            Model
          </div>
          <select
            className="select"
            aria-label="Model"
            value={L.enrichment?.model ?? ""}
            onChange={(e) => L.chooseModel(e.target.value)}
          >
            {(active?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` — ${m.note}` : ""}
              </option>
            ))}
          </select>

          <div className="btn-stack">
            <button
              className="btn secondary"
              disabled={L.busy || L.ledger.transactions.length === 0}
              onClick={() => void L.identifyMerchants()}
            >
              {L.busy ? "Identifying…" : "Identify merchants"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
