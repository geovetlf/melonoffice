# ADR-0117: Agent memory, handoffs, GIA as coordinator, notifications, AI review and traces

- Status: Proposed
- Date: 2026-10-01
- Builds on: [ADR-0043](0043-conversation-agent.md), [ADR-0051](0051-company-brain.md), [ADR-0063](0063-agent-tasks.md), [ADR-0066](0066-event-system.md), [ADR-0067](0067-event-persistence-and-delivery.md), [ADR-0070](0070-plan-steps.md), [ADR-0099](0099-melon-agent-harness.md), [ADR-0100](0100-harness-provider-preference-and-task-budget.md), [ADR-0101](0101-handoff-to-human.md), [ADR-0115](0115-agent-lifecycle-readiness-pagination.md), [ADR-0116](0116-agent-autonomy-and-sensitive-actions.md)

## Context

The owner asked for the Agent Engine to be completed, in this order:

1. agent memory;
2. handoffs between agents;
3. GIA as a coordinator rather than a superagent;
4. in-app notifications;
5. optional AI verification;
6. credits and traceability per task;
7. audit;
8. agent search beyond 500 records.

The rules were:

- map what exists, reuse it, connect it, and create only what is missing;
- no second architecture, and no replacement of the Harness, Tool Gate, Planner or Runtime;
- no migration before an explicit authorization.

## Decision

### 0. Work settings

Agents get three optional settings: `configuration.work.{memory, aiVerification, collaboration}`.

- All are off by default. Only the settings that are on are stored, so an agent with everything off reads exactly like one from before.
- They change through `POST /specialists/:id/settings {fromVersion, …}`. This needs `specialist.manage`, from a person directly, and creates a new immutable version. It is audited as `specialist.settings_changed`, with the from and to transition as codes.
- A revision keeps the settings and cannot change them.
- An execution follows the settings of the exact version it runs.

### 1. Agent memory (`packages/agents/src/memory.ts`, `agentMemories/{id}`)

- A note belongs to one agent of one organization. It is never Company Brain's, and nothing is written to or read from Company Brain through it.
- Kinds:
  - `preference` and `lesson` come from a task;
  - `note` comes from a person.
- Limits:
  - at most 50 live notes per agent;
  - at most 2 notes per task;
  - at most 300 characters per note;
  - kept for 180 days;
  - 20 notes go into the model's context.
- Text that looks like a secret or someone's contact details is refused.
- The agent proposes notes in its answer (`remember`) only when its version has `memory` on. The worker keeps them when the task ends, idempotently by task (each note id is a hash of the task).
  - A full memory gives up its oldest notes from tasks.
  - A person's note is never pushed out.
- The notes go back to the agent as an `agent_memory` context block, only to that agent.
- A person lists, adds, forgets or clears notes with `/specialists/:id/memories`:
  - reading needs `specialist.read`;
  - changing needs `specialist.manage`, never from GIA or the runtime.
- Audit events: `agent_memory.recorded`, `agent_memory.forgotten` and `agent_memory.cleared`.
- Reads use equality on the organization and the agent: no composite index.

### 2. Handoffs (`packages/agents/src/handoffs.ts`, `agentHandoffs/{parentTaskId}`)

- An agent with `collaboration` on may propose, in its answer, one handoff to another active catalogue department that has an agent able to take work. The proposal names:
  - the department;
  - the reason: `outside_role`, `needs_specialist` or `next_step`;
  - the request;
  - the context.
- MelonOffice picks the receiving agent.
- The worker records the proposal as `proposed`, or as `refused` with a code (`no_agent_available`, `permission_denied`), and publishes `agent_handoff.proposed`.
- **A person always accepts or declines** (`POST /agent-tasks/:id/handoff/accept|decline`, `specialist.task`, a person directly).
  - The runtime cannot start executions on a person's behalf, so an agent never starts another agent's work by itself.
- Accepting creates the receiving agent's **own task**:
  - through the same task service, with the same Policy → Permissions → Tool Gate → Approval → Harness → Runtime;
  - with `parentTaskId` set;
  - with that agent's own version, skills and permissions;
  - with a snapshot of its permissions recorded on the handoff.
- Nothing is inherited from the first agent.
- The child's budget is never more than the parent's budget minus what the parent spent. `budget_exhausted` refuses it, so no agent gets round a limit through another.
- A handed task never hands on again (depth 1).
- When the child ends, the handoff settles as `completed` or `failed`, with the credits it consumed.
- Execution `parentExecutionId` is deliberately not used. Starting a child of an ended parent is refused (`execution_parent_ended`), so the link lives on the task.
- Audit events: `agent_handoff.proposed`, `accepted`, `declined`, `refused` and `settled`.

### 3. GIA as coordinator, not superagent

