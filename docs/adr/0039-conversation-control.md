# ADR-0039: Human control of conversations and autonomy levels (CV-6A)

- Status: Proposed (Phase CV-6A, pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0029](0029-runtime-guards.md) (the runtime actor)
  - [ADR-0033](0033-conversations-foundation.md) (conversations)
  - [ADR-0034](0034-human-tool-invocation.md) (a person's send through the tool gate)
  - [ADR-0037](0037-assisted-conversation-intelligence.md) (assisted AI)
- Decisions it applies (Geovet, 2026-09-27):
  - **CV-6**: autonomous conversational agents, built on the existing stack only.
  - **Autonomy levels**: `manual | assisted | supervised | autonomous`. This keeps V3's `assisted / supervised / autonomous` and adds the brief's `manual`. Autonomy is a restriction only.
  - **CV-6A first**: human control exists and is tested before any agent can act.
- Does not change:
  - the AI Gateway, the tool gate, the runtime, the worker, jobs, credits or executions;
  - CV-1 to CV-5. The one exception: a person's send is now refused while AI handles the conversation.

## Context

CV-6 lets an agent handle conversations on its own. The prerequisite check (2026-09-27) found that the runtime control plane (X6e) is not built. Without it:

- nothing starts an execution;
- nothing supplies the work of a node;
- no worker in DEV runs one.

An autonomous turn would have to run from an HTTP request or from a fake worker. The brief forbids both.

One part of CV-6 does not depend on X6e: a person's control over a conversation. The brief requires:

- a person can take control at any time;
- AI and a person never answer at once;
- an agent that cannot resolve hands off with a reason;
- the operator always sees who handles a conversation.

Building this first means the guarantee exists, and is tested, before any agent can send.

## Decision

### 1. Autonomy level, per organization

`ConversationSettings { organizationId, autonomy, updatedAt, updatedBy?, revision }` lives in `conversationSettings/{organizationId}`. The default is `manual`, and it is not stored until someone changes it.

| Level        | What AI may do                                                                            |
| ------------ | ----------------------------------------------------------------------------------------- |
| `manual`     | Nothing on its own.                                                                       |
| `assisted`   | Answer what a person asks: summaries, intent, suggested replies (CV-4).                   |
| `supervised` | An agent may prepare replies; a person approves each one before it is sent (later phase). |
| `autonomous` | An agent may handle a conversation within its limits (later phase).                       |

How the level is set:

- A person with `conversation.manage`, acting directly, sets it (`POST .../conversation-settings/autonomy { autonomy }`). GIA and the runtime cannot.
- It is audited as `conversation.autonomy_changed` (from and to), in the same transaction as the change.

Autonomy is never a permission. It grants no tool, channel, credits or data. It only allows what the agent's configuration, the policies and the tool gate already allow. CV-6B moves the level onto each agent (Specialist); the organization level stays as the outer limit.

### 2. Who controls a conversation

`Conversation.control?: { handledBy, aiState, epoch, changedAt, changedBy? }`. When it is absent (every conversation before CV-6A), it reads as `human` / `off` / epoch 0.

| `handledBy` | `aiState`   | Meaning                                         |
| ----------- | ----------- | ----------------------------------------------- |
| `human`     | `off`       | AI never handled it (default).                  |
| `ai`        | `active`    | An agent handles it.                            |
| `human`     | `paused`    | A person took control; AI stays out.            |
| `human`     | `escalated` | The agent handed it to a person, with a reason. |

Any other pair in storage is refused when the record is read, as are an epoch below 1 or a handoff reason outside the list. A record edited by hand cannot put an agent in charge.

The existing `handoff` field (reserved since CV-1) records an escalation:

- `reason`: a code from `HANDOFF_REASONS`, never free text;
- `requestedAt`;
- the `executionId`, when there is one.

A message arriving never changes control: the inbound path keeps it as it is.

### 3. Three operations, all audited

| Operation  | Who                                                                                                           | From → to                                                   | Audit                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `takeOver` | a person with `conversation.manage`                                                                           | `active` or `escalated` → `human` / `paused`                | `conversation.ai_human_takeover`                                |
| `handBack` | a person with `conversation.manage`, where the level is `supervised` or `autonomous`, conversation not closed | `human` (any state) → `ai` / `active`; clears the handoff   | `conversation.ai_handed_back` (reason = the handoff it answers) |
| `escalate` | the runtime only, for a user holding `conversation.manage`                                                    | `ai` / `active` → `human` / `escalated`, with a reason code | `conversation.ai_escalated` (reason, reference = execution)     |

How the operations are made:

- Each is one transaction of the conversation (its revision), together with its audit event.
- Each moves the control `epoch` by one.
- `takeOver` and `handBack` have HTTP routes with an empty body. `escalate` has no route: it is the runtime's.

### 4. The epoch: no race between an agent and a person

`checkAutoSend(conversation, autonomy, turnEpoch)` is the check an automatic send must pass, right before sending. CV-6E will call it inside the send's own transaction. It refuses in these cases:

| Situation                                                         | Code                            |
| ----------------------------------------------------------------- | ------------------------------- |
| The organization's level is not `supervised` or `autonomous`      | `autonomy_not_enabled`          |
| A person holds the conversation (`paused`, `escalated`, `off`)    | `conversation_handled_by_human` |
| The conversation is closed                                        | `conversation_closed`           |
| Control changed since the turn started, even if handed back since | `control_changed`               |

An agent's turn records the epoch it started under. Once a person takes control, nothing that turn prepared can go out. Turning the level down to `manual` stops every conversation at once, without touching them.

The other direction is covered too. While AI handles a conversation, a person's send is refused (`conversation_handled_by_ai`, 409):

- before anything is reserved;
- again by the `message_send` executor, if AI took the conversation while the message waited.

So the person takes control first, and the two never answer at once. The web hides the composer and offers **Tomar control**.

### 5. What the operator sees

- The inbox row and the detail say who handles the conversation: "Atendida por IA", "IA en pausa", "Transferida a una persona" with the reason in plain words, or "Atendida por una persona".
- **Tomar control** and **Devolver a la IA** are shown to a person with `conversation.manage`.
- The API view carries `control { handledBy, aiState, changedAt }` and `handoff { reason, requestedAt }`. The epoch, the revision and the handoff's execution stay internal.
- An unknown reason code is shown as "could not resolve", never raw.

### 6. Permissions

No new permission. `conversation.manage` already governs changing a conversation (assignment, status, priority, tags), and control is one more change. The runtime path needs the user behind it to hold `conversation.manage`, and the runtime actor. A person or GIA calling `escalate` is refused.

## Security

- **Tenancy.** Every operation works on the resolved tenant's organization. Another organization's conversation answers as missing, and its settings are never read (tested in memory, on the Firestore emulator and through the API).
- **Browser input.** No state, reason, level, epoch or organization is taken from the browser. The bodies are empty or exactly `{ autonomy }`, and any other key is refused.
- **Model and contact input.** The handoff reason is a closed list of codes. A model's or contact's text can never become a reason, a state or a permission.
- **Concurrency.** A conversation change is a transaction on its revision. Of two simultaneous takeovers, one wins. The in-memory repository now refuses a stale write the same way.
- **Audit.** Every change is written with its event. No message text or secret is audited.

## Not in this change

- **Blocked by X6e:**
  - no agent turn, trigger from an incoming message, automatic send or automatic escalation;
  - no cancelling pending jobs on takeover;
  - no single active turn per conversation.
    CV-6C will use X6a's cancel cascade and the job lease for these.
- **CV-6B:** no agent configuration on Specialist (autonomy, channels, escalation limits); it needs D-27 for the role.
- **CV-6D and CV-6E:**
  - no model policy for agent turns (`confidential`, no downgrade);
  - no structured decision output;
  - no runtime `message_send` (the tool stays human-only).
- **UI:** no screen to change the level yet (API only). It comes with agent management (CV-6B).
- **Infrastructure:** no Terraform change.

## Consequences

- AI handling cannot start by accident: the level is `manual` until a person changes it, and even then nothing acts until the agent phases exist.
- When agents arrive, the takeover guarantee, the operator view and the handoff record are already in place and tested. CV-6E only has to call `checkAutoSend` inside the send.
- A person must take control before replying in a conversation an agent handles. That is intentional: it is the one rule that keeps the two from answering at once.
