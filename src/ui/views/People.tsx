import { useState } from "react";
import { personBalances } from "../../core/ledger.js";
import { dollarsAbs, relativeDays } from "../format.js";
import type { UseLedger } from "../useLedger.js";
import type { ClaimId, Person } from "../../core/types.js";

export function People({
  L,
  onOpen,
}: {
  L: UseLedger;
  onOpen(id: string): void;
}) {
  const balances = personBalances(L.ledger);
  const [mergingFrom, setMergingFrom] = useState<string | null>(null);
  const [unmerging, setUnmerging] = useState<string | null>(null);

  if (balances.length === 0) {
    return (
      <div className="empty">
        <h2>No one yet</h2>
        <p>Split a transaction or import an e-transfer and people will show up here.</p>
      </div>
    );
  }

  return (
    <>
      <div className="people-grid">
        {balances.map((b) => (
          <section className="panel person" key={b.person.id}>
            <div className="person-head">
              <span className="avatar" aria-hidden="true">
                {initials(b.person.displayName)}
              </span>
              <div>
                <div className="person-name">{b.person.displayName}</div>
                <div className="person-sub">
                  {b.net === 0
                    ? "Settled up"
                    : b.net > 0
                      ? `Owes you · oldest ${relativeDays(b.oldestOpenOn ?? L.today, L.today)} days`
                      : `You owe · oldest ${relativeDays(b.oldestOpenOn ?? L.today, L.today)} days`}
                  {b.person.aliases.length > 1 && ` · also seen as ${b.person.aliases[0]}`}
                </div>
              </div>
              <span className={`bal-net ${b.net === 0 ? "even" : b.net > 0 ? "owed" : "owing"}`}>
                {b.net === 0 ? "—" : dollarsAbs(b.net)}
              </span>
            </div>

            {b.openClaims.length > 0 && (
              <div className="claim-list">
                {b.openClaims.map((c) => {
                  const tx = L.ledger.transactions.find((t) => t.id === c.transactionId);
                  return (
                    <button key={c.id} onClick={() => tx && onOpen(tx.id)}>
                      <span>{tx?.merchantName ?? "Transaction"}</span>
                      <span className="num">
                        {c.direction === "they_owe_me" ? "+" : "−"}
                        {dollarsAbs(c.amount)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="person-actions">
              {unmerging === b.person.id ? (
                <UnmergeForm
                  person={b.person}
                  L={L}
                  onDone={() => setUnmerging(null)}
                  openClaims={b.openClaims.map((c) => c.id)}
                />
              ) : (
                <button
                  className="link"
                  onClick={() => setUnmerging(b.person.id)}
                  disabled={b.person.aliases.length < 2}
                  title={
                    b.person.aliases.length < 2
                      ? "Only one spelling recorded for this person"
                      : "Move claims to a separate person"
                  }
                >
                  Unmerge
                </button>
              )}

              {mergingFrom === b.person.id ? (
                <MergeForm
                  person={b.person}
                  others={balances.map((x) => x.person).filter((p) => p.id !== b.person.id)}
                  L={L}
                  onDone={() => setMergingFrom(null)}
                />
              ) : (
                <button
                  className="link"
                  onClick={() => setMergingFrom(b.person.id)}
                  disabled={balances.length < 2}
                >
                  Merge into…
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
      <p className="fine" style={{ marginTop: "1rem" }}>
        One transfer settles a whole balance. If someone owes you for dinner and you owe them
        for a fare, the difference is what needs to move. Merging combines one person's history
        into another; unmerging moves a claim off a person who is really two.
      </p>
    </>
  );
}

function MergeForm({
  person,
  others,
  L,
  onDone,
}: {
  person: Person;
  others: readonly Person[];
  L: UseLedger;
  onDone(): void;
}) {
  const [target, setTarget] = useState<string>(others[0]?.id ?? "");
  return (
    <div className="inline-form">
      <span className="tiny">into</span>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName}
          </option>
        ))}
      </select>
      <button
        className="small primary"
        onClick={() => {
          L.mergePeople(target, person.id);
          onDone();
        }}
      >
        Merge
      </button>
      <button className="small" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}

function UnmergeForm({
  person,
  L,
  onDone,
  openClaims,
}: {
  person: Person;
  L: UseLedger;
  onDone(): void;
  openClaims: readonly ClaimId[];
}) {
  const [alias, setAlias] = useState<string>(person.aliases[0] ?? "");
  const [picked, setPicked] = useState<boolean[]>(() => openClaims.map(() => false));
  const count = picked.filter(Boolean).length;

  return (
    <div className="inline-form unmerge">
      <label>
        <span className="tiny">new person name</span>
        <input value={alias} onChange={(e) => setAlias(e.target.value)} />
      </label>
      {openClaims.length > 0 && (
        <div className="unmerge-claims">
          {openClaims.map((id, i) => (
            <label key={id} className="who-tag on">
              <input
                type="checkbox"
                checked={picked[i]}
                onChange={() =>
                  setPicked((prev) => prev.map((v, j) => (j === i ? !v : v)))
                }
              />
              Claim {i + 1}
            </label>
          ))}
        </div>
      )}
      <button
        className="small primary"
        disabled={!alias.trim() || count === 0}
        onClick={() => {
          const ids = openClaims.filter((_, i) => picked[i]);
          const msg = L.unmergePerson(person.id, alias.trim(), ids);
          onDone();
        }}
      >
        Unmerge {count > 0 ? `(${count})` : ""}
      </button>
      <button className="small" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
