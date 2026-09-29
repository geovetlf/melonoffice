# ADR-0064: GIA prepares agent tasks (Agent Engine phase 3)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0052 (GIA's chat through the AI Gateway: she answers, never acts);
  - ADR-0058 (C5: GIA prepares a follow-up, the person confirms it);
  - ADR-0062 and ADR-0063 (agents and agent tasks).
- Does not change:
  - the agent tasks API, service, execution, worker or verifier (ADR-0063);
  - who may assign a task: `specialist.task`, a person acting directly;
  - the AI Gateway, Company Brain, credits or audit.

## Context

After AE-2 the owner can ask an agent for a task from the agent's place. The chain GIA → Agent Engine → agent should also start from GIA: the owner tells GIA what they need, and GIA brings it to the right agent. The rule stays that GIA proposes and a person confirms: ADR-0063 refuses any task that GIA or the runtime asks for.

## Decision

### 1. GIA is shown the active agents, only to someone who may task them

- `createGia` takes an optional `agents` port, `active(tenant)`. The API builds it from the specialists and departments repositories: agents with status `active` in an active catalogue department, each with its display name, its department's catalogue type and its purpose. Nothing else of an agent (configuration, skills, tools, permissions, ids) reaches the model.
- GIA reads it only when the person holds `specialist.task`, and the API wires it only where agent tasks can be assigned (tasks, executions and specialists configured). A failed read is only logged: the chat then has no agents part.
- At most 20 agents, each by a closed reference `a_a`, `a_b`… (letters, as the gateway's closed codes allow). The block `<agents>` is data, escaped like the other blocks: a name cannot close it or give instructions.

### 2. What she may answer

- The output schema gets `agentTask` (nullable) with `agent` (enum of the references she was given) and `request` (≤ 500 characters). With no active agent the field is absent and the rules say an agent can be created in the department's office.
- The rules: propose a task only when the person asks an agent (or the team, or a department that has one) to do, prepare, draft, research or analyse something; the request in the answer language with the details the person gave; never say it is assigned, sent, started or done; never answer in the agent's place.
- `agentTaskProposalOf` keeps a proposal only when its reference is one she was given and its request is plain text of 1 to 500 characters (control and format characters become spaces, whitespace is collapsed). Anything else is no proposal.
- The answer carries `proposedAgentTask {agentId, agentName, department, request}` or null, and `context.agents` says whether she was shown the agents. The log line records `agentTaskProposed`; the audit event stays the answer's own, with no content.

### 3. The person confirms in the app

- GIA's chat shows the prepared task in a card: the agent, the request in an editable box, what an agent task does (answers from the company memory, takes no action, at most 1 credit), Confirm and Discard.
- Confirm calls the existing `POST /specialists/:agentId/tasks` as the person, with one `idempotencyKey` per card, so a retry is the same task. Only when the API accepted it does the card say it was sent, with a link to the agent's place, where its answer appears (ADR-0063 §6).
- A refusal is said as such (permission, agent not available, invalid request) and the card stays open. Discard sends nothing. A role without `specialist.task` never gets the card's form.

## Consequences

- The owner can go from a sentence to GIA to an agent's verified answer, with one confirmation, on the engines that exist: no new permission, route, collection, infrastructure or model call.
- GIA still cannot act: she prepares; the person sends; the agent answers; nothing acts on the world.
- One GIA message may now carry both a follow-up and an agent task proposal; each is confirmed on its own.
- Multi-step orchestration (a plan that delegates to several agents) stays with the planner and delegation (ADR-0028) and is later work.
