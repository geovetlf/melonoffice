# ADR-0161: a tool step's input can come from earlier steps' results

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps, fixed input), [ADR-0154](0154-tool-results-reach-later-plan-steps.md) (tool results kept for later steps), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (read-only tool steps)
- Product decision: Geovet, 2026-10-04 14:19Z, decision 3.
  - A tool's input comes from fixed values, explicit and validated references to earlier steps' results, or authorized tenant context.
  - A model never freely writes the arguments of a tool of medium risk or higher.
- Terraform: none. Firestore: none. Prompts: none.

## Context

A tool step's input was fixed when the plan was made (ADR-0151). A later tool step could not use what an earlier step found, such as the topic a first search returned. The only way was for an agent to read the result and answer in words.

## Decision

1. **`inputFrom` on tool steps.** A tool step may name, per input key, where that value comes from:
   - `{ step }`: the answer of a specialist step;
   - `{ step, field }`: one field of a tool step's kept result.

   A key is either fixed in `input` or referenced, never both. At most 10 references. Key and field names are plain names. Authority or credential names are refused like they are in `input`.

2. **Only results that exist before it runs** (plan stage, `invalid_input_ref`). Every plan and every saved workflow is checked:
   - the answer of its own specialist step, or of a specialist step it waits for, directly or through others;
   - a field of a tool step it waits for in the same work;
   - a field of a tool step that an earlier specialist step used. That work ended with the tool.
3. **Of the right type** (policy stage, `invalid_tool_input_ref`):
   - the key is an input the tool has;
   - a referenced field is in the source tool's output schema and has the same type (lists: the same items; an integer may fill a number).

   The fixed input must satisfy the tool's schema except for the referenced keys. The Tool Gate checks the whole input when the step runs.

4. **No model-written arguments for riskier tools** (`tool_input_from_model`). An agent's answer is model text. It may fill only a text input of a low-risk tool, cut to that input's length. A tool's own result is not model text, so it may fill an input of any tool a plan can run.
5. **No references where a person approves** (`input_ref_needs_fixed_input`). An approval binds the tool call's exact input (ADR-0151). An input known only when the step runs is never put to a person, so a tool step that needs an approval takes fixed input only.
6. **Read on the server, as data.** When the step runs, the plan step's work reads each reference:
   - from the plan's own child executions, for the plan's organization only;
   - into the input, which then goes to the Tool Gate.

   A missing result, or a value that looks like a credential (G-7), means the tool does not run (`input_unavailable`). Nothing is guessed. The value is input to a tool, never an instruction to a model.

7. **Shown.** `GET /plans/:id` lists a tool step's `inputFrom` beside its `input`.

## Not done

- The planner's prompt does not mention `inputFrom`. Teaching the model about it would be a prompt change, with an eval run first. References come from workflows (and their editor, next) or from any proposal that states them. Either way they are checked as above.
- "Authorized tenant context" as an input source is already covered by the server: the organization, the agent and the person never come from the input.

## Evals

No prompt, model context, routing or model changes. No run is needed and V3 stays the baseline.
