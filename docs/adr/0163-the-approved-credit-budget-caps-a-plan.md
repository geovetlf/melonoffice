# ADR-0163: the credit estimate a person approves is the plan's budget

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0028](0028-planner-delegation-and-workflows.md) (plan estimates), [ADR-0123](0123-credit-core-buckets-and-holds.md) (Credit Core holds), [ADR-0157](0157-plan-trace.md) (plan trace credits), [ADR-0162](0162-a-failed-branch-ends-only-itself.md) (a failed step ends its branch)
- Product decision: Geovet, 2026-10-04 14:19Z, decision 5.
  - The credit budget the user approves is the most that execution of the plan may use. It is not a price and does not touch D-12.
  - A step that would pass it does not run: it is blocked with its reason, what was used and what it needed, and it is traceable. Credits never go negative.
  - Only the existing Credit Core is used.
  - Sub-decision, as recommended in "Decisiones de producto que bloquean el motor" and approved with it: an unknown estimate sets no budget, and the plan says so, rather than blocking it.
- Terraform: none. Firestore: none (a new optional field on the plan document). Prompts: none.

## Context

A plan version carries an estimate in credits (ADR-0028). It is `estimated` only when every agent step has a token budget, a routable model with a known price, and the credit rate. A person approves that exact version, estimate included.

Each AI call already holds, settles and releases credits through the Credit Core. Nothing stopped a plan from using more than the estimate the person saw.

## Decision

1. **The budget** is the approved version's estimate in credits, when it is `estimated` (`creditBudgetOf`). An unknown estimate sets no budget. Plans run as before, and the plan screen keeps showing that the estimate is unknown.
2. **What the plan has committed:**
   - the credits its runs used: every child it had, retries included, read from the same records the trace reads (`createPlanSpending`, the Credit Core's charges as each call recorded them);
   - plus the estimate of each step still running;
   - plus the estimate of each step started in the same pass.
3. **Before a step starts:**
   - Its estimate must fit in what is left of the budget. Retries count.
   - A step that does not fit waits while another step runs, because a run may use less than its estimate.
   - With nothing running, what was used is final. The step is then **blocked**:
     - recorded once on the plan (`budgetBlocks`: used, needed, budget, when);
     - audited (`plan.step_blocked`, reason `budget_exceeded`);
     - it never starts, its node fails with `budget_exceeded`, and its branch ends (ADR-0162).
   - It is never asked for a person's approval.
4. **No meter, no start.** The conductor needs a meter wherever a step of a budgeted plan starts. Without one, no such step starts. The worker and both API conductors (run and resume) have one.
5. **Shown.**
   - `GET /plans/:id` lists `budgetBlocks`.
   - The step reads `failed` with failure `budget_exceeded` in `/steps` and `/trace`.
   - The trace already shows the credits each step used.
6. **What it does not do.**
   - It holds nothing and charges nothing: each AI call still holds, settles and releases through the Credit Core, which never lets a balance go below zero.
   - A step that runs past its own estimate is not cut off mid-call. The next step then finds less room.

## Today in DEV

No server builds a plan estimator yet, and workflow steps have no token budget. So every plan's estimate is `unknown`, and no plan has a budget yet. The cap applies as soon as plans carry known estimates. Wiring the estimator, and token budgets for workflow steps, is separate work.

## Evals

No prompt, model context, routing or model changes. No run is needed and V3 stays the baseline.
