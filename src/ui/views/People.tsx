import { personBalances } from "../../core/ledger.js";
import { dollarsAbs, relativeDays } from "../format.js";
import type { UseLedger } from "../useLedger.js";

export function People({
  L,
  onOpen,
}: {
  L: UseLedger;
  onOpen(id: string): void;
}) {
  const balances = personBalances(L.ledger);
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
          </section>
        ))}
      </div>
      <p className="fine" style={{ marginTop: "1rem" }}>
        One transfer settles a whole balance. If someone owes you for dinner and you owe them
        for a fare, the difference is what needs to move.
      </p>
    </>
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
