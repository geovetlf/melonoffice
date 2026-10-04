# ADR-0158: waits in the workflow editor

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0144](0144-policy-checks-and-branches-in-the-workflow-editor.md) (writing workflows), [ADR-0152](0152-wait-steps-in-plans.md) (wait steps), [ADR-0156](0156-workflow-structure-checked-on-save.md) (structure checked on save)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 2: wait and delay steps.
- Terraform: none. Firestore: none. Prompts: none.

## Context

Plans could hold a wait step (ADR-0152), and a workflow saved through the API could too. The workflow editor in Automations wrote only agent steps and policy checks, though. A workflow with a wait could not be written there, and one saved with a wait could only be changed through the API.

## Decision

1. **A third kind.** Any step after the first can be "Wait a set time": a whole number of minutes, hours or days, at most 7 days, the engine's own limit. It waits for at least one earlier step, as a check does. The editor saves it as `{ kind: 'wait', wait: { seconds } }`. The server checks it again on save (ADR-0156).
2. **Shown and rewritten.** A workflow's version view gives each step's `wait` (`{ seconds }`, or null). The editor shows a saved wait in the largest unit it is a whole number of, and saves it unchanged. A wait of seconds that are not whole minutes is left to the API, as other steps the editor cannot write are.
3. **No change to running.** Plans of a workflow wait as ADR-0152 says. Nothing in the engine changes.

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

Tests:

- `apps/web/src/automations/automations.test.tsx`: a wait written between two steps, its limits, and a saved one shown and kept.
- `apps/api/src/plans.test.ts`: the version view gives a wait's length.
