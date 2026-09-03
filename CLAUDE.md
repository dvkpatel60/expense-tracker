# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is for

Local-first expense tracking and bill splitting for someone who runs 3–5 Canadian
bank/card accounts and repeatedly fronts money for a rotating group of friends.
It answers one question the bank cannot: **of the money that left my accounts,
how much was actually mine?**

Three consequences drive most design decisions:

- **Multi-account** means the same dollar appears twice (a card payment is a debit in
  chequing and a credit on the card), so `core/pairing.ts` exists and spend excludes
  paired transfers.
- **Bill splitting** means every total has two figures — cash out and your share — and
  they must reconcile exactly, so money is integer cents and splits allocate by
  largest-remainder.
- **Interac e-transfers are people, not merchants.** They bypass the merchant pipeline
  entirely and settle against a *net* position per person, because claims accumulate in
  both directions with the same friend.

`README.md` records the rationale behind each of these, including the bugs that motivated
them. Read it before changing `normalize.ts`, `split.ts`, or `pairing.ts`.

## Commands

```
npm run dev              # Vite dev server
npm test                 # vitest run — 10 files, 107 tests
npm run test:watch
npm run typecheck        # tsc --noEmit
npm run verify           # typecheck + test + build. Run this before claiming done.
npm run build            # Netlify target: chunked, lookups via /api/enrich
npm run build:singlefile # SINGLEFILE=1: everything inlined into one HTML file
```

Single test file or case:

```
npx vitest run tests/split.test.ts
npx vitest run tests/split.test.ts -t "keeps the invariant"
```

## Layering

Dependencies point one way only. `core/` is the bottom and imports nothing else.

```
ui/  →  parsers/ · store/ · enrich/  →  core/
```

- **`core/`** — pure domain. No I/O, no React, no `window`, no `Date.now()` outside the
  injected `Clock`. This is what makes the whole pipeline testable end to end; do not
  reach for a browser global here, add an injected interface instead (see
  `KeyValueStore`, `EnrichmentTransport`, `Clock`).
- **`parsers/`** — know CSV shapes and nothing about the domain. They emit `RawRow` plus a
  list of rejections with reasons; they never throw on a bad row and never drop one
  silently.
- **`store/`** — versioned persistence behind `KeyValueStore`. Never touches `localStorage`
  directly; `ui/storage.ts` supplies the browser implementation.
- **`enrich/`** — merchant identification behind `EnrichmentTransport`. Two transports
  (`proxy.ts` for deployed builds, `anthropic.ts` for the single-file build) share one
  defensive `parseResponse`.
- **`ui/`** — React. All domain logic is called, never reimplemented.

`netlify/functions/enrich.mts` imports from `src/enrich/prompt.js` so the prompt, model id
and batch cap cannot drift between client and server.

## State model

The whole domain is one immutable value, `LedgerState` (`core/ledger.ts`), and every
mutation is a pure `(state, …, clock) => state` transition in that file. There is no
reducer, no store library, no mutation anywhere.

- `ui/useLedger.ts` holds exactly one `useState<LedgerState>` and wraps each core
  transition. Persistence is a debounced (500 ms) effect on that state.
- `Clock` is injected so ids and dates are reproducible. Tests use `counterClock()`
  (`tx:0`, `tx:1`, …); the app uses `systemClock()`.
- New domain behaviour belongs in `core/ledger.ts` as another transition, with the hook
  gaining a thin wrapper — not as logic inside a component.

## Conventions that will bite you

**Relative imports carry a `.js` extension even from `.ts` files** (`./money.js`,
`../core/types.js`). This is uniform; match it. The netlify function test imports
`../netlify/functions/enrich.mjs` for the same reason.

