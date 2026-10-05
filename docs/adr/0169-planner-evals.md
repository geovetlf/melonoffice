# ADR-0169: the planner's evals

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0028](0028-planner-delegation-and-workflows.md) (the planner), [ADR-0134](0134-evals.md) (evals), [ADR-0168](0168-one-truth-for-drafts-before-gia-writes-workflows.md) (only runnable steps are proposed)
- Product decision: Geovet, 2026-10-05 07:45Z, Block 3 phase F1. Measure `plan_proposal@1` first and change it only after its baseline.
- Terraform: none. Firestore: none. Prompts: none. `PLANNER_INSTRUCTIONS` and its digest are unchanged.

## Context

Before GIA drafts workflows, the planner's prompt has to change: it still offers step kinds no plan runs and has no way to ask back. A prompt change needs evals ([ADR-0133](0133-prompt-versions.md)), and the planner had none. The planner's call also asked the AI Gateway for the `structured_output` capability, which the Vertex AI adapter does not serve, so in DEV the call could never reach a model.

## Decision

1. **One eval runner, two tasks.**
   - `runEvals` takes an `EvalTask`: the prompt version, the messages, the output limit, the answer schema, the scoring and what the run file keeps.
   - The agent task is the default. The planner is `PLANNER_EVAL`.
   - Routing, budget, fallback, cost and the comparison are the same code for both.
   - `cli.js run --set planner` runs the planner's cases.
2. **The planner's own messages.** `plannerMessages` builds the call the planner makes: its fixed instructions, the candidates as data and the person's request. The evals send exactly those.
3. **Sixteen cases**, covering the 13 kinds Geovet set: runnable kinds, valid roles, tools really assigned, valid inputs, valid references, valid dependencies, no cycles, approval when asked, an impossible request without invention, a vague request asked back, no needless personal data, Spanish and English.
   - The office is synthetic: four agents with fixed ids, as their templates make them. Sales has three tools, marketing one, research and finance none.
4. **Scored by the plan pipeline itself, not by new rules.**
   - The shape is `checkProposal`.
   - The structure, dependencies, references and cycles are `checkStepStructure`.
   - Runnable kinds are the conductor's `unrunnableStepOf`.
   - The plan is `createPlanValidator` over the synthetic office, with the Harness's risk policy, in DEV.
   - The case's own expectations (departments, tool, order, review, personal data, language) are checked on top.
   - For an impossible request, a question back is as good as a plan of what can be done.
   - Any plan given must be one the validator accepts.
5. **The planning call asks for `text_generation` with JSON output** (`requirements.structuredOutput`), which is what the Vertex AI adapter serves. The prompt and the model are unchanged.
6. **The comparison has a `planning` category** for the plan checks.

## Consequences

- The first real run (PLANNER-BASELINE-V1) is made by Geovet in Cloud Shell; see [docs/evals/README.md](../evals/README.md). It costs well under 1 credit.
- The current prompt is expected to fail some cases:
  - it offers approval, verification and parallel steps, which are now refused;
  - it has no way to ask back;
  - it does not say a Harness tool step needs a fixed input. Under the Harness's risk policy every tool step asks a person first with its exact input, so a reference to an earlier result is refused (`input_ref_needs_fixed_input`).
- The next prompt (`plan_proposal@2`) is compared with this baseline and is accepted only if nothing that passed now fails.
- The Harness still gets no model in DEV: the API's policy catalogue has no `agent_task@2` (ADR-0168). That routing change is separate and not made here.

## Evals

No prompt, model, routing or agent context changed. This adds the planner's evals; its baseline comes from them.
