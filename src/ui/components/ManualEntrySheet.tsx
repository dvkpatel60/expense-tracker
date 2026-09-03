import { useState } from "react";
import { CATEGORIES } from "../../core/categorize.js";
import { cents, parseAmount } from "../../core/money.js";
import { CASH_ACCOUNT_ID } from "../../core/ledger.js";
import type { ManualEntry } from "../../core/ledger.js";
import type { CategoryId } from "../../core/types.js";
import type { UseLedger } from "../useLedger.js";

/**
 * Add a transaction by hand — the capture path a bank export can never cover: a
 * cash purchase, or a row a statement dropped. It mirrors the transaction sheet
 * so the two feel like one surface, and it does no domain work itself: the
 * amount is parsed the same way an import parses it (so "$4.50", "-4.50" and
 * "(4.50)" all mean the same money out), and everything else is the core
 * transition's job.
 */
export function ManualEntrySheet({ L, onClose }: { L: UseLedger; onClose(): void }) {
  const today = L.today;
  const [account, setAccount] = useState<string>(
    L.ledger.accounts[0]?.id ?? CASH_ACCOUNT_ID
  );
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [amountText, setAmountText] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [category, setCategory] = useState<string>("auto");

  const magnitude = parseAmount(amountText);
  // A user types "12.50" for a $12.50 purchase; the sign is the in/out toggle,
  // not something they should have to remember to type as a minus.
  const signed =
    magnitude === null
      ? null
      : cents(direction === "out" ? -Math.abs(magnitude) : Math.abs(magnitude));
  const valid = signed !== null && signed !== 0 && description.trim().length > 0;

  function submit() {
    if (!valid || signed === null) return;
    const entry: ManualEntry = {
      accountId: account,
      date,
      description: description.trim(),
      amount: signed,
      ...(category !== "auto" ? { categoryId: category as CategoryId } : {}),
    };
    L.addManual(entry);
    onClose();
  }

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Add a transaction" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grabber" />

        <div className="sheet-head">
          <div className="sheet-merchant">Add a transaction</div>
          <div className="sheet-note">
            For a cash purchase or a row an export missed. It splits, files and reconciles like
            any imported one.
          </div>
        </div>

        <div className="card">
          <div className="field-label">What was it</div>
          <input
            className="search"
            placeholder="e.g. Farmers market, ATM withdrawal, split a taxi"
            value={description}
            autoFocus
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) submit();
            }}
          />

          <div className="field-label" style={{ marginTop: "0.9rem" }}>
            Money {direction === "out" ? "out" : "in"}
          </div>
          <div className="split-inputs">
            <div className="strategy-tabs" role="group" aria-label="Direction">
              <button
                className={direction === "out" ? "active" : ""}
                aria-pressed={direction === "out"}
                onClick={() => setDirection("out")}
              >
                Spent
              </button>
              <button
                className={direction === "in" ? "active" : ""}
                aria-pressed={direction === "in"}
                onClick={() => setDirection("in")}
              >
                Received
              </button>
            </div>
            <input
              className="search num"
              inputMode="decimal"
              placeholder="0.00"
              aria-label="Amount"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) submit();
              }}
            />
          </div>
          {amountText.trim() !== "" && magnitude === null && (
            <div className="sheet-note warn">That is not an amount I can read.</div>
          )}

          <div className="field-label" style={{ marginTop: "0.9rem" }}>Account</div>
          <select
            className="select"
            aria-label="Account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            {L.ledger.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
            {!L.ledger.accounts.some((a) => a.id === CASH_ACCOUNT_ID) && (
              <option value={CASH_ACCOUNT_ID}>Cash</option>
            )}
          </select>

          <div className="field-label" style={{ marginTop: "0.9rem" }}>Date</div>
          <input
            className="search"
            type="date"
            aria-label="Date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
          />

          <div className="field-label" style={{ marginTop: "0.9rem" }}>Category</div>
          <select
            className="select"
            aria-label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="auto">Decide from the description</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <div className="btn-stack">
            <button className="btn" disabled={!valid} onClick={submit}>
              Add transaction
            </button>
            <button className="btn secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
