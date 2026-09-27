# ADR-0034: Human tool invocation through the Tool Gate (CV-2)

- Status: Proposed (Phase CV-2, pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0024](0024-execution-foundation.md) (executions)
  - [ADR-0026](0026-tools-approvals-and-guardrails.md) (tools, approvals and the tool gate)
  - [ADR-0029](0029-runtime-guards.md) (actors, start, verification)
  - [ADR-0031](0031-runtime-advance.md) (runtime authority)
  - [ADR-0033](0033-conversations-foundation.md) (conversations)
- Source: the CV-2 Phase 0 audit (`melonoffice-plan/MelonOffice-PhaseCV2-Audit.md`, shared project files).
- Decision it applies: **DG/CV-2, option B** (Geovet, 2026-09-27): a person replies through the existing tool gate, extended additively for tools explicitly authorized for human invocation.
- **ADR-0031 stays the rule for the runtime.** This ADR is an explicit, narrow addition next to it. It changes nothing on the runtime's path.

## Context

CV-1 (ADR-0033) receives WhatsApp messages and lets people triage them. It has no way to answer. ADR-0033 fixed the only way a message may leave: permission → tool gate → channel adapter → provider.

The CV-2 audit found three facts in the code:

- the gate refused every actor but the runtime (`runtime_only`, ADR-0031);
- the pre-execution guardrails required a specialist (`no_specialist`);
- there are no specialists, and the runtime path that would run one (X6e) has not started.

So a person could not reply at all without either a bypass or a dependency on unbuilt work.

## Problem

A person must be able to reply, as themselves, now, without:

- a second tool gate or tool engine;
- an API route that calls Meta;
- a "human runtime", a fictitious specialist or a new agent;
- a permission bypass;
- any dependency on X6e, the worker, Cloud Tasks, leases or `advance()`;
- any change to what the runtime's path allows.

## Decision

### 1. Invocation modes on the tool version

`ToolVersion.invocationModes?: ('runtime' | 'human')[]`.

