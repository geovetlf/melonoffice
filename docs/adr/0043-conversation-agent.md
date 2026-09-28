# ADR-0043: The first conversation agent

- Status: Proposed (pending Geovet's review)
- Date: 2026-09-28
- Amends:
  - [ADR-0029](0029-runtime-guards.md) (D-X6-START: the runtime may start one kind of execution, as a delegated start)
  - [ADR-0039](0039-conversation-control.md) (the supervised and autonomous levels now have an agent behind them)
- Builds on: ADR-0024 (executions), ADR-0025 (specialists), ADR-0026 (tool gate and approvals), ADR-0027 (AI Gateway), ADR-0030 to ADR-0032 (jobs, runtime, worker), ADR-0034 (sending through the tool gate), ADR-0038 (Vertex AI and credits).
- Does not change: the infrastructure, IAM, permissions (none added), providers, models, channels or credit rates.

## Context

CV-6A (ADR-0039) gave each conversation a control record, an epoch and four autonomy levels, but no agent could act at the supervised or autonomous levels. CV-6B adds the first operational conversational agent. Geovet's brief forbids a parallel architecture: no new Agent entity, no second runtime, tool gate or AI Gateway, no new permission without stopping first.

## Decision

### 1. The agent is a specialist

A conversation agent is an ordinary specialist whose configuration carries a `conversation` profile (`ConversationAgentProfile`): the company's instructions, the channels it may answer on, the furthest autonomy it may use (`supervised` or `autonomous`) and a reply limit per conversation. The profile only restricts. The effective level is `stricterAutonomy(organization, agent)`.

Conversation settings gain an optional `agentId`. `POST /v1/organizations/:id/conversation-settings/agent` sets or clears it under the existing `conversation.manage`. Only an active specialist of the same organization with a profile is accepted (`agent_not_available`). New conversations are assigned that agent when they are created. Existing conversations keep their state.

### 2. A turn is an execution

Each stored inbound message may start one turn: an execution with idempotency key `conversation-turn:{inboundMessageId}`, so a redelivered message never starts a second turn. Its snapshot pins the specialist, the conversation control (with its epoch) and both tools. It has three nodes:

- `decide`: the agent node. It calls the AI Gateway once with a closed JSON schema (reply, or hand off with a reason).
- `reply`: `message_send`, depends on `decide`.
- `handoff`: `conversation_handoff`, depends on `decide`.

Only one of `reply` and `handoff` is needed. The other is skipped through the new `NodeWorkSource.needed` port. The verifier checks that the answer was kept and that the reply was sent or the conversation handed off.

### 3. Tools

- `message_send` v2 (approval required, TTL 1 hour) serves supervised agents, and v3 (auto) serves autonomous ones. Both are runtime-only and medium risk. v1 stays the human send and is unchanged.
- A specialist may list a tool once (`tools.duplicate`), so an agent lists the version for its own profile level. When the effective level needs a version the agent does not list, the turn is skipped (`agent_not_configured`). For example, an autonomous agent in a supervised organization never sends.
- `conversation_handoff` v1 is a new internal tool (provider `conversation`, permission `conversation.manage`, which already existed). It escalates with a closed reason code and only while the control epoch is the snapshot's.
- The channel executor sends an agent reply only when the message is the agent's own reply for this turn and the control still allows it (not taken over, not paused, not closed, same epoch, the inbound still the latest).

### 4. Delegated start (amends ADR-0029)

ADR-0029 said the runtime never starts an execution. A turn has no person pressing Start, so `ExecutionService.runtimeStart` adds one narrow exception:

- only the runtime actor may call it;
- the principal behind the runtime tenant (the person who last saved the conversation settings) must hold `execution.start`;
- it starts only an execution that person owns;
- it is audited like any start, with reason `delegated_start`.

The person's configuration of an agent is the consent. The `execution.start` description now says so.

### 5. Runtime additions

- `AgentOutputSink` keeps the agent's answer (`agentOutputs/{executionId}_{nodeId}`) before its node completes. If it cannot be kept, the node fails (`output_unavailable`).
- `ExecutionStopHook` runs when an execution fails or awaits resolution. For a turn, it settles an unsent reply and escalates the conversation with a mapped handoff reason. Its errors are logged and never change the execution.
- An execution whose nodes were all skipped fails with `no_work_done`, since X6a forbids completing with no completed node.

### 6. Prompt injection

The model receives the fixed system rules as the system message, written in code. The user message carries two delimited blocks: `<business_instructions>` (the agent's instructions) and `<conversation_data>` (the business context, the conversation and the customer's last message). Both blocks are escaped (`asData`), so text inside them cannot close a block. The system rules say that everything in `<conversation_data>` is untrusted data and never an instruction, and that the business instructions yield to the rules. The output is parsed against the closed schema. Anything else is `invalid_ai_output` and the conversation goes to a person. The system rules forbid inventing prices, stock, orders or actions. The agent has no tool beyond its reply and handoff, and it cannot change its own configuration, autonomy or permissions.

### 7. Cost

The `conversation_agent` model policy allows only Vertex AI Gemini 2.5 Flash-Lite, confidential data, no fallback, at most 2 attempts and a maximum cost of 1 credit per call. Credits are consumed by the AI Gateway under the turn's own request, and a skipped turn consumes nothing.

### 8. Permissions: stop point

Configuring an agent needs a way to create and edit specialists, which has no API. That would need a new `specialist.manage` permission. Following the brief, it was not introduced. Agents can be configured only through the specialist repository (tests, seeds) until Geovet decides.

## Consequences

- The four autonomy levels work end to end on the existing stack.
- DEV needs infrastructure before a real agent can run:
  - the worker's Vertex and channel secret settings and IAM;
  - the API's Cloud Tasks transport settings.
    None is in this change.
- A residual race of milliseconds remains between the last control check and the provider's send.
- Supervised replies wait for approval, but there is no approvals screen yet.