**`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on.** Hence the
conditional-spread idiom for optional fields, used everywhere:

```ts
...(facts?.note ? { merchantNote: facts.note } : {}),
```

Assigning `undefined` to an optional property will not compile. Indexed access returns
`T | undefined`, hence the `?? ZERO` / `!` patterns in the allocation code.

**Money is `Cents`, a branded number.** Construct it with `cents()`, never a cast. Any
division across people goes through `allocate` / `allocateEven`; two independent roundings
is how a split ends up a cent short. `computeSplit` throws `SplitError` if
`sum(claims) + myShare !== abs(amount)`, and that invariant is property-tested over
thousands of randomized shapes in `money.test.ts` and `split.test.ts`.

**Dates are `ISODate` strings (`YYYY-MM-DD`), never `Date` objects,** in the domain.
Timezones ruin ledgers. Date *order* is declared by the parser, and `inferDateOrder` only
resolves M/D/Y vs D/M/Y when a day above 12 proves it — otherwise the parser records a
rejection saying so rather than transposing a month silently.

**Comments explain why, usually by citing the failure that motivated the code.** Match that
density and tone; do not add comments that restate the code.

## Task recipes

**Adding a financial institution.** One file in `src/parsers/`, one entry in the `PARSERS`
array in `parsers/index.ts`, one fixture in `src/parsers/__fixtures__/`, one block in
`tests/parsers.test.ts`. `detect()` returns 0–1 and must stay above `generic`'s ceiling
(0.2) for files it owns; `generic` is the last resort and deliberately scores low.

**Changing normalization.** `core/normalize.ts` is an ordered list of named steps, each
individually testable via `traceNormalization`. No step may empty the string (that guard
exists because a greedy geography rule once reduced `SQ *BLUE DOOR COFFEE TORONTO ON` to
`BLUE`). Cities come off a list in `geography.ts`, never by a generic pattern. Stability is
a test: three spellings of one cafe must produce one key, or the merchant cache misses and
you pay for the lookup twice.

**Changing `LedgerState`'s shape.** Bump `CURRENT_VERSION` in `store/schema.ts`, add a
migration to `MIGRATIONS` in `store/migrations.ts` keyed by the version being migrated
*from*, and add a case to `tests/store.test.ts`. Migrations compose, so an old install
upgrades in one load. `load()` never throws — it returns an empty ledger plus a warning.

**Categorization.** Rules are data (`CategoryRule`), not code. A malformed user regex is
skipped, never fatal. A manual override writes a user rule at priority 1000 so the next
import of that merchant lands correctly, and enrichment must never overwrite
`categorySource === "user"`.

## The privacy boundary

Only normalized merchant strings cross the network. Amounts, dates, balances, account
numbers and counterparty names are structurally absent, not merely omitted. Enforcement is
in three places and all three must stay in sync:

1. `enricher.ts` — filters `etransfer:` keys out of the request and only requests
   cache misses.
2. `netlify/functions/enrich.mts` — re-validates the list server-side (types, length,
   count, no `etransfer:` prefix) so the boundary is enforced, not just promised.
3. `netlify.toml` — CSP sets `connect-src 'self'`, so nothing on the page can reach a
   third-party origin.

`tests/enrich.test.ts` asserts no dates or balances appear in the request body. Keep that
assertion honest when changing the transport.

The API key lives only in the Netlify env var `ANTHROPIC_API_KEY`. Unset, the app still
works fully on local rules and lookup returns 503 with a message. `VITE_ENRICH_MODE` is
defined by `vite.config.ts` and selects `proxyTransport` vs `anthropicTransport`.

## Testing notes

- `tests/setup.ts` stubs `getBoundingClientRect`, `offsetHeight`/`clientHeight` and
  `ResizeObserver`, because happy-dom does no layout and the virtualized Activity list
  would otherwise render zero rows. Row heights are keyed off the `data-index` attribute —
  if you change how virtualized rows are marked up, update this file or `app.test.tsx`
  will fail confusingly.
- `tests/app.test.tsx` drives the real `App` through the real fixtures (load samples →
  split a bill → settle it). It exists because an earlier version compiled and never
  rendered.
- `ui/samples.ts` imports the same `__fixtures__` CSVs via `?raw`, so the demo exercises
  the production code path.

## Repository state

`origin` is `git@github.com:dvkpatel60/expense-tracker.git`, and the default branch here is
`master` (the README's deploy instructions say `main` — reconcile before the first push).
`expense-tracker-repo.tar.gz` sits untracked at root and is gitignored; it is a snapshot,
not an input to the build.

`README.md`'s "Known gaps" section is partly stale: it says "No UI. Next step." and "94
tests", but the UI shipped and there are 107. Still accurate: no FX conversion
(`originalAmount` is carried but never applied), no person merge/unmerge operation, and no
rate limiting or retry on enrichment.
