# ADR-0175: plan_proposal@7, and reading a tool performed by an agent's role

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0173](0173-reading-tool-steps.md) (reading tool steps), [ADR-0174](0174-plan-proposal-6.md) (@6, measuring with `--repeat 3`)
- Product decision: Geovet, 2026-10-05 18:34Z, accepted the proposal that followed @6's measurement: @3's language line with his addition, the role reading for p14, and recording unresolved references.
- Terraform: none. Firestore: none. Models and providers: none. Agent Engine, conductor, validator and Credit Core: unchanged.

## Context

Measured with three repetitions per case (17:45Z), @6 scored 30/48 against @3's 34/48.

- Its one deterministic regression was language: p03, p07, p12 and p16 are Spanish requests, and each failed the language check 3/3. Language passed 33/37 on @3 and 22/32 on @6.
- @3's rule said only "in the language of the request". From @4 to @6 the rule added "even though ids, tools and departments are in English". The likely cause is that this mention of English pulled the answers into English. That is inferred from the data, not proven.
- One p14 repetition wrote the tool first with a `performedBy` that named no specialistId, department or step, so the reading left it as written (`unknown_performer`). The run file did not record what it named. The likely candidate is the agent's `roleId`, which the planner context shows.

## Decision

1. **`plan_proposal@7`** goes back to @3's language line, adds Geovet's exception, and does not mention English: "Write the summary, labels, question and notPossible in the language of the request, unless the person explicitly asks for another language." No examples, and nothing else in the prompt changes. @6 is frozen in the evals (`--prompt 6`).
2. **`resolveToolSteps` also accepts a `roleId`** that exactly one agent has, under the same rule as a department. A role shared by two agents is `ambiguous_agent`, and the validator refuses it.
3. **The eval run file records what an unresolved tool step named**, as `<tool>:<why>="<performedBy>"`, cut to 60 characters, after the run's secret redaction.

## What a person sees

Nothing new. A plan whose tool names its agent by role now reads as the same ready card as any valid draft, and a shared role still shows the existing invalid-draft message.

## Evals

@7 runs with `--repeat 3` against the @3 run already stored (`~/evals/PLANNER-V3-R3.json`). It replaces @3 only if, case by case:

- nothing that is stable on @3 regresses;
- p02, p06, p08, p12 and p14 pass;
- language holds on the Spanish cases.

A single failed repetition is read as variance only when the case also varies on @3.
