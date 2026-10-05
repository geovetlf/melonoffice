# ADR-0174: plan_proposal@6, and reading a tool its own agent's step waits on

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0172](0172-plan-proposal-3.md) (@3 and @4), [ADR-0173](0173-reading-tool-steps.md) (reading tool steps, @5)
- Product decision: Geovet, 2026-10-05 17:14Z, after @5's real run (7/15, not merged): a symmetric language rule with no examples, the p12 reading, and measuring @3 and @6 with `--repeat 3` before deciding. @3 stays the stable version in DEV.
- Terraform: none. Firestore: none. Models and providers: none. Agent Engine, conductor, validator and Credit Core: unchanged.

## Context

@5's real run had two deterministic failures and several that looked like noise:

- **Language (p07, p16).** Without @4's "Spanish request, Spanish text" example, Spanish requests were answered in English.
- **p12.** The model named the right specialist step in `performedBy`, but made that step wait on its own tool step. The validator refused it (`invalid_dependency`). ADR-0173's reading skipped any tool step whose `performedBy` already named a specialist step.
- **p01, p11, p13** passed in @4 and failed in @5, with only the language line changed. One sample per case cannot separate a regression from the model's variance.

## Decision

1. **`plan_proposal@6`** changes @5's language line only: "Answer in the same language as the person's request, unless the person explicitly asks for another language", for the summary, labels, question and notPossible, even though ids, tools and departments are in English. It is symmetric and carries no language example. @5 is frozen in the evals (`--prompt 5`).

2. **`resolveToolSteps` also reads a tool step whose `performedBy` already names a specialist step.** It does so only when that step, or other non-tool work, waits on the tool step. The reading is the one ADR-0173 applies:
   - the step ends with its tool;
   - what the tool waited on, the step waits on;
   - work that waited on the tool waits on the step;
   - `inputFrom` and inputs are kept, and the tool is listed after its step.

   It applies only when the step's agent is one the planner was shown and holds the tool. Otherwise the plan is left as written and reported (`unknown_performer`, `ambiguous_agent`, `tool_not_held`) for the validator to refuse. A plan already written the engine's way is returned as it is. Nothing is added or removed, and the validator stays the only authority.

3. **Measurement.** @3 and @6 each run three times per case (`--repeat 3`). A case passes only when all its scored repetitions pass (`compareRuns`). Both runs use today's reading of tool steps, so the comparison isolates the prompt.

## What a person sees

The draft card and the plan pages are unchanged. A p12-shaped answer used to come back as an invalid draft. It now shows as the same ready card as any valid draft: the agent's step, then what it looks up, with its dependency and approval. An answer that cannot be read without guessing still shows the existing invalid-draft message. No new states, messages or translations.
