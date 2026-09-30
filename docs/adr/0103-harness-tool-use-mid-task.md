# ADR-0103: Harness block 5: tools an agent asks for during a task

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (tool levels, `authorizeToolUse`, limits), [ADR-0101](0101-harness-multi-step-limits-and-handoff.md) (steps and depth), [ADR-0076](0076-normalized-tool-calling.md) (normalized tool calling), [ADR-0026](0026-tools-approvals-and-guardrails.md) (Tool Gate and approvals), [ADR-0029](0029-runtime-guards.md) (attempts), [ADR-0031](0031-runtime-advance.md) (runtime)
- Decision: Geovet, 2026-09-30 15:26Z, "Bloque 5: uso de herramientas durante la ejecución de una tarea".
- Terraform: none. Firestore: optional fields only (`approvalRequired` on execution nodes, `toolCalls` on `agentOutputs`). Nothing is migrated or deleted.

## Context

Until now an agent task was one model call that answered. The AI Gateway could already offer tools and return the model's tool calls (ADR-0076), and the Harness already had `authorizeToolUse` (ADR-0100), but nothing connected them: a model that asked for a tool had no way to get one.

The goal: while an agent executes a task it may ask for a tool, and the Harness decides, with the policy that already exists, whether it may use it. Levels A and B run automatically; level C waits for a person. The global limits stay: 8 steps, 4 agents, 3 model calls per request, 5 tools, 10 minutes, depth 1.

## Decision

### 1. The loop lives in the execution graph

The loop has no state of its own. Every turn and every tool call is a node of the task's execution, run by the existing runtime, one node per job:

- the first agent turn is the task's `work` node, as before;
- each tool call the Harness accepts becomes a tool node `{turn}_t{i}` whose input is `{type: 'model_tool_call', id: '{turn}:{i}'}`;
- the next turn is an agent node `work_turn{n}` (input `{type: 'harness_turn'}`) that depends on the previous turn and that round's tool nodes.

The runtime records the model's tool calls with the turn's output (`agentOutputs.toolCalls`), asks the loop for a plan, adds the plan's nodes while the turn is still running (`addNodes`), and only then completes the turn. A worker lost between the two leaves the turn running, so its outcome is unknown and a person resolves it (ADR-0029); nothing runs twice.

The next turn rebuilds the conversation from the graph: the assistant's tool calls and each tool's result (or `{error: code}`). The task's answer is the last agent node's output (`answerNodeOf`), which the task view, the verifier, follow-ups and facts all read.

### 2. `authorizeToolUse` is the only decision

The Harness decides each call with `authorizeToolUse` (ADR-0100), with the tools used so far, the task's limit and the organization's level policy. There is no second copy of the rules:

- **deny** (not granted, over the budget, the tool's policy, critical risk): the task stops with `tool_not_granted`, `tool_call_limit_reached` or `tool_denied`;
- **allow** (A and B by default): a tool node is added and runs through the Tool Gate;
- **approval required** (C, or a tool that asks for it): the tool node is marked `approvalRequired`, and the Tool Gate asks a person even when the tool's own policy is `auto`.

The model is offered only the tools the decision would not deny: granted to the agent's exact version, declaring the new invocation mode `model`, and with an executor on this server. A tool that is not offered cannot be called: the gateway refuses the response (`invalid_response`).

### 3. No tool runs outside the Harness

- Tools declare a third invocation mode, `model`, which requires `runtime`. The Tool Gate refuses a model-call node for a tool that does not declare it (`tool_not_model_invocable`), so a forged node cannot reach any other tool.
- A tool node still runs only through the gate: grants, permissions, policy, risk, approvals bound to the exact operation, idempotency and the audit are unchanged.
- The arguments a tool receives are exactly the arguments the model sent for that call; the node carries no copy that could be edited.
- A runtime tenant can never approve (ADR-0029), so an agent cannot approve its own C tool.
- A task whose model asks for tools where no loop exists (conversation turns, plan steps) stops with `tool_use_unsupported`. Nothing runs.

### 4. Level C: pause, approve, continue

A C tool's node asks the gate, which records a pending approval and puts the execution in `waiting_approval`. Nothing else runs; the state is the graph and the approval record.

- **Approved:** the existing resume path (the API's decision hook re-dispatches the job) runs the same node with the same arguments and continues with the next turn, from exactly the same point.
- **Rejected:** the gate denies with `approval_rejected`, the execution fails and the nodes still pending are cancelled. The next turn never runs.

Time spent waiting for a person does not count toward the 10 minutes (`workingTimeMs`).

### 5. Limits, loops and duplicates

- **Steps:** a task's turns count as its steps. A turn that would be past `maxSteps` stops the task with `step_limit_reached`. The last allowed turn keeps the tools declared, with a note that it must answer now; a call there stops the task.
- **Tools:** at most `maxToolCalls` (5) tool nodes per task; one more call stops it with `tool_call_limit_reached`.
- **Model calls:** each turn is one gateway request, capped at 3 provider calls over its fallbacks, as before.
- **Duplicates:** a call with the same tool and the same arguments (by digest) as an earlier one is not run again; the model gets the earlier result.
- **Loops:** a turn that asks only for calls it already made stops the task with `loop_detected`.
- **Time:** the Harness checks the working time before every turn and before every tool (`task_time_limit_reached`).
- **Tool errors:** a failing tool fails the task with the tool's own code. A tool whose outcome is unknown (a timeout) is left for a person to resolve, as the runtime already does (ADR-0029); it is never retried blindly.
- **Budget:** the task's `maxCredits` is shared by all its turns: each turn's cap is what earlier turns left.

### 6. What does not change

- The NVIDIA data policy is applied by the gateway before routing, on every turn (ADR-0100).
- Fallback, per-call credit caps and the AI Usage Layer are the same for every turn.
- The verifier checks the last turn's answer, plus two pieces of evidence: every tool node's output is valid, and every tool call was decided.

## Consequences

- **No catalogue tool declares `model` yet.** DEV behaves exactly as before: agents are offered no tools. Choosing which tools agents may call during a task, and at which level, is Geovet's product decision; enabling one is a new tool version that declares `model`.
- Agent tasks that schedule a follow-up (ADR-0084) are offered no tools, so their graph keeps its shape.
- Real function calling with Vertex AI and Gemini is covered by the adapter's tests, and still needs a real run in DEV.
- A failing tool ends the task. Asking the agent to recover from a tool error is a later decision.
