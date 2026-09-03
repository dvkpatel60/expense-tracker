# Dev Team Session: 2026-09-03

## Topic
Technical design completeness review of expense-tracker app — gap analysis between current MVP and holistic financial tool, with focus on AI integration, expense settling, KPIs, account management, and provider-as-merchant bug.

## PM
- Well-scoped MVP with strong privacy foundations, but UX still demands too much manual effort
- Core value proposition drift risk: adding budgets/recurring detection before polishing current features
- Orphaned Accounts view signals incomplete architecture
- AI feature creep without usage data
- First action: Fix provider-as-merchant bug, un-orphan Accounts, run 5 user interviews
- Question: Do users want AI savings tips, or are we projecting technical capability?

## Architect
- Large gap between mature core domain and incomplete UI surface
- Provider-as-merchant is data corruption that poisons display and rule-matching
- AI architecturally sound but UX-underutilized, no feedback loop
- Local-first is double-edged for holistic tool goal (budget, recurring, export need cross-entity queries)
- First action: Blocklist + data migration for provider names, verify via privacy tests
- Question: Should AI computations stay in core/ or expand InsightsDigest?

## Developer
- Provider-as-merchants bug tells the story: normalization and key-filtering aren't enforcing their contract
- Data contamination must be fixed before any features — poisons KPIs, digests, insights
- Every new AI feature is a new privacy-boundary surface (3 places must change in lockstep)
- 4 split strategies exist but UI only exposes "even" — invariant tests needed for new paths
- First action: Failing regression test for provider-as-merchant, then fix through normalization
- Question: Is contamination from extractText or imported CSV? Which reserved-prefix contract?

## QA
- Provider-as-merchants = data integrity emergency, poisons cache, skews KPIs, corrupts digests
- Privacy boundary must expand deliberately (validateDigest + CSP + tests in lockstep)
- Money invariant is the hard constraint — 4 split strategies need test coverage before UI expansion
- First action: Regression test for provider-as-merchant, assert merchant key never reaches enrichment
- Question: Source of contamination — extractText or CSV data?

## Synthesis
1. ALL personas agree: provider-as-merchant is blocking #1
2. All agree: un-orphan Accounts view (low risk, high value)
3. All agree: privacy boundary must expand deliberately
4. Tension: scope vs. polish (PM cautious, others want fixes first)
5. Tension: AI depth vs. safety (keep boundary tight vs. expand digest)
6. Tension: validate with users before building AI features

## Recommended Priority
1. Fix provider-as-merchant (data corruption)
2. Un-orphan Accounts view
3. Expose all 4 split strategies in UI
4. Add account editing + credit limit import
5. Scope AI expansion after validating user need
