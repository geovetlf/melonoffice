# ADR-0125: Plan and credits panel, and what a person sees without credits (D-12, block 3)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0074](0074-ai-usage-ledger.md), [ADR-0123](0123-credit-core-buckets-and-holds.md), [ADR-0124](0124-ai-calls-hold-their-credits.md)

## Decision

1. **Plan and credits panel.** It sits at the top of the AI usage page, for whoever may read credits. Every value comes from routes that already exist, so there is no new API. It shows:
   - the plan;
   - available credits;
   - included and purchased credits;
   - credits reserved for running tasks, when there are any;
   - credits included each month, from entitlements;
   - credits used by AI this month, and the top agents.
2. **What is not decided says so.**
   - The next renewal reads "not set yet".
   - Monthly included credits read "none yet" while the plan gives none.
   - "Buy credits" is shown disabled, saying it is not available yet and will not require a plan change.
   - No price, pack or date is invented.
3. **Out of credits.** GIA and assisted replies say:
   - that the action did not run;
   - the credits available;
   - the options: buy credits when available, review the plan, or wait for the renewal.

   They link to the panel. Nothing upgrades, buys or retries by itself.

4. **Agents never fail silently.**
   - A task stopped for credits says so ("not enough credits", or "used its credit budget") instead of "needs access or permission".
   - It is already handed to a person (ADR-0103).

## Pending

- The period and renewal of a subscription.
- Credits per plan, and the expiry or rollover of included credits.
- The estimated cost shown before an action. The API's refusal does not carry it yet.
- Buying credits (D12-4).
