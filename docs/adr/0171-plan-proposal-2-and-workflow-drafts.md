# ADR-0171: plan_proposal@2 and workflow drafts from a person's words

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0028](0028-planner-delegation-and-workflows.md) (the planner), [ADR-0133](0133-prompt-versions.md) (prompt versions), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (workflow step kinds), [ADR-0167](0167-the-editor-and-the-plan-speak-the-engines-truth.md) (`assignees`), [ADR-0168](0168-one-truth-for-drafts-before-gia-writes-workflows.md) (the dry run), [ADR-0169](0169-planner-evals.md) (the planner's evals)
- Product decision: Geovet, 2026-10-05 09:45Z, authorizes Block 3 F2: `plan_proposal@2` on the existing planner, and a workflow draft that GIA proposes and the person reviews and saves (B5, B6, B8, B9 of the Block 3 decisions).
- Terraform: none. Firestore: none. Models and providers: none. New model policy: none.

## Context

The planner's first real run (PLANNER-BASELINE-V1, 09:33Z) scored 0/16 on `plan_proposal@1`. The cause was the prompt, not the scorer:

- it offered step kinds the engine never runs (`approval`, `verification`, `parallel`);
- it gave the model tool ids with nothing about them, so the model invented tools or used one that changes data;
- it had no way to ask back or to say a request cannot be done;
- it left each agent step's verification to the model, which the validator then refused.

GIA could not turn a person's words into a workflow at all.

## Decision

1. **`plan_proposal@2`, on the existing planner.** One set of instructions and messages (`plannerMessages` in `packages/planning`) is sent by the Harness's planner, by workflow drafts and by the planner's evals. It states:
   - only the kinds the engine runs: specialist, tool, wait, and condition only as a policy check;
   - approval as a step property;
   - three answer forms: a plan, `{question}`, or `{notPossible}`.

2. **The model sees only real capabilities.** Each agent is listed by department type and role, with the skills its tools come from. Each tool is described by:
   - the registry: action, whether it changes data, risk, input and output schemas;
   - the validator's own rule (`toolUse`): whether a plan takes it as a step, why not, whether it asks a person first, and whether its input may come from an earlier step.

   The model never gets a person's data, a secret or an organization's ids. Whether a write tool may be a step is the existing policy's decision, never the prompt's.

3. **One reading of the answer (`planningAnswerOf`).** A plan's agent steps always get the one way agent work is checked: the answer is kept and well formed, as the editor writes them. The model never chooses this. A question or a "cannot be done" is not a plan: the Harness hands the task back to a person (`needs_clarification`, `not_possible`).

4. **Workflow drafts (`createWorkflowDrafter`, `POST /workflows/draft`).**
   - **Who:** a person acting directly, with `workflow.manage`, `plan.create` and `gia.ask`.
   - **The call:** in GIA's name through the AI Gateway (`assist`, the `gia_assist` policy, taskType `workflow_draft`), with the agents `assignees()` gives, so there is no second resolution.
   - **The steps:** written by role, then put through `check`, the same dry run as a save and a plan.
   - **What comes back:** `ready` with a deterministic summary built from the validated plan; `invalid` with the stage and codes (never shown as valid, never saved); `needs_clarification`; `not_possible`; `no_agents`; or `failed`.
   - Nothing is stored.

5. **The card (web).** It appears in GIA's chat ("Prepare as an automation") and on Automations ("Create with GIA"). It says:
   - what the workflow does, step by step;
   - who takes part;
   - what information it uses and what it changes;
   - what asks for approval;
   - when it runs: a person starts it, because recurrence is Block 6 (B5);
   - what it ends with.

   Its buttons are Save draft, Adjust in advanced mode (the existing editor, prefilled) and Discard. GIA never saves, activates, approves or runs anything.

## Not changed

- G-7, Guardian, actor checks, approvals, autonomy, RBAC, tenant isolation, audit and D-12.
- The `gia_chat` prompt: the draft is its own call.
- No scheduler, triggers or new tool.
- Drafts offer no policy check steps yet: no check actions are given to the model, so it plans none. A person can still add them in the editor.

## Evals

The planner's cases and dataset digest are unchanged. `--prompt 1` runs @1 again, as it was sent, under the same scoring, so @1 and @2 compare case by case. `compare` prints each check, outcome and language side by side. @2 is accepted only if it does no worse than @1. Real runs are made in DEV by the owner (docs/evals/README.md).
