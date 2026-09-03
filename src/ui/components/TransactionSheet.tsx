import { useState } from "react";
import { CATEGORIES } from "../../core/categorize.js";
import { cents } from "../../core/money.js";
import type { Cents } from "../../core/money.js";
import { effectiveAmount, netPosition, proposeSettlement } from "../../core/split.js";
import type {
  CategoryId,
  Claim,
  Person,
  SplitSpec,
  Transaction,
} from "../../core/types.js";
import { dollarsAbs } from "../format.js";

interface Props {
  tx: Transaction;
  claims: readonly Claim[];
  people: readonly Person[];
  onClose(): void;
  onCategory(category: CategoryId, applyToMerchant: boolean): void;
  onSplit(spec: SplitSpec): void;
  onUnsplit(): void;
  onReconcile(): void;
}

export function TransactionSheet(props: Props) {
  const { tx, claims, people, onClose } = props;
  const mine = claims.filter((c) => c.transactionId === tx.id && c.status !== "void");
  const share = effectiveAmount(tx, claims);
  const isIncoming = tx.kind === "etransfer_in";

  return (
    <div className="scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grabber" />

        <div className="sheet-head">
          <div className="sheet-merchant">{tx.merchantName}</div>
          <div className="sheet-amount">{dollarsAbs(tx.amount)}</div>
          <div className="sheet-note">
            {tx.date} · {tx.accountId.replace("acct:", "")}
            {tx.currency !== "CAD" ? ` · charged in ${tx.currency}` : ""}
            {tx.transferPairId ? " · matched to a transfer between your accounts" : ""}
          </div>
          {tx.merchantNote && <div className="sheet-note">{tx.merchantNote}</div>}
          {mine.length > 0 && (
            <div className="sheet-note">
              <b style={{ color: "var(--ink)" }}>Your share is {dollarsAbs(share)}.</b>
            </div>
          )}
          <div className="raw">{tx.rawDescription}</div>
        </div>

        {isIncoming ? (
          <Reconcile {...props} />
        ) : (
          <>
            <CategoryPicker tx={tx} onCategory={props.onCategory} />
            {!tx.transferPairId && (
              <SplitComposer
                tx={tx}
                people={people}
                existing={mine}
                onSplit={props.onSplit}
                onUnsplit={props.onUnsplit}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CategoryPicker({
  tx,
  onCategory,
}: {
  tx: Transaction;
  onCategory(category: CategoryId, applyToMerchant: boolean): void;
}) {
  const [applyAll, setApplyAll] = useState(true);
  return (
    <div style={{ marginBottom: "1.75rem" }}>
      <div className="field-label">Category</div>
      <select
        className="select"
        value={tx.categoryId}
        onChange={(e) => onCategory(e.target.value, applyAll)}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label
        style={{
          display: "flex",
          gap: "0.55rem",
          alignItems: "center",
          marginTop: "0.7rem",
          color: "var(--ink-2)",
          fontSize: "0.875rem",
        }}
      >
        <input
          type="checkbox"
          checked={applyAll}
          onChange={(e) => setApplyAll(e.target.checked)}
        />
        Remember this for {tx.merchantName}
      </label>
    </div>
  );
}

function SplitComposer({
  tx,
  people,
  existing,
  onSplit,
  onUnsplit,
}: {
  tx: Transaction;
  people: readonly Person[];
  existing: readonly Claim[];
  onSplit(spec: SplitSpec): void;
  onUnsplit(): void;
}) {
  const [selected, setSelected] = useState<string[]>(existing.map((c) => c.personId));
  const [includeMe, setIncludeMe] = useState(true);
  const [newName, setNewName] = useState("");
  const [adHoc, setAdHoc] = useState<Person[]>([]);

  const roster = [...people, ...adHoc];
  const heads = selected.length + (includeMe ? 1 : 0);
  const preview =
    heads > 0 ? (Math.round(Math.abs(tx.amount) / heads) as Cents) : (0 as Cents);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  function addPerson() {
    const name = newName.trim();
    if (!name) return;
    const id = `person:adhoc:${name.toLowerCase()}`;
    if (!roster.some((p) => p.id === id)) {
      setAdHoc((prev) => [...prev, { id, displayName: name, aliases: [name] }]);
    }
    setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setNewName("");
  }

  return (
    <div>
      <div className="field-label">Split with</div>
      <div className="who">
        {roster.map((p) => (
          <button
            key={p.id}
            aria-pressed={selected.includes(p.id)}
            onClick={() => toggle(p.id)}
          >
            {p.displayName}
          </button>
        ))}
        <button aria-pressed={includeMe} onClick={() => setIncludeMe((v) => !v)}>
          Me
        </button>
      </div>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          className="search"
          style={{ marginBottom: 0 }}
          placeholder="Add someone"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addPerson();
          }}
        />
        <button className="btn secondary" style={{ width: "auto", padding: "0 1.1rem" }} onClick={addPerson}>
          Add
        </button>
      </div>

      {heads > 0 && selected.length > 0 && (
        <div className="notice">
          {heads} ways, {dollarsAbs(preview)} each
          {includeMe ? ", including you" : ", none of it yours"}.
        </div>
      )}

      <div className="btn-stack">
        <button
          className="btn"
          disabled={selected.length === 0}
          onClick={() =>
            onSplit({ kind: "even", participants: selected, includeMe })
          }
        >
          Split evenly
        </button>
        {existing.length > 0 && (
          <button className="btn secondary" onClick={onUnsplit}>
            Remove split
          </button>
        )}
      </div>
    </div>
  );
}

function Reconcile({
  tx,
  claims,
  people,
  onReconcile,
}: Pick<Props, "tx" | "claims" | "people" | "onReconcile">) {
  if (!tx.personId) {
    return <div className="notice">This transfer has no counterparty on it.</div>;
  }
  const person = people.find((p) => p.id === tx.personId);
  const proposal = proposeSettlement(tx.personId, tx.amount, claims);
  const net = netPosition(tx.personId, claims);
  const open = claims.filter((c) => c.personId === tx.personId && c.status === "open");

  if (!proposal) {
    return (
      <div className="notice">
        {person?.displayName ?? "This person"} has nothing outstanding, so this is income
        rather than a repayment. Change the category if that is wrong.
      </div>
    );
  }

  return (
    <div>
      <div className="field-label">Outstanding with {person?.displayName}</div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        {open.map((c) => (
          <div className="row" key={c.id}>
            <div className="row-body">
              <div className="row-title">
                {c.direction === "they_owe_me" ? "Owes you" : "You owe"}
              </div>
              <div className="row-sub">{c.createdOn}</div>
            </div>
            <div className="row-amount">
              <span className="primary">
                {c.direction === "they_owe_me" ? "+" : "\u2212"}
                {dollarsAbs(c.amount)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="notice">
        {open.length > 1
          ? `Those net out to ${dollarsAbs(net)}. `
          : ""}
        {proposal.exact
          ? "This transfer settles it."
          : `This transfer is ${dollarsAbs(cents(Math.abs(proposal.residual)))} ${
              proposal.residual > 0 ? "short of" : "more than"
            } the balance. Settling anyway closes everything.`}
      </div>

      <div className="btn-stack">
        <button className="btn" onClick={onReconcile}>
          Settle {open.length} {open.length > 1 ? "claims" : "claim"}
        </button>
      </div>
    </div>
  );
}
