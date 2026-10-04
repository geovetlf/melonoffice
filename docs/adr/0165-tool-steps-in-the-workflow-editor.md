# ADR-0165: tool steps in the workflow editor

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0144](0144-policy-checks-and-branches-in-the-workflow-editor.md) (writing workflows), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (read-only tool steps), [ADR-0161](0161-tool-step-input-from-earlier-steps.md) (inputs from earlier steps), [ADR-0164](0164-workflow-tool-steps-are-planned-where-tools-run.md) (workflow tool steps are planned)
- Product decision: Geovet, 2026-10-04 14:19Z, decisions 1 to 3 and priority 6 ("UI del editor").
- Terraform: none. Firestore: none. Prompts: none.

## Context

Workflows could hold tool steps (ADR-0159), but only through the API. The editor wrote agent steps, policy checks and waits. A workflow with a tool step could not be edited at all ("only through the API").

The editor did not know which tools a step may use or what their input is. The tool view showed no schemas.

## Decision

1. **The tool view shows a step's fields** (`GET /tools`, `tool.read`). Each version has `step`:
   - for a version a plan may run as a tool step (it changes nothing, is internal and needs no credential, ADR-0159): the top-level fields of its input and output, with name, type, whether required, and the string or number limits;
   - for any other version: `null`.

   Required permissions, credentials and the provider stay hidden.

2. **The workflow view shows a tool step's `input` and `inputFrom`** (`GET /workflows/:id`), so the editor can show and rewrite it.
3. **The editor writes tool steps.** "An agent uses a lookup tool" is a kind of step. It is offered only when the catalogue lists such a tool and an agent step comes before.
   - **Who uses it:** an earlier agent step. The tool step waits for that step alone. No step waits for a tool step: they wait for its agent step, whose work ends with the tool.
   - **Which tool:** the newest version of each active tool with `step`. Its input must be plain values (text, number, yes/no) for the editor to fill.
   - **Each input** is one of:
     - a fixed value, typed by the field (text with its length, a list choice, a number with its limits, yes/no);
     - the answer of the agent step or a step it waits for. This is text only, and only for a low-risk tool, because an answer is model text (ADR-0161, `tool_input_from_model`);
     - a field of the same type from another agent's earlier tool step, when the agent step waits for that agent's step. An integer may fill a number. Lists are not offered.
   - Moving or removing a step drops what it leaves invalid: the agent step, references that no longer exist, and waits on a tool step.
   - A saved tool step that the editor could not write back unchanged keeps the workflow "only through the API", as before. Examples: one that waits for other steps, one that asks for approval, or one whose input is not plain.
4. **The server decides.** Saving checks the structure (ADR-0156), and planning checks the tool, the agent's tools, risk, references and permissions (ADR-0159, ADR-0161). The editor only offers what those checks accept.

## Not done

- Tool approvals on a tool step: the editor sets none. The tool's own policy still asks for one when it needs it, and then its input must be fixed (ADR-0161).
- A tool step that waits for another tool step of the same agent. The plan validator allows it, but the editor does not write it.

## Evals

No prompt, model context, routing or model changes. No run is needed and V3 stays the baseline.

## Consequences

Tests:

- `apps/api`: the tool view shows `step` only for a read-only version (`tools.test.ts`). A workflow's tool step is shown with `input` and `inputFrom` and then planned (`plans.test.ts`).
- `apps/web`:
  - writing a tool step with a fixed value and with an agent's answer;
  - a saved tool step shown and saved unchanged (`automations.test.tsx`);
  - the offered tools, sources and clean-up (`toolSteps.test.ts`).
