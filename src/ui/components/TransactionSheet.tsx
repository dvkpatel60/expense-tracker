import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
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

type Strategy = "even" | "percent" | "amounts" | "itemized";

const STRATEGIES: { id: Strategy; label: string }[] = [
  { id: "even", label: "Even" },
  { id: "percent", label: "Percent" },
  { id: "amounts", label: "Amounts" },
  { id: "itemized", label: "Itemized" },
];

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
  const [strategy, setStrategy] = useState<Strategy>("even");
  const [shares, setShares] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [items, setItems] = useState<
    { label: string; amount: string; participants: string[] }[]
  >([]);

  const roster = [...people, ...adHoc];
  const total = Math.abs(tx.amount) as Cents;
  const selectedPeople = roster.filter((p) => selected.includes(p.id));

  const toggle = (id: string) => {
    const on = selected.includes(id) ? selected.filter((p) => p !== id) : [...selected, id];
    setSelected(on);
    setShares((s) => {
      const n = { ...s };
      if (!on.includes(id)) delete n[id];
      return n;
    });
    setAmounts((a) => {
      const n = { ...a };
      if (!on.includes(id)) delete n[id];
      return n;
    });
  };

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

  /** In a percent split your share is whatever the circled friends do not cover. */
  const myPercent =
    strategy === "percent" && selected.length > 0
      ? Math.round(100 - sumOf(asPercent(shares, selected)))
      : NaN;

  const preview = useMemoPreview(total, strategy, selected, includeMe, shares, amounts, items);

  const canApply =
    selected.length > 0 &&
    (strategy !== "amounts" || previewForAmounts(total, selected, amounts, includeMe) !== null) &&
    (strategy !== "itemized" || items.every((i) => i.amount && i.participants.length > 0));

  function apply() {
    if (!canApply) return;
    switch (strategy) {
      case "even":
        onSplit({ kind: "even", participants: selected, includeMe });
        break;
      case "percent": {
        const parsed = asPercent(shares, selected);
        if (parsed.every((v) => Number.isFinite(v))) {
          onSplit({
            kind: "percent",
            shares: selected.map((id, i) => ({ personId: id, percent: parsed[i] ?? 0 })),
            myPercent,
          });
        }
        break;
      }
      case "amounts": {
        const amountsFor = previewForAmounts(total, selected, amounts, includeMe);
        if (amountsFor) {
          onSplit({
            kind: "amounts",
            shares: selected.map((id) => ({
              personId: id,
              amount: cents(amountsFor.assigned[id] ?? 0),
            })),
          });
        }
        break;
      }
      case "itemized": {
        onSplit({
          kind: "itemized",
          items: items.map((i) => ({
            label: i.label,
            amount: cents(parseFloat(i.amount) * 100 || 0),
            participants: i.participants.filter((p) => p !== "me"),
            includeMe: i.participants.includes("me"),
          })),
        });
        break;
      }
    }
  }

  return (
    <div>
      <div className="field-label">Split with</div>

      <div className="strategy-tabs" role="tablist" aria-label="Split strategy">
        {STRATEGIES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={strategy === s.id}
            className={strategy === s.id ? "active" : ""}
            onClick={() => setStrategy(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

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
        {strategy === "even" || strategy === "amounts" ? (
          <button aria-pressed={includeMe} onClick={() => setIncludeMe((v) => !v)}>
            Me
          </button>
        ) : null}
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

      {strategy === "percent" && selectedPeople.length > 0 && (
        <div className="split-inputs">
          {selectedPeople.map((p) => (
            <label key={p.id} className="split-input">
              <span>{p.displayName}</span>
              <div>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={shares[p.id] ?? ""}
                  placeholder="%"
                  onChange={(e) => setShares({ ...shares, [p.id]: e.target.value })}
                />
                <span>%</span>
              </div>
            </label>
          ))}
          <div className="split-mine">
            <span>You</span>
            <span className="num">{Number.isFinite(myPercent) ? `${myPercent}%` : "—"}</span>
          </div>
          <div className="split-sum">
            Total assigned: <span className="num">{sumOf(asPercent(shares, selected))}%</span>
            {sumOf(asPercent(shares, selected)) > 100 && (
              <span className="warn"> exceeds 100%</span>
            )}
          </div>
        </div>
      )}

      {strategy === "amounts" && selectedPeople.length > 0 && (
        <div className="split-inputs">
          {selectedPeople.map((p) => (
            <label key={p.id} className="split-input">
              <span>{p.displayName}</span>
              <div>
                <span className="unit">$</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amounts[p.id] ?? ""}
                  placeholder="0.00"
                  onChange={(e) => setAmounts({ ...amounts, [p.id]: e.target.value })}
                />
              </div>
            </label>
          ))}
          {includeMe && <PreviewMine total={total} selected={selected} amounts={amounts} />}
        </div>
      )}

      {strategy === "itemized" && (
        <div className="itemized">
          {items.map((it, idx) => (
            <div className="item-block" key={idx}>
              <div className="item-row">
                <input
                  className="item-label"
                  placeholder="Item"
                  value={it.label}
                  onChange={(e) =>
                    setItems(items.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))
                  }
                />
                <input
                  className="item-amount num"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="$0.00"
                  value={it.amount}
                  onChange={(e) =>
                    setItems(items.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))
                  }
                />
                <button
                  aria-label="Remove item"
                  className="item-remove"
                  onClick={() => setItems(items.filter((_, i) => i !== idx))}
                >
                  &times;
                </button>
              </div>
              <div className="item-who">
                <button
                  className={it.participants.includes("me") ? "who-tag on" : "who-tag"}
                  onClick={() => toggleItemParticipant(setItems, items, idx, "me")}
                >
                  Me
                </button>
                {selectedPeople.map((p) => (
                  <button
                    key={p.id}
                    className={it.participants.includes(p.id) ? "who-tag on" : "who-tag"}
                    onClick={() => toggleItemParticipant(setItems, items, idx, p.id)}
                  >
                    {p.displayName}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button className="btn secondary" style={{ width: "auto" }} onClick={() => addItem(setItems, items)}>
            + Add item
          </button>
          {items.length > 0 && (
            <div className="split-sum">
              Items total:{" "}
              <span className="num">
                {dollarsAbs(cents(items.reduce((n, i) => n + (parseFloat(i.amount) * 100 || 0), 0)))}
              </span>
              <span> of {dollarsAbs(total)}</span>
            </div>
          )}
        </div>
      )}

      {preview && <div className="notice">{preview}</div>}

      <div className="btn-stack">
        <button className="btn" disabled={!canApply} onClick={apply}>
          Apply split
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

/** Sum an array of finite numbers (treating NaN/empty as 0). */
function sumOf(values: readonly number[]): number {
  return values.reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0);
}

/** Parse the percent inputs for the currently selected friends. */
function asPercent(shares: Record<string, string>, selected: readonly string[]): number[] {
  return selected.map((id) => parseFloat(shares[id] ?? "") || 0);
}

interface AmountsPreview {
  assigned: Record<string, number>;
  mine: number;
}

/** Validate the amounts split: every entered amount must be a number, and the
 *  sum must not exceed the transaction (the remainder is yours). */
function previewForAmounts(
  total: Cents,
  selected: readonly string[],
  amounts: Record<string, string>,
  includeMe: boolean
): AmountsPreview | null {
  const assigned: Record<string, number> = {};
  for (const id of selected) {
    const v = parseFloat(amounts[id] ?? "");
    if (!Number.isFinite(v) || v < 0) return null;
    assigned[id] = Math.round(v * 100);
  }
  const assignedSum = sumOf(selected.map((id) => assigned[id] ?? 0));
  if (assignedSum > total) return null;
  const mine = includeMe ? total - assignedSum : 0;
  return { assigned, mine };
}

/** Human "N ways, $X each" (or equivalent) for the active strategy. */
function useMemoPreview(
  total: Cents,
  strategy: Strategy,
  selected: readonly string[],
  includeMe: boolean,
  shares: Record<string, string>,
  amounts: Record<string, string>,
  items: { label: string; amount: string; participants: string[] }[]
): string | null {
  return useMemo(() => {
    if (selected.length === 0) return null;
    switch (strategy) {
      case "even": {
        const heads = selected.length + (includeMe ? 1 : 0);
        if (heads === 0) return null;
        const each = Math.round(total / heads);
        return `${heads} ${heads === 1 ? "way" : "ways"}, ${dollarsAbs(cents(each))} each${includeMe ? ", including you" : ", none of it yours"}.`;
      }
      case "percent": {
        const parsed = asPercent(shares, selected);
        const used = sumOf(parsed);
        if (used === 0) return null;
        const mine = includeMe ? 100 - used : 0;
        return `Friends cover ${Math.round(used)}%\u2014your share ${Math.max(0, Math.round(mine))}% (${dollarsAbs(cents(Math.round((total * mine) / 100)))}).`;
      }
      case "amounts": {
        const p = previewForAmounts(total, selected, amounts, includeMe);
        if (!p) return null;
        const label = selected
          .map((id) => `${dollarsAbs(cents(p.assigned[id] ?? 0))}`)
          .join(" + ");
        return `${label} \u2248 ${dollarsAbs(cents(includeMe ? p.mine : 0))} for you${includeMe ? "" : " (all theirs)"}.`;
      }
      case "itemized":
        return items.length > 0 ? `${items.length} ${items.length === 1 ? "item" : "items"} to split.` : null;
      default:
        return null;
    }
  }, [total, strategy, selected, includeMe, shares, amounts, items]);
}

function PreviewMine({
  total,
  selected,
  amounts,
}: {
  total: Cents;
  selected: readonly string[];
  amounts: Record<string, string>;
}) {
  const p = previewForAmounts(total, selected, amounts, true);
  if (!p) return null;
  return (
    <div className="split-mine">
      <span>You</span>
      <span className="num num-rem">{dollarsAbs(cents(p.mine))} (remainder)</span>
    </div>
  );
}

function addItem(
  setItems: Dispatch<SetStateAction<{ label: string; amount: string; participants: string[] }[]>>,
  items: { label: string; amount: string; participants: string[] }[]
) {
  setItems([...items, { label: "", amount: "", participants: [] }]);
}

function toggleItemParticipant(
  setItems: Dispatch<SetStateAction<{ label: string; amount: string; participants: string[] }[]>>,
  items: { label: string; amount: string; participants: string[] }[],
  index: number,
  id: string
) {
  setItems(
    items.map((x, i) =>
      i === index
        ? {
            ...x,
            participants: x.participants.includes(id)
              ? x.participants.filter((p) => p !== id)
              : [...x.participants, id],
          }
        : x
    )
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
