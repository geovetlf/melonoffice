# ADR-0063: Agent tasks (Agent Engine phase 2)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0024 and ADR-0029 (executions, verification before completion);
  - ADR-0027 and ADR-0038 (AI Gateway, Vertex AI, credits);
  - ADR-0030, ADR-0031 and ADR-0032 (jobs, runtime, worker and Cloud Tasks);
  - ADR-0043 (conversation agent: agent outputs, the runtime's work and verification ports);
  - ADR-0051 (Company Brain, the only company memory);
  - ADR-0061 (paginated lists and their missing-index fallback);
  - ADR-0062 (Agent Engine core: skills, templates, `specialist.manage`).
- Does not change:
  - the runtime, the AI Gateway, the tool gate, approvals or Company Brain;
  - the conversation agent, which keeps its own work, verifier and stop hook;
  - GIA, which gets no path to agent tasks here;
  - the tool catalogue: an agent task has no tool node.

## Context

After AE-1 an owner can create agents from templates, but an agent can do nothing unless a conversation reaches it. The next step of the chain (GIA → MelonMotor → Agent Engine → Specialist Agent → Skills → Tools → Execution Engine → Result) is that a person can give an agent a piece of work and get its answer back, on the engines that already exist.

## Decision

### 1. A task is a record plus an execution

- `agentTasks/{taskId}` keeps what was asked: organization, agent, agent version, request (≤ 2,000 characters, trimmed, no control characters), who asked and when. It is written once.
- The task id is its execution's id: `executionIdFor(org, "agent-task:{agentId}:{key}")`. The key is the caller's `idempotencyKey` (`[A-Za-z0-9_-]{1,64}`) or a fresh one. Asking again with the same key returns the same task and starts nothing new; the same key with another request is `idempotency_conflict`.
- The execution is created first, through the execution service with the specialists' `AssignmentGuard`: an agent that is not eligible leaves no task behind. It has one `agent` node (`work`), `mode: execute`, its input `{type: 'agent_task', id}` and a version snapshot naming the agent's version and each skill's version.
- It is started, then the runtime's `kickoff` queues its job for the worker. A task that is no longer running (cancelled, finished) is never queued again. A kickoff the runtime refuses as already queued is not an error.

### 2. Who may ask and read

- `specialist.task` (new, owner only) asks. Only a person acting directly: GIA and the runtime are refused (`permission_denied`). GIA proposing tasks is later work (AE-3), and a person still confirms.
- `specialist.read` reads an agent's tasks and a task.
- Another organization's agent or task answers exactly like a missing one.

### 3. What the model is given

- The worker routes by execution: `taskOf(execution)` goes to the task's work source and verifier, everything else to the conversation agent's, exactly as before.
- The node's work names the agent (display name, purpose, role), its skills from the catalogue, the Company Brain context and the request. The request and context are passed as data; the system rules say the agent has no tools, never claims to have acted, uses only the context and lists what is missing.
- Context: Company Brain only (the only company memory), for the agent's department as the `purpose`, so its domains and sensitivity ceiling apply, read with the runtime tenant so the person behind the task is checked again. Only when the agent's configuration lists `knowledge.read` (from the `company_knowledge` skill, which every template now has). A department whose ceiling is `restricted` gives agents nothing. The read is focused on the request's words first and falls back to the department's facts as a whole when none match. A failed read gives a stated placeholder, never invented facts.
- The model call goes through the AI Gateway with the agent's model policy `agent_task` v1 (same limits as the conversation agent's: Gemini 2.5 Flash-Lite on Vertex AI, DEV only, `confidential` at most, at most 1 credit per call). Credits, audit and eligibility are the gateway's.

### 4. Verification and the answer

- The answer's shape is `{answer ≤ 4,000, missing: ≤ 5 × ≤ 200}`.
- The verifier (`output_schema`, check `agent_answer_valid`) passes only when the kept output parses to that shape; the execution's result is then `{type: 'agent_output', id: '{taskId}:work'}`. Otherwise the task fails. It checks the shape, not the advice: a person reads the answer.
- The API shows the answer only for a `completed` execution (which by ADR-0029 passed its verification).

### 5. API

| Route                                                    | Permission        |
| -------------------------------------------------------- | ----------------- |
| `POST /v1/organizations/:org/specialists/:agentId/tasks` | `specialist.task` |
| `GET /v1/organizations/:org/specialists/:agentId/tasks`  | `specialist.read` |
| `GET /v1/organizations/:org/agent-tasks/:taskId`         | `specialist.read` |

- `POST` answers 202 with the task view. Errors: 400 `invalid_task` with `field`, 403, 404, 409 (`specialist_not_available`, `idempotency_conflict`, `specialist_not_eligible` with `reason`, `organization_inactive`).
- The list is newest first, 20 per page by default, at most 50, with an opaque cursor bound to the organization and agent (ADR-0061's pattern). Firestore index: `agentTasks (organizationId, specialistId, createdAt desc)`; while it is missing, the list falls back to an equality read and logs `firestore.index_missing`.
- The task view: id, agent, version, request, who, when, `status` (the execution's), `failure` code, `completedAt`, `answer`.

### 6. Web (the agent's place)

- The agent's place (`/office/<department>/agent/<id>`, ADR-0041) gets a Tasks section for anyone with `specialist.read`. It replaces the "Current task: none" line there.
- With `specialist.task` and an active agent, it shows a form. Each typed request has one `idempotencyKey`, so a retry after a failure is the same task. The form says the agent answers from the company memory, takes no action, and uses at most 1 credit per task.
- A task still open is read again every 4 seconds, at most 45 times. The screen then shows the verified answer and what the agent says is missing. A failed task says it failed and that nothing was done on the agent's behalf. No answer is shown that the API did not return.

## Consequences

- An agent can do real work that a person can read, on the engines already in production in DEV, with no new runtime, gateway, memory or queue.
- The API's queue hand-off reuses the conversation agents' runtime composition (`createAgentTurns().kickoff`).
- Nothing an agent answers acts on the world: tools for agent tasks (AE-4) and GIA orchestration (AE-3) are separate decisions.
- The index needs a DEV Terraform apply, which only Geovet authorizes. Until then lists still work through the fallback.
