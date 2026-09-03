# Expense Tracker

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/dvkpatel60/expense-tracker)

Local-first expense tracking and bill splitting for Canadian bank exports.
Consolidates RBC, Scotiabank and Wealthsimple CSVs into one categorized ledger,
tracks Interac e-transfers as people rather than merchants, and nets claims
across rotating groups.

## Layout

```
src/
  core/          Pure domain. No I/O, no React, no browser globals.
    money.ts       Integer cents + exact largest-remainder allocation
    types.ts       Domain model
    dates.ts       M/D/Y vs D/M/Y, declared not guessed
    geography.ts   Canadian city/province stripping
    normalize.ts   Statement string -> stable merchant key
    etransfer.ts   Interac direction + counterparty extraction
    people.ts      Alias resolution across FI spellings
    categorize.ts  Rules as data, user rules outrank builtins
    pairing.ts     Cross-account internal transfer detection
    split.ts       Split strategies, effective spend, netting settlement
    ledger.ts      State transitions and reporting
  parsers/       One file per FI behind a common interface, plus fixtures
  store/         Versioned persistence with migrations
  enrich/        Merchant lookup behind an injectable transport
tests/           94 tests
```

## Design decisions

**Money is integer cents.** Splitting on floats produces shares that do not sum
to the total. `allocate` uses largest-remainder so the invariant
`sum(claims) + myShare === abs(amount)` holds exactly. It is asserted over 3,000
randomized shapes in `money.test.ts` and 2,000 in `split.test.ts`.

**Parsers know nothing about the domain.** They emit `RawRow` and a list of
rejected lines with reasons. Adding an FI is one file, one registry entry, one
fixture.

**Date order is proven, not assumed.** Scotia emits M/D/Y or D/M/Y depending on
the export locale. `inferDateOrder` looks for a day above 12; when the file
cannot prove its order the importer says so instead of silently transposing a
month.

**Normalization steps are named and individually testable.** No step is allowed
to empty a string — a greedy geography rule once reduced
`SQ *BLUE DOOR COFFEE TORONTO ON` to `BLUE`, which is why cities come off a
list. Stability is a test: three spellings of the same cafe must produce one
cache key, or you pay for the same lookup twice.

**Rules are data.** A manual category override writes a user rule at priority
1000, so the next import of that merchant lands correctly. Enrichment never
overwrites a user choice.

**E-transfers are people, not merchants.** They bypass the merchant pipeline
entirely. Running a surname through merchant categorization produces nonsense
like "Dining" for a person.

**Settlement nets.** Claims run both directions with the same person, so
proposals are built against the net position. Sarah owes $40 for dinner, you
owe $15 for the fare, one $25 transfer closes both.

**Enrichment is keyed on merchant and injected.** Only normalized merchant
strings cross the network — no amounts, dates, balances, account numbers or
counterparty names. `redactForLookup` enforces it and a test asserts the request
body contains no dates or balances.

## Known gaps

- FX: `originalAmount` is carried on `RawRow` and `Transaction` but no
  conversion or fee attribution is implemented. USD rows import at face value.
- No UI. Next step.
- Person merge/unmerge is modelled (`Person.aliases`) but has no operation yet.
- Enrichment has no rate limiting or retry.

## Deploying to Netlify

```
git push -u origin main
```

The remote is already set to `https://github.com/dvkpatel60/expense-tracker`.
Switch it to SSH with:

```
git remote set-url origin git@github.com:dvkpatel60/expense-tracker.git
```

Then connect the repo in Netlify. `netlify.toml` sets the build command,
publish directory, Node version, cache headers and a content security policy;
nothing needs configuring in the dashboard except one variable:

| Variable | Where | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Site settings > Environment variables | Read by the merchant lookup function at request time |

Leave it unset and the app still works — every local rule still runs, and
merchant identification returns 503 with a message saying it is not configured.

### Why there is a serverless function

An API key cannot live in a browser bundle. `netlify/functions/enrich.mts`
holds the key, and the client posts nothing but a list of merchant strings. The
function re-validates that list before forwarding it: non-strings, oversized
batches and anything starting with `etransfer:` are rejected, so the privacy
boundary is enforced on the server rather than merely promised by the client.

The CSP sets `connect-src 'self'`, so even a compromised dependency could not
exfiltrate to a third-party origin from the page.

### Two build targets

- `npm run build` — chunked output for Netlify, lookups via `/api/enrich`
- `npm run build:singlefile` — everything inlined into one HTML file you can
  open from disk. No server behind it, so merchant lookup only works where
  something else supplies credentials.

## Commands

```
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test            # vitest
```