- **Absent means `['runtime']`,** exactly as before. A person can never invoke a tool that does not say `human` explicitly (fail closed).
- **Each mode is explicit.** `['human']` does not keep `runtime`.
- **Registration refuses:**
  - an empty, unknown or duplicate mode;
  - a `human` tool whose policy is not `auto` (a person's call has no approval step);
  - a `human` tool restricted to department types (it acts for the person, not for a specialist's department).
- **The runtime's path gains one check,** after `tool_not_active`: `tool_not_runtime_invocable`. No existing tool declares modes, so nothing that ran before is refused. The planner refuses the same tools (`policy:tool_not_runtime_invocable`), so they are never planned for the runtime.

### 2. The same gate, one more caller

`ToolGate.invoke(tenant, { executionId, nodeId, input })` is unchanged. Inside it, a call is a **human call** only when all of these hold:

- the tenant is a user acting directly (`actor: 'user'`; never GIA, never the runtime);
- the execution is in the tenant's organization;
- the node's exact tool version says `human`.

Anything else is refused `runtime_only`, as before, with the same single audit event. The only difference is that this refusal now follows a read.

A human call runs the **human guardrails**. They are the same checks, in the same order, except the specialist ones, which have no subject here and are replaced by stricter ones:

1. The execution exists and is `running`; never `waiting_approval`.
2. The node exists, is a `tool` node, is `pending`, and has no approval attached.
3. **The execution has no specialist, version or department** (`specialist_execution`). A specialist's work is the runtime's, always.
4. **The execution is the user's own**: created by and for this user (`execution_not_owned`).
5. The exact tool version exists, is `active`, and says `human` (`tool_not_human_invokable`).
6. The user holds `tool.execute` and every permission the tool needs.
7. The environment is allowed. An unset environment allows nothing.
8. A mutating tool does not run in a read-only mode.
9. The executor exists.
10. The input matches the closed schema, with no authority or credential field.
11. The policy is `auto`. `approval_required` is refused (`approval_unavailable`) and `denied` is refused.

After that, the gate does what it always does, with the same code:

- the node goes `pending → running` with the idempotency key recorded before the effect;
- the executor runs with a deadline and the tool's retry policy;
- the output is checked against the schema;
- the node goes `running → completed` or `failed`;
- the usual `tool.*` and `execution.*` audit events are recorded with the person as actor.

**One exception to "the gate never completes an execution".** Nobody will come back to a person's one-node execution: no runtime, job or lease is involved. So in the same write that finishes the node, the gate also finishes the execution, using the execution model's own rules:

- a failed node fails it (`running → failed`, the failure code as given);
- a completed node moves it `running → verifying`, then records a verification (`output_schema`, check `output_schema_valid`, evidence the node), then moves it `verifying → completed`.

`checkNodesFinished` and `checkVerified` apply unchanged. There is no shortcut to `completed`.

### 3. The actor

`initiatedBy` is the authenticated user acting directly: audit actor `{ type: 'user', userId, via: 'direct' }`. No `human` actor and no `specialist` actor exist. `ToolExecutionContext.specialistId` and `specialistVersion` became optional: the runtime's path still fills them, and a person's call leaves them absent rather than inventing one.

### 4. `message_send`, the first human tool

`message_send@1` is in `TOOL_CATALOGUE`, now the only tool there:

| Field             | Value                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| category / action | `communication` / `send`, mutating                                               |
| input             | `{ conversationId, messageId }` only                                             |
| output            | `{ messageId, status: 'sent' }`                                                  |
| permissions       | `conversation.send`                                                              |
| credentials       | `{ provider: 'whatsapp', scopes: ['whatsapp_business_messaging'] }`, a reference |
| risk / policy     | `medium` / `auto`                                                                |
| timeout           | 15 s                                                                             |
| retry             | `maxAttempts: 1`: never retried, since a second call could send twice            |
| provider          | `external` / `channel`                                                           |
| environments      | `dev`                                                                            |
| invocation modes  | `['human']`                                                                      |

The input has no recipient, account, connection, tenant or token. They cannot be supplied.

Its executor (`createChannelMessageExecutor`, in `@melonoffice/integrations`) reads everything again, in the context's organization:

- **the reserved message:** outbound, still `queued`, in that conversation, sent by that user, with its text;
- **the conversation:** same connection, not closed;
- **the channel adapter** and its service window;
- **the connection:** active, same channel;
- **the recipient's identity;**
- **the access token:** read from Secret Manager at that moment, used once and dropped.

It calls the adapter once. It settles the message with its audit event in one write.

### 5. The synchronous flow around the gate

`createMessageSendService` (`@melonoffice/integrations`) runs one send, in this order:

1. **Authorize.** A resolved tenant, `actor: 'user'`, holding `conversation.send`, `tool.execute` and `execution.start`, in an active organization. Nothing is reserved for a send that cannot happen.
2. **Load the conversation** in the tenant's organization. Another organization's conversation is `conversation_not_found`.
3. **Idempotency.** The message id is `outboundMessageIdFor(organization, conversation, clientMessageId)`.
   - The same key with another text is `duplicate_request`.
   - The same key already settled returns the stored message, and nothing is sent.
4. **Refusals that need no attempt,** checked before reserving: a closed conversation, no adapter for the channel, or outside the service window. Each is audited `conversation.message_send_failed` (`denied`), and nothing is stored.
5. **Reserve** the message `queued`, create-if-absent, in one transaction.
6. **Execution.** One per message, with id `executionIdFor(organization, 'message:' + messageId)`: mode `execute`, no specialist, one `tool` node `send`. It is started with the existing `ExecutionService.start`.
7. **Invoke the gate.**
8. **Settle what the executor did not.** A gate denial means nothing left: `failed`, with the code. Anything else still `queued` is resolved as follows:

| Situation                                                                 | Result                                      |
| ------------------------------------------------------------------------- | ------------------------------------------- |
| The node is held by another attempt within the tool's timeout             | `duplicate_request`, and nothing is changed |
| Timeout, an executor that threw, or a node that started and never settled | `unknown` (`outcome_unknown`)               |

There is no complex reconciliation. An `unknown` message is final until a person or a later reconciliation resolves it, and it is **never resent blindly**. A new attempt is a new `clientMessageId`, decided by a person.

### 6. Message states

`MessageStatus` gains one value, `unknown`. The existing states cover the rest:

- `queued`: reserved, sending;
- `sent`: accepted, with the provider's id and `messageRefs` entry, so delivery reports reach it;
- `delivered` / `read`: from webhooks, as in CV-1;
- `failed`: nothing was sent, with `failureCode`;
- `unknown`: it may have been sent.

No delivery report can move an `unknown` message: nothing names it, since its provider id was never learned.

### 7. WhatsApp's 24-hour rule

WhatsApp allows a free-form reply only within 24 hours of the contact's last message. Outside that window, only an approved template can be sent. Source: Meta, [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages) and [Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview).

- The adapter declares `serviceWindowMs` (24 h).
- A reply is allowed only while `now − lastInboundAt < 24 h`. A missing or future `lastInboundAt` allows nothing.
- It is checked before reserving and again in the executor. Meta's own refusal (131047) maps to the same `outside_messaging_window`.
- CV-2 sends no templates. There is no forcing and no fallback to another channel.

### 8. Provider answers

Source: Meta, [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes). Only the numeric `error.code` is read, never Meta's message.

| Meta answer                                          | Code                       | Message   |
| ---------------------------------------------------- | -------------------------- | --------- |
| 131047                                               | `outside_messaging_window` | `failed`  |
| 130429, 131056, 4, 80007, HTTP 429                   | `rate_limited`             | `failed`  |
| 131026                                               | `invalid_destination`      | `failed`  |
| 131051                                               | `unsupported_message`      | `failed`  |
| 0, 10, 190                                           | `channel_unauthorized`     | `failed`  |
| 368, 131031                                          | `policy_restricted`        | `failed`  |
| 131000, 131016, 2                                    | `temporary_provider_error` | `failed`  |
| other 4xx                                            | `provider_rejected`        | `failed`  |
| HTTP 5xx, no answer, timeout, or a 2xx without an id | `outcome_unknown`          | `unknown` |

The send API documents no idempotency key. So the adapter never retries, and a lost answer is never repeated.

### 9. Authorization

- A new permission, `conversation.send`: "Reply in the organization's conversations as oneself, through the tool gate". It is granted to `owner` only. No role was added (D-27).
- The route also runs under `withPermission('conversation.send')`. RBAC denials are audited as before.
- Sending also needs `tool.execute` (the gate) and `execution.start` (starting the send's execution). Nobody gets access outside these policies.

### 10. API

`POST /v1/organizations/:organizationId/conversations/:conversationId/messages`

The body is exactly `{ clientMessageId, text }`. Any other field, including `organizationId`, `to`, a connection, a credential or a token, is a 400.

| Answer                                                   | When                                                  |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `201 { message }`                                        | sent now                                              |
| `200 { message }`                                        | the same key again, already sent                      |
| `202 { error: 'external_send_unknown', message }`        | may have gone out; not resent                         |
| `409 duplicate_request`                                  | same key with another text, or an attempt in progress |
| `409 outside_messaging_window` / `conversation_closed`   | refused before sending                                |
| `403 permission_denied` / `tool_not_human_invokable`     | not allowed                                           |
| `404 conversation_not_found`                             | absent, or another organization's                     |
| `503 channel_not_available`                              | channel off, disabled or unreadable; nothing sent     |
| `502 { error: 'external_send_failed', reason, message }` | refused by the provider                               |
| `503 sending_not_configured`                             | sending is not wired                                  |
| `401`                                                    | from authentication, as every `/v1` route             |

**Wiring.** Sending is wired only where both `CHANNEL_SECRETS_PROJECT_ID` and `DEPLOYMENT_ENVIRONMENT` are set. Terraform sets neither for the API, so it stays off everywhere until infrastructure is decided.

### 11. Audit and observability

Audit actions:

- `conversation.message_sent` (`success`);
- `conversation.message_send_failed` (`failure`, or `denied` before sending);
- `conversation.message_send_unknown` (`failure`).

Each records:

- the actor, the person acting directly;
- `organizationId` and the time;
- the target, `{ type: 'message', id }` (a new target type);
- `reference: conversation:{id}`;
- the reason: the channel on success, else the stable code;
- the tool, `message_send@1`.

It never records the text, a token, a secret or a key. The gate's own `tool.*` and `execution.*` events are recorded with the same actor.

Logs are structured, through the existing logger: `human_message_send_attempt`, `human_message_send_success`, `human_message_send_failure`, `human_message_send_unknown` and `tool_gate_human_denied`. They carry ids and codes, never the text. There is no metrics system, and none was added.

### 12. No AI, no credits

- No model is called.
- Nothing is classified, summarized or suggested.
- No AI credits are consumed.
- Channel cost is not metered yet, and no credits engine was added.

The web composer says a person is replying, and offers no AI compose.

## Why not a human runtime

A runtime for people would be a second place where executions are driven, with its own jobs, leases and retries. It would duplicate the authority ADR-0031 gives the runtime and make "who moved this execution" ambiguous. A person's send is one synchronous call; the gate already holds every check. The flow around it only reserves, starts and settles, with the existing execution service.

## Why not a fictitious specialist

A specialist is a permanent identity with a version, a department and its own permissions (ADR-0025). Inventing one to satisfy `no_specialist` would:

- record work under an identity nobody created;
- give it permissions nobody granted;
- make the audit say a specialist acted when a person did.

The human path instead requires that there is **no** specialist, and the runtime path still requires one.

## Alternatives considered

- **A. Wait for X6e and a real specialist.** Rejected: it blocks replies on unbuilt work and still would not model a person replying as themselves.
- **B. The chosen option:** an additive human mode on the same gate.
- **C. An API route that calls the adapter directly.** Rejected: it bypasses the gate, the one place where tools are authorized, audited and made idempotent (ADR-0026, ADR-0033).

## Security

- **Tenant isolation.** The organization comes from the token, then the stored conversation, connection and identity, each read in that organization.
  - A forged `conversationId` is `conversation_not_found`.
  - The executor refuses a `messageId` of another conversation, organization or sender.
  - Nothing in the body can name a connection, contact, identity or credential.
- **Fail closed.** No mode means runtime only. No environment means nothing runs. No adapter or connection means nothing is sent.
- **Secrets.** The token is read from Secret Manager at send time and never stored, logged, audited or returned. Tests scan answers, logs and the audit store for it.
- **GIA and the runtime** cannot use the human path. GIA gets `runtime_only` at the gate and `requires_user` at the service. The executor also refuses any `via` other than `direct`.

## Consequences

- A person can reply in DEV once channel infrastructure exists, with no specialist and no runtime.
- The runtime's path is unchanged. The 41 existing gate tests pass unmodified, and non-regression tests pin specialist, permissions, tenant isolation, approvals and the new mode check.
- `TOOL_CATALOGUE` is no longer empty. The worker's gate lists `message_send`, but it can never run it: the tool is not runtime-invocable, and the worker has no executors.

## Limitations

- **WhatsApp text only.** No templates, media, reactions or interactive messages.
- **`unknown` is resolved by nobody yet.** A delivery report cannot match it without the provider id.
- **No automation.** No workflow, auto-assignment, auto-reply, follow-up or campaign.
- **Sending is off in every environment** until infrastructure sets `CHANNEL_SECRETS_PROJECT_ID`, `WHATSAPP_GRAPH_API_VERSION` and `DEPLOYMENT_ENVIRONMENT` for the API. That is **INFRASTRUCTURE REQUIRED**, and Geovet applies it.
- **The web composer is a component,** not yet mounted. The web app has no signed-in inbox yet (routing, data fetching and sign-in are separate decisions).

## Future path

- Templates, for replies outside the window, with their own approval and cost decisions.
- Reconciling `unknown` messages, from delivery reports or the provider's API, with a person deciding.
- Other channels: one adapter each, with their own window rules.
- Specialists replying through the runtime path (ADR-0031), never through this one.
- Channel cost metering, when credits reservation exists.
