# ADR-0168: one truth for drafts, before GIA writes workflows

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0101](0101-harness-multi-step-limits-and-handoff.md) (the Harness's plans), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0156](0156-workflow-structure-checked-on-save.md) (saving checks the structure), [ADR-0164](0164-workflow-tool-steps-are-planned-where-tools-run.md) (tool environment), [ADR-0167](0167-the-editor-and-the-plan-speak-the-engines-truth.md) (one rule for who does a role)
- Product decision: Geovet, 2026-10-05 07:45Z, Block 3 phase F0. The phase is authorized with decisions B5 to B9. It forbids a second source of truth, a second planner or a second engine.
- Terraform: none. Firestore: none. Prompts: none. The planner's prompt `plan_proposal@1` is unchanged; its eval baseline comes first (F1).

## Context

The audit of Block 3 (GIA → workflow) found what must hold before a model drafts a workflow.

1. **The plan validator accepted step kinds no plan runs.** These were approval, verification and parallel steps, and conditions on how a step ended. The conductor refuses such a plan only when it is approved (`plan_not_runnable`), after a person has read it.
2. **The Harness never reached a model for a plan.**
   - Its planning call's request id had a colon (`harness:<id>`). The AI Gateway refuses that, so every multi-step plan failed with `invalid_request`.
   - Its plan validator had no tool environment either. Every tool step would have been refused with `environment_not_allowed`.
3. **GIA could create, version and switch a workflow.** `workflow.manage` was the only check, and GIA acts with the person's permissions.
4. **A draft could not be checked without saving it.** Saving checks only its structure. Whether its roles have agents, and its tools, agents and permissions fit, was known only when it was planned.
5. **The editor guessed what a plan does with a tool from the tool list.** It knew the tools an agent's skills grant. It did not know whether a plan takes a tool as a step, or whether the step asks for approval first.

## Decision

1. **Only runnable steps are proposed.**
   - The validator refuses, at the schema stage, any step the conductor's own `unrunnableStepOf` would refuse: `step_not_runnable`, at `steps.<n>`.
   - It asks that rule one step at a time and keeps no list of its own.
   - Tool steps are still checked by the plan stage (`invalid_performer`).
   - The conductor is unchanged. Plans stored before this keep being refused when approved.
2. **The Harness plans.**
   - Its request id is `harness-<id>`.
   - Its validator uses the server's tool environment, the same setting as workflows (ADR-0164).
   - Its risk policy is unchanged: every Harness plan waits for a person, and critical is denied.
3. **Only a person writes a workflow.** Creating, versioning and changing a workflow's status need `actor: user`, like planning one. GIA proposes; a person saves.
4. **A dry run of a draft.**
   - `WorkflowService.check` checks the steps exactly as a save does.
   - It binds each role with `assigneeOf`, the rule `bind` uses.
   - It hands the proposal to the plan validator itself, through `PlanService.check`.
   - It stores nothing, records nothing and starts no execution.
   - It needs `workflow.manage` and `plan.create`.
   - `POST /workflows/check` answers `ok: true` with each step's agent and approval, or `ok: false` with the stage and codes.
5. **Which tools a plan takes, from the validator.**
   - The policy stage's rule for a tool alone is one function (`toolRule`). It covers whether the tool is active, runtime-invocable, in this environment, allowed for the department type, allowed by policy, and read-only.
   - The validator uses it for every tool step. `PlanValidator.toolUse` answers it for the editor.
   - `GET /workflows/assignees` now gives each tool of an agent `step: { usable, riskLevel, approvalRequired }` or `{ usable: false, reason }`.
   - There is still no Agent→Tool table: the tools are the agent's `configuration.tools`, from its skills.

## The person's view

- **Editor (advanced mode):**
  - A tool the agent has but no plan takes reads "not available as a step", with why. For example: steps only read data for now, and this tool changes something.
  - A usable tool that asks first says "It will ask for your approval before using it."
- **Saving:** the editor asks the dry run first. If planning would refuse the draft, nothing is saved, and the editor says why in the words a plan refusal uses, with the step and the folded codes. If the dry run cannot be reached, the draft is saved as before, and planning still decides.
- **INTERNAL ONLY, no UI required:**
  - the runnable-kind check (the planner and workflows meet it as a refusal they already explain);
  - the Harness's request id and environment (the person sees a plan instead of a hand-off);
  - the person-only rule (no screen lets GIA save a workflow).

## Consequences

- A model's plan with a step no plan runs is refused when it is proposed, not after a person approves it.
- The Harness's planning call now reaches the AI Gateway, with an environment for its tool steps.
- In DEV it still gets no model. The API's policy catalogue has no `agent_task@2`, the policy a template agent names, so the gateway answers `policy_not_found` and the Harness hands the task to a person, as before.
- Registering that existing policy in the API is a routing change. It is left for after the planner's eval baseline (F1).
- GIA's future workflow card (B9) can show what a draft would do and who does each step, through the dry run. It cannot save the draft itself.

## Evals

No prompt, model, routing or agent context changed. The planner's prompt is unchanged. Its baseline eval (`plan_proposal@1`) comes next, in F1.
