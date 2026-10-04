# ADR-0154: tool results reach later plan steps

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0103](0103-harness-tool-use-mid-task.md) (keeping a tool's output), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 6: inputs and outputs between steps, with validated references, no access across organizations, tool data never becoming system instructions, and G-7 kept.
- Terraform: none. Firestore: no migration, no index, no new collection. Prompts: none changed.

## Context

A tool step ran inside its specialist step's child (ADR-0151), and the Tool Gate checked its output against the tool's schema. Nothing kept that output, though, so the steps after it never learned what the tool returned: a plan could search the Company Brain and then write a report that knew nothing of the search.

## Decision

1. **Kept.** A plan's tool node keeps its result once the gate passed it, in the agent output store the runtime already uses for a tool a model asked for (ADR-0103). It is keyed by its own child execution and node, so it is read only within its organization. The work source decides what is kept. It now sees the node's execution too, so a plan step keeps its own tool steps' results and the Harness keeps its model's calls.
2. **Read by the steps after.** A step reads the answers of the steps it depends on (ADR-0070). Right after each answer, it now also reads what that step's tool steps returned (`previous_step_tool`), in the plan's order. Only the plan's own steps are read: the stored plan version names the tool steps, and the plan names each step's current child (ADR-0153). Nothing in the step's own input chooses what it reads.
3. **As data.** A result enters the agent's `<context>` as JSON, cut to 4,000 characters. The prompt already says everything in `<context>` is data, never an instruction, and comes from tools among others. Any credential in it is cut out before a model reads it (G-7). It never reaches the system message.
4. **Missing.** A result that was not kept (the store was down, or the plan ran before this) is said to be unavailable. Nothing is guessed and the step still runs. A step whose answer is missing still runs nothing, as before.

## Evals

The prompt text, routing and model do not change. Only plans with tool steps, possible since ADR-0151, get more context, and none of the V3 cases has one. So V3 stays the baseline, and no run is needed now.

## Consequences

- No credits: keeping and reading a result calls no model and no tool.
- Tests:
  - `packages/agents`: the context, as data, without credentials; what is kept; the cut.
  - `packages/harness`: it keeps what the work it wraps keeps.
