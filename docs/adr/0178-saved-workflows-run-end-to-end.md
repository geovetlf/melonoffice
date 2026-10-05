# ADR-0178: a saved workflow runs end to end on the engines that exist

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0070](0070-approved-plans-run.md) (plans run), [ADR-0146](0146-step-approvals-inside-running-plans.md) (step approvals), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0152](0152-wait-steps-in-plans.md) (waits), [ADR-0153](0153-failed-plan-steps-run-again.md) (retries), [ADR-0154](0154-tool-results-reach-later-plan-steps.md) (results between steps), [ADR-0162](0162-a-failed-branch-ends-only-itself.md) (failed branch), [ADR-0177](0177-gia-offers-workflow-drafts.md) (GIA → workflow)
- Product decision: Geovet, 2026-10-05 22:21Z, Block "ejecución real de planes/workflows": close any gap between "GIA saved a valid workflow" and "it runs end to end, safely, correctly and observably", reusing the Agent Engine, Harness, plan conductor, Tool Gate, Credit Core, approvals, Cloud Tasks and audit. No new engine.
- Terraform: none. Firestore: none. Prompts: none (`plan_proposal@3`, the deterministic reader and `agent_task@*` unchanged). Models and providers: none.

## Context

Each piece of a plan's run was built and tested on its own: tool steps, waits, step approvals, retries, results between steps, the failed branch. No test drove a workflow a person saved through the worker's real runtime to its end. Doing that found two defects:

1. **A step after a wait never ran.** The step reads the answers of the steps it depends on. It looked through condition steps to the steps before them, but not through wait steps. A wait has no answer, so the step after it found nothing, asked no model and failed with `input_unavailable`. Any workflow of the shape "do X, wait, then do Y" failed at Y. GIA's own example draft has that shape.
2. **A credential could reach a model in half.** A tool step's result is cut to 4,000 characters before a later step reads it, and only then redacted. A key that straddled the cut no longer matched any credential pattern, so its first half reached the model.

## Decision

1. **A step after a wait reads the answers of the steps before the wait.** `answeringSteps` looks through wait steps as it already does through condition steps.
2. **A tool result is redacted before it is cut.** `toolResultText` runs `redactSecretText` on the whole result, then cuts it to `MAX_TOOL_RESULT_CHARS` (4,000).
3. **One integration test covers the chain**, in memory and on the Firestore emulator (`apps/worker/src/workflow-runs.test.ts`). The worker's real composition runs it: the AI Gateway with the real Credit Core, the Tool Gate, Company Brain, approvals and the conductor. Only the model adapter and the Cloud Tasks queue are fakes. A person saves, activates, plans and approves a workflow:
   - its agent step binds to the real agent of its role;
   - its tool step runs through the Tool Gate;
   - a wait asks to be woken, and a wake before its end moves nothing;
   - a step marked "ask me first" waits for the person;
   - a rejected step skips its branch while the other branch goes on;
   - an expired approval does the same;
   - a provider outage runs the step again once, while a wrong answer is never retried;
   - the plan ends `completed` or `failed` as the engine decides.

   It also checks:
   - each model call holds credits, then settles them, with nothing left held;
   - a repeated wake or decision runs and charges nothing twice;
   - the audit trail is complete;
   - another organization can neither see, move nor decide the plan.

4. **The plan screen says what a running plan waits for.** A plan that is `executing` with no step running now says it waits for the person's approval, waits before its next steps, or is trying a step again. A step waiting to run again reads "Reintentando", not "Esperando". A step whose approval expired reads "Sin aprobar a tiempo", not "Rechazado". The texts for a failed step and a failed check no longer say "the plan stopped" or "the other branches go on", which was not always true. The plan's own banner already says whether the other branches went on.

## What did not change, and why

- **Autonomy is not checked for plan steps.** A plan step's agent cannot use tools mid-task (`tool_use_unsupported`). A plan's tool steps are read-only and internal (D2). So a plan step changes nothing, and the agent's autonomy, which governs actions with effects, has nothing to decide. The person's approval of the plan, and of each step marked "ask me first", is the control. This needs revisiting with B6 (write tools), not before.
- **The plan's credit cap stays inert in DEV.** The cap a person approves (ADR-0163) needs an estimate. The API's plan validator has no estimator (D-12 frozen), so plans have no cap. Each model call is still held and settled by the Credit Core.
- **A tool node may run twice under one idempotency key.** The runtime's own node retry (ADR-0029) runs a failed tool node once more under the same idempotency key. This is separate from the plan's step retry (ADR-0153), which never repeats a step whose tool started. Plan tool steps are read-only, so a repeat changes nothing.
- **Skipped steps have no plan-level audit event.** They are recorded as `execution.node_changed` (`pending → skipped`) on the planning execution. The plan's final `plan.state_changed` names the end.
- **A first step marked "ask me first" does not ask again.** The plan's own approval comes right before it (ADR-0146).
