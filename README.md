# Expense Tracker

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/dvkpatel60/expense-tracker)

Local-first expense tracking and bill splitting for Canadian bank exports.
Consolidates RBC, Scotiabank and Wealthsimple CSVs into one categorized ledger,
tracks Interac e-transfers as people rather than merchants, and nets claims
across rotating groups. It answers the one question a bank statement cannot:
**of the money that left your accounts, how much was actually yours?**

## Quick start

```
npm install
cp .env.example .env     # optional — fill in a key to enable merchant lookup
npm run dev
```

Then open <http://localhost:5173> and press **Try it with sample data**.

`npm run dev` runs `scripts/dev.sh`: it loads `.env`, prints which providers are
configured, and starts Vite. A dev-only Vite plugin serves `/api/enrich`, `/api/insights` and
`/api/providers` on the same port from the same function source Netlify bundles,
so the one part of the app that talks to a provider is not the one part you can
only test by deploying. Merchant lookups are cached in an in-memory SQLite table
for the life of the process, because a dev session is dozens of reloads and each
one would otherwise re-buy the same identifications.

The `.env` step is optional. Without a key the app runs on its local rules and
the provider picker says it is not configured; nothing else changes.

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
    digest.ts      Aggregates-only view — the only spending data AI ever sees
  parsers/       One file per FI behind a common interface, plus fixtures
  store/         Versioned persistence with migrations
  enrich/        Merchant lookup behind a provider registry + injectable transport
  ui/            React. Calls the domain, never reimplements it
dev/             Local API server (Vite plugin) + in-memory SQLite merchant cache
tests/           246 tests
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

**Providers are a registry, not a branch.** Adding one is a single entry giving
its request shape, where the text sits in its response, and which env var holds
its key. The prompt, the JSON contract, the batching, the cache and the privacy
filter are shared, so a second provider cannot arrive with a second, subtly
different version of any of them. The model is validated against the registry
server-side: it comes in on a request body, and without that check the function
is an open relay to any model on the account.

**Enrichment is keyed on merchant and injected.** Only normalized merchant
strings cross the network — no amounts, dates, balances, account numbers or
counterparty names. `redactForLookup` enforces it and a test asserts the request
body contains no dates or balances.

**AI analysis sees aggregates, never transactions.** `core/digest.ts` builds the
only spending data that leaves the device: period totals, per-category totals
with a previous-period comparison, top-15 merchant totals, an open-claim count.
`InsightsDigest` has nowhere to put an individual purchase, a day-level date, a
balance, an account or a person, so the limit is structural rather than a
promise — and a test serializes a real digest to assert none of those appear.
The model answers in typed insights the UI renders natively (headline, trend,
anomaly, habit, action), not prose in a chat box, and any insight about a
category links straight to those transactions. Answers are cached per digest, so
nothing is bought twice and no request fires without a click.

## Known gaps

- FX: `originalAmount` is carried on `RawRow` and `Transaction` but no
  conversion or fee attribution is implemented. USD rows import at face value.
- Person merge/unmerge is modelled (`Person.aliases`) but has no operation yet.
- Enrichment has no rate limiting or retry.

## Deploying to Netlify

The code is on GitHub at `dvkpatel60/expense-tracker` (branch `main`), so
deploying is connecting that repo in Netlify and setting keys.

`netlify.toml` already sets the build command, publish directory, Node version,
cache headers and a content security policy, so nothing needs configuring in the
dashboard except the environment variables:

| Variable | Where | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Site settings > Environment variables | Enables the Anthropic models |
| `GEMINI_API_KEY` | Site settings > Environment variables | Enables the Gemini models |

One key enables both features that use a model: merchant identification and
Overview analysis.

Set either, both, or neither. The provider picker in the app is built from
`/api/providers`, which reports which keys are present — so a provider appears
exactly when it is configured. With none set the app still works: every local
rule runs, and merchant identification and analysis return 503 with a message
naming what to set.

### Why there are serverless functions

An API key cannot live in a browser bundle. `netlify/functions/enrich.mts` holds
the keys, and the client posts nothing but a list of merchant strings and which
provider to ask. The function re-validates that list before forwarding it:
non-strings, oversized batches and anything starting with `etransfer:` are
rejected, so the privacy boundary is enforced on the server rather than merely
promised by the client. It also validates the requested model against the
registry — the model arrives on a request body, and without that check the
function would relay any model on the account.

It normalizes the provider's response before replying, so provider envelopes
never reach the browser and adding a provider changes nothing on the client.

`netlify/functions/insights.mts` is the same shape for AI analysis: it takes the
aggregates digest, re-validates it (bounded arrays, known categories, no
day-level date, no counterparty keys) so "aggregates only" is enforced on the
server rather than promised by the client, and returns typed insights.

`netlify/functions/providers.mts` answers `/api/providers` with the catalogue
and, for each provider, whether its key is set. That is what makes the picker
dynamic. Env var *names* travel; values never do.

The CSP sets `connect-src 'self'`, so even a compromised dependency could not
exfiltrate to a third-party origin from the page.

### Two build targets

- `npm run build` — chunked output for Netlify, lookups via `/api/enrich`
- `npm run build:singlefile` — everything inlined into one HTML file you can
  open from disk. No server behind it, so merchant lookup only works where
  something else supplies credentials.

## Commands

```
npm run dev           # app + /api on http://localhost:5173
npm run dev:vite      # plain Vite, no /api routes
npm test              # vitest — 246 tests
npm run test:watch
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run verify        # typecheck + test + build
npm run build         # Netlify target
npm run build:singlefile
```
