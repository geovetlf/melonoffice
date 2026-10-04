# ADR-0145: following checks, branches and skipped steps in a running plan

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0075](0075-plan-conditions.md) (decision conditions), [ADR-0144](0144-policy-checks-and-branches-in-the-workflow-editor.md) (checks and branches in the editor)
- Terraform: none. Firestore: none. Prompts: none.

## Context

ADR-0144 let the editor write policy checks and branches. The plan screen still showed only agent steps.

- A check's decision did not appear.
- A step after a check that stopped its branch was never started, so it read "Waiting" for ever.
- The credit estimate of a plan was in the API but not on the screen.
- A refused plan showed only a code.

An audit of the advanced steps found the following.

| Capability                                           | State                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sequence, dependencies, branching, parallel branches | Exist in the engine. In the editor since ADR-0144. Independent branches run side by side.                                                           |
| Conditions on company policy                         | Exist (WF-4). In the editor since ADR-0144.                                                                                                         |
| Conditions on an earlier step's result or answer     | The runtime refuses the older `condition` form. Inputs from answers need a closed mapping (ADR-0075 Open).                                          |
| Human approval                                       | The whole plan is approved before anything runs (every workflow plan waits). An approval node inside a running plan does not exist (ADR-0075 Open). |
| Tool calls                                           | `tool` steps are validated but never run. Needs runtime work and decisions on tool risk, irreversible actions and credits.                          |
| Waits and delays                                     | Not in the engine. A new runtime capability (scheduling).                                                                                           |
| Handoff                                              | Exists for conversations (AE-9), not in plans.                                                                                                      |
| Retries                                              | `retry` is validated and stored, but the conductor does not use it. Provider retries and fallback happen in the AI Gateway.                         |
| Timeouts                                             | AI Gateway call timeouts. Stale executions are swept every 3 h (ADR-0121). No per-step timeout.                                                     |
| Pause and resume                                     | A workflow can be paused, so no new plans are made. A running plan cannot be paused, only stopped.                                                  |
| Cancellation                                         | Exists: "Stop this plan" (ADR-0029).                                                                                                                |
| Credits                                              | Every agent step's AI call holds, settles and releases through the Credit Core (D-12). The plan carries an estimate.                                |
| Audit                                                | Exists: plans, decisions and executions are audited.                                                                                                |
| Validation before launch                             | Exists: the server checks a workflow on save and a plan before approval.                                                                            |

Only these were exposable now without new runtime behaviour or a product decision:

- the check results;
- the skipped steps;
- the estimate;
- readable refusals.

## Decision

1. **One rule for where a step is.** `planStepStates` in `@melonoffice/planning` is the conductor's own rule: a step that has not started, after a stopped or skipped step, is `skipped`. The conductor and the API both use it, so the screen never disagrees with what runs.
2. **`GET plans/:id/steps` lists every runnable step.**
   - Each step carries `kind` and `state`.
   - A check adds `outcome`: what its decision said, never its reasons or evidence, which stay in the decision's own audited record.
   - Agent steps keep every field they had.
3. **The plan's step view adds `decision`** (type, `continueOn`, fixed input).
4. **The plan screen shows:**
   - each check and its result ("Allowed: the steps after it go on", or "Not allowed without approval: the steps after it were skipped");
   - "Skipped: a check stopped this branch" on skipped steps;
   - the estimate in credits before approval, only when one exists, labelled as an estimate and never as a charge;
   - a plain reason for the refusals a person can act on (no agent with the role, a missing permission, a department or plan the policy does not allow), and the code otherwise.

## Product decisions recorded, not taken

- Tool steps in workflows: which tools, at what risk, with what approval and credits.
- An approval node inside a running plan, and what the "Ask me before this step runs" checkbox should mean once it exists. Today the whole plan is approved first.
- Waits and delays between steps.

## Evals

No prompt, model context, Agent Engine behaviour, routing, tool or policy changes. Reading where steps are changes nothing that runs. No run is needed, and V3 stays the baseline.

## Consequences

- Tests:
  - `apps/api/src/plans.test.ts`: the steps of a plan with a check that stopped its branch, its decision in the plan, and another organization refused.
  - `apps/web/src/automations/automations.test.tsx`: the estimate, a check's result, a skipped step and a plain refusal.
- The conductor's own tests are unchanged and still pass on the shared rule.
