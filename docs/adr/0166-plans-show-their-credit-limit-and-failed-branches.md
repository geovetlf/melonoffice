# ADR-0166: plans show their credit limit and failed branches

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0162](0162-a-failed-branch-ends-only-itself.md) (a failed branch ends only itself), [ADR-0163](0163-the-approved-credit-budget-caps-a-plan.md) (the approved credit budget caps a plan)
- Product decision: Geovet, 2026-10-04 14:19Z, decisions 4 and 5 ("mostrar qué rama falló y qué pasos se saltaron"; "el plan lo dice" when the estimate is unknown).
- Terraform: none. Firestore: none. Prompts: none.

## Context

The engine records a failed branch and every step the approved credit budget could not cover. Automations still showed only "Failed" for a failed step. Before approval, it said nothing about a credit limit.

## Decision

In Automations:

1. **Before approval:**
   - with a known estimate, the plan says that approving makes the estimate its credit limit, and that a step that would go over it does not run;
   - with an unknown estimate, it says the plan has no credit limit.
2. **A step the limit stopped** says it was not run. It shows what it needed, what the plan had used and the limit, from the plan's `budgetBlocks`.
3. **A failed step** says that the steps depending on it are skipped and the rest goes on. Those steps already read "Skipped".

The web shows only what the API gives. It decides nothing.

## Evals

No prompt, model context, routing or model changes. No run is needed.