- GIA may prepare work for 2 to 4 known departments (`proposedTeamTask`). The person edits it and confirms it, and the web sends it to the existing Harness (`POST /harness/tasks`).
- The Harness and Planner decide whether it becomes a plan, which waits for the person's approval in Automations. Delegation and the conductor then run each step as that department's agent.
- Once there are answers, `POST /gia/plans/:planId/summary`:
  - is user only and needs `gia.ask`;
  - reads the plan and the steps' verified answers as the person (`plan.read`, `execution.read`);
  - asks the AI Gateway once (`taskType: gia_summary`) for a summary of what each step produced, what is pending and what to decide;
  - is audited as `gia.results_summarized`.
- When no step has answered, GIA asks no model and nothing is charged.
- GIA never starts, approves or runs anything, and never adds facts of her own.

### 4. In-app notifications (`packages/agents/src/notifications.ts`, `agentNotifications/{id}`)

- Kinds:
  - `approval_required`;
  - `task_finished`;
  - `task_blocked` (needs access);
  - `task_failed`;
  - `agent_stopped`;
  - `needs_info`;
  - `task_delegated` (a handoff was proposed);
  - `task_received` (the other agent received the work).
- A notice carries ids and codes only. It is for the person who asked for the task and is kept for 90 days.
- Sources:
  - the worker's event bus gets its first subscriber, `agent_notifications`. It turns `agent_task.finished` (which now carries the handoff-to-human reason and failure code), `agent_task.approval_required` and `agent_handoff.proposed` into notices;
  - `agent_task.approval_required` is published from a new job-handler hook when a job stops on an approval;
  - the API makes the notices a person's own action causes: an agent stopped by pausing, disabling or archiving it, and a handoff received.
- Delivery goes through **channel adapters** (`NotificationChannel`). Only `in_app` exists. Email, WhatsApp or push would be one more adapter, not another system, and none is built.
- The id starts with the inverted time, so a person's notices are read newest first by equality on the organization and the person, ordered by document id: no composite index.
- A repeated delivery makes the same id and is stored once.
- Routes: `GET /notifications` (paginated, with the unread count), `POST /notifications/:id/read` and `POST /notifications/read`. Only the person reads or marks their own.

### 5. Optional AI verification (`packages/agents/src/ai-review.ts`)

- When the version has `aiVerification` on and the answer passed the usual checks, the verifier asks the same AI Gateway once (`taskType: agent_review`, node `ai_review`). It runs for the same execution, agent and credits, and within the task's remaining budget.
- The runtime passes its gateway to verifiers through a new optional `VerificationContext`.
- The verdict is `pass` or `fail`, with a reason code. A `fail` fails the verification like any check.
- The review is kept as an agent output, with its model, credits and verdict, so a later verification never asks again.
- With no budget left, or when the call is refused, the review is kept as `unavailable` and the usual checks stand alone.
- Its credits count toward the task's spending.

### 6–7. Credits, traceability and audit (`packages/agents/src/trace.ts`)

`GET /agent-tasks/:id/trace` (`specialist.read`) returns, as codes, ids and numbers only:

- each step, with its tool, approval, error, model and credits;
- the AI review;
- the verification checks;
- the handoff and its handed task;
- the audit trail of the task and its handoff;
- credits: the task, its review, its subtasks, the total, the budget, what remains, and the split by model and by agent.

It answers "how much did this task cost?" and "which agent spent these credits?". The tenant → agent → task → subtask → model → tool chain comes from records that already exist: agent outputs' AI traces, execution nodes and the audit trail.

### 8. Search beyond 500

There is no code change and no migration. The plan, for authorization, is in `melonoffice-plan/MelonOffice-AE5-Busqueda-Agentes-Plan.md`:

- **Stage 1:** no data change. A skill is queried with `array-contains-any` on its catalogue versions, and a non-default autonomy by equality, with 2 composite indexes.
- **Stage 2:** a `searchTokens` field with a backfill. It is a migration and waits for the owner.

A test walks 1200 agents and loses or repeats none.

### Screens

- Each task shows a plain sentence ("Mara está trabajando / necesita tu aprobación / terminó / está bloqueado porque necesita acceso…") and "Ver detalles" with the trace.
- A proposed handoff shows Accept and Don't hand on.
- The agent's page has its work settings and its memory.
- The bell lists agent notices.
- GIA's chat confirms team work and summarizes it.
- Copy is in EN and ES.

## Consequences

- Infrastructure: no Terraform, no index and no migration. The new collections (`agentMemories`, `agentHandoffs`, `agentNotifications`) are created on first write, and their queries use single-field indexes only.
- Every existing agent behaves as before until a person switches a setting on.
- Security invariants are unchanged:
  - a paused, disabled or archived agent makes no model call and runs no tool;
  - an agent has no capability without a skill and no tool without a permission;
  - a sensitive action needs an approval;
  - another agent inherits nothing;
  - another tenant is unreachable;
  - the LLM never skips the Tool Gate.
- The worker's event bus now has one subscriber. It only writes notices: it starts no work and sends nothing outside MelonOffice.
