# ADR-0173: reading a planner's tool steps, and plan_proposal@5

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0156](0156-workflow-structure-checked-on-save.md) (the plan's structure), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (tool steps), [ADR-0171](0171-plan-proposal-2-and-workflow-drafts.md) (reading the planner's answer), [ADR-0172](0172-plan-proposal-3.md) (@3 and @4)
- Product decision: Geovet, 2026-10-05 16:12Z, chose a deterministic reading of tool steps over a fifth prompt-only round. @3 stays the stable version in DEV until the real run meets his criteria.
- Terraform: none. Firestore: none. Models and providers: none. Agent Engine, conductor, validator and Credit Core: unchanged.

## Context

The engine runs a tool step inside one specialist step of the agent that holds the tool. `performedBy` names that step, and other steps wait on the specialist step, which ends with its tools.

In every real run so far (@1 to @4), Gemini 2.5 Flash-Lite often wrote the same plan the other way round. It put the tool first, with `performedBy` naming the agent (its specialistId or its department), and then the agent's work, waiting on the tool. The schema stage refused it (`invalid_proposal:steps.0.performedBy`). In @4 this was p02 and p14. Four prompt versions did not teach the model this.

## Decision

1. **`resolveToolSteps` in `packages/planning` reads the reference: agent → that agent's step → tool.**

   The agent is the one the reference names, among the agents the planner was shown. That list is built by `assigneeOf` from each agent's `configuration.tools` and skills (drafts), or by the Harness's own candidates. The reference can name the agent:
   - by specialistId;
   - by a department type only one agent has;
   - or, with no reference at all, by being the one agent in the plan that holds the tool.

   The agent must hold the tool. The step is that agent's specialist step in the plan. When the agent has several, the one that waits on the tool step is taken, or else the one the tool step waits on.

   Once resolved:
   - the tool step waits on that step;
   - whatever the tool step waited on before, the agent's step now waits on, and a tool step of another agent is reached through that agent's own step;
   - steps that waited on the tool step wait on the agent's step;
   - inputs and `inputFrom` are kept unchanged, and every result they read still comes first;
   - the tool step is listed right after its agent's step.

2. **It never guesses or invents.** In each of these cases the reference is left as written, and the validator refuses it:
   - an agent named twice or by nothing known (`ambiguous_agent`, `unknown_performer`);
   - an agent that does not hold the tool (`tool_not_held`);
   - no step of that agent (`no_agent_step`);
   - several steps of that agent with none tied to the tool (`ambiguous_step`).

   It adds no step, agent or tool, and removes none. A cycle it would expose is still a cycle and is refused (`plan_cycle`). The validator stays the only authority.

3. **One reading for every caller.** `planningAnswerOf(output, agents)` applies it for the Harness's planner, workflow drafts and the planner's evals. The answer says what was resolved and what was left (`toolSteps`). The eval run file keeps it as `tool steps: <tool>-><step>` or `<tool>:<why>`.

4. **`plan_proposal@5`** changes one line of @4 only. The language rule no longer carries the "Spanish request, Spanish text" example that p06 followed into Spanish for an English request. No example was added. @4 is frozen in the evals (`--prompt 4`).

## What a person sees

The draft card and the plan pages are unchanged. A plan the model wrote with the tool first used to come back as an invalid draft. It now reads as the same ready card any valid draft shows, with the agent's work and then what it looks up ("Lucía consulta: …").

Checked locally with Playwright on desktop and mobile: melonoffice-plan/p5-shots/. There are no new states, messages or translations.

## Evals

@5 replaces @3 only if:

- the real run shows no regression against @3;
- p02, p06 and p14 pass;
- p07 and p16 still pass;
- p08 is measured (it hit a provider error in @4's run).
