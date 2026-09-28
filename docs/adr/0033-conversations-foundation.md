# ADR-0033: Conversations foundation and human inbox API (CV-1)

- Status: Proposed (Phase CV-1, pending Geovet's review)
- Amended by: [ADR-0044](0044-integration-engine.md) (connection lifecycle and routes; `channel.manage` split into `channel.create`, `channel.update`, `channel.disconnect` and `channel.delete`; `channel.connection_disabled` replaced by the lifecycle events)
- Date: 2026-09-27
- Builds on:
  - [ADR-0018](0018-tenancy-and-memberships.md)
  - [ADR-0019](0019-rbac-foundation.md)
  - [ADR-0020](0020-audit-log-foundation.md)
  - [ADR-0021](0021-entitlements-plan-and-capability-foundation.md)
  - [ADR-0025](0025-departments-and-specialists.md)
  - [ADR-0026](0026-tools-approvals-and-guardrails.md)
- Source of truth: the Conversations Center architectural audit (`melonoffice-plan/MelonOffice-Conversations-Architectural-Audit.md`, shared project files).
- Decisions it applies (Geovet, 2026-09-27):
  - **DG-1:** AI is human-invoked only; no autonomous AI. Future owner-granted autonomy never widens permissions.
  - **DG-2:** WhatsApp through Meta's official Cloud API, behind an adapter. No other channel now.
  - Identity safe by default: never merged by name, username, photo or text.
  - Specialist = Agent; no Task entity; no new global actor; no Activity collection.
- Open decisions it respects: DG-3 (ingress location), DG-5 (retention), the human send path (CV-2), D-12 (connection limit value), D-27 (roles).
- Followed by: [ADR-0034](0034-human-tool-invocation.md) decides the human send path (CV-2); [ADR-0035](0035-conversations-inbox.md) makes the inbox usable (CV-3).

## Context

MelonOffice needs a Conversations Center: customers write on a channel, people in the organization answer, and later Specialists help when a person invokes them. CV-1 is the foundation: receive a WhatsApp message, store it safely in the right organization, and let people read and triage it. Nothing answers yet.

## Decision

### Packages

- `@melonoffice/conversations`: the domain. It has no provider types.
  - Contact, ChannelIdentity, Conversation (`open`/`pending`/`closed`) and Message (`inbound`/`outbound`; types prepared, text in CV-1).
  - Pure rules: `applyInbound`, `applyStatus`, the status transitions and tags.
  - `ConversationRepository`, a port with a memory implementation.
  - `ConversationService`, for the human inbox.
  - `ConversationIngress`, which stores what a verified channel delivered.
- `@melonoffice/integrations`: channels.
  - The `ChannelAdapter` interface and `WhatsAppAdapter`.
  - Channel connections: the model, repository and service.
  - Secret references and the Secret Manager reader.
  - `WebhookIngress`.
- `@melonoffice/firestore`: `FirestoreConversationRepository` and `FirestoreChannelConnectionRepository`.
- `apps/api`: the webhook route and the inbox routes.

The domain never imports integrations. Adding Instagram, Messenger, Telegram, email or web chat means one more adapter; the domain does not change.

### Tenancy and identity

Every record carries `organizationId`, and every read checks it. Another organization's record answers exactly like a missing one. Ids that must never be duplicated are derived from their parts with `nameBasedUuid`:

| Record           | Id derived from                                    |
| ---------------- | -------------------------------------------------- |
| channel identity | organization + channel + external id               |
| conversation     | organization + connection + identity               |
| inbound message  | organization + channel + provider message id       |
| outbound message | organization + conversation + the sender's own key |

- **External ids are never global.** The same WhatsApp number, or the same provider message id, in two organizations gives two different identities, conversations and messages.
- **A new address creates a new contact.** Nothing is merged by name, photo or text. A second contact with the same display name is a different contact. Merging is a later decision, made by a person.
- **One conversation per identity and connection.** When the contact writes again, the same conversation reopens.

### Idempotency

The inbound message id is the idempotency key: organization + channel + provider message id.

- In Firestore, `receive` is one transaction. It reads the message document first. If the document exists, the call is a duplicate and nothing is written.
- Otherwise it creates the message and creates or updates the conversation. It creates the contact and identity only for a new address.
- The transaction retries on contention, so concurrent copies of one delivery store one message. A test proves this against the emulator.

### Webhook: receive, verify, normalize, persist, acknowledge

`GET` and `POST /webhooks/:channel/:connectionId` sit outside `/v1`, because the provider has no user token.

1. **Channel and connection.** An unknown channel or connection, or a malformed id, answers 404. A disabled connection answers 403.
2. **Organization.** It comes from the stored connection, never from the request body, the query or a header.
3. **Signature.** `X-Hub-Signature-256` is checked as HMAC-SHA256 over the exact raw body, using the connection's app secret, in constant time. A bad signature answers 401.
4. **Payload.** It is parsed and normalized, bounded to 256 KiB and 100 events, and must be JSON. Anything malformed answers 400, before anything is stored.
5. **Account binding.** Every event must name the connection's own `phone_number_id`, or 403 `account_mismatch`. A payload signed with one organization's secret can never write into another organization.
6. **Storage.** Messages are stored idempotently. Delivery statuses move our own outbound messages forward only.
7. **Acknowledgement.** The answer is 200 `{received, duplicates, statuses}`.

The webhook never runs a model, a tool or a workflow, and makes no call to the provider. The subscription handshake (`hub.challenge`) is answered only with the connection's verify token.

### Credentials

- Access tokens, app secrets and verify tokens live in **Google Secret Manager**. They are never in Firestore, logs, audit, errors or API answers.
- A connection stores only `SecretRef`s: the resource names `projects/{p}/secrets/channel-{connectionId}-{kind}/versions/latest`. The server derives them from the connection id, and stored data is refused if a reference names another connection.
- A client cannot point a connection at someone else's secret.
- Secrets are read at the moment of use through the Secret Manager REST API, with the service's own identity from the metadata server. There is no key and no SDK.
- The channel connections list never returns the references.

### Channel connections

A connection is created only on the server: there is no HTTP route in CV-1. Creating or disabling one needs all of the following:

- `channel.manage`;
- a person acting directly (never GIA or the runtime);
- a secrets project;
- room under the plan's `integrations.connectionsMax` limit. That limit is unset for Emprendedor, which means 0, so creation is denied until D-12.

Creating and disabling are audited (`channel.connection_created`, `channel.connection_disabled`).

### Human inbox API

All routes are under `/v1/organizations/:organizationId`, through `withPermission`:

| Route                               | Permission            |
| ----------------------------------- | --------------------- |
| `GET conversations` (filters below) | `conversation.read`   |
| `GET conversations/:id`             | `conversation.read`   |
| `GET conversations/:id/messages`    | `conversation.read`   |
| `POST conversations/:id/assign`     | `conversation.manage` |
| `POST conversations/:id/status`     | `conversation.manage` |
| `POST conversations/:id/tags`       | `conversation.manage` |
| `GET contacts`, `GET contacts/:id`  | `contact.read`        |
| `GET channel-connections`           | `channel.read`        |

- **Filters:** `status`, `channel`, `assigneeId`, `unassigned`, `departmentId`, `contactId`, `tag`, `since`, `until` and `limit`. Any unknown or repeated key is refused.
- **Assignment** goes to an active member and/or one of the organization's departments. There is no AI routing.
- **Status and tags** follow the transitions (a closed conversation can only reopen) and a closed tag format.
- **Who can change.** Assignment, status and tags change only when a person acts directly. GIA and the runtime can read but never change (DG-1).
- **Audit:** `conversation.assigned`, `conversation.status_changed` (from/to) and `conversation.tags_changed`.
- **Permissions:** `conversation.read`, `conversation.manage`, `contact.read`, `channel.read` and `channel.manage` are new. They are given to the owner role only, with no new role (D-27).

### What a contact sends is not a user action

There is no global external actor.

- The origin is recorded in the data. A message's sender is `{kind: 'contact', channelIdentityId}`, and a contact's origin is `{kind: 'channel', channel, connectionId}`.
- Inbound storage writes no audit event, so a customer's message is never attributed to the organization's owner.
- Changes made by people are audited with their user actor, and configuration changes likewise.
- Audit therefore distinguishes HUMAN (user direct), SYSTEM (runtime) and EXTERNAL_CONTACT (in the domain, not in audit). Whether inbound messages also need an audit event is an open decision.

### Sending

There is no send route in CV-1.

- The adapter's `send` exists and is tested, so the foundation is ready. It needs a configured Graph API version (never guessed) and maps provider answers to stable codes.
- The only way a message may leave is Permission → Tool Gate → Channel Adapter → Provider. The tool gate needs an execution and a specialist.
- A person replying by hand needs a decided path through the gate (CV-2). CV-1 adds no bypass.
- A test pins that the API never calls `send` and that the tool catalogue is still empty.

### Reserved, not implemented

- `Conversation.handoff` (the AI → human handoff, CV-5) and `priority`.
- The non-text message types.
- `Message.sender` of kind `specialist`.

Nothing sets or reads them yet.

## Consequences

- WhatsApp messages can be received and triaged per organization, with no AI cost: no model is called and no credits are used.
- DEV today has no `CHANNEL_SECRETS_PROJECT_ID`, so `/webhooks/*` answers 503 and nothing changes in the running service.
- To receive for real (CV-2, **INFRASTRUCTURE REQUIRED**, Geovet applies it):
  - enable the Secret Manager API;
  - create the channel secrets;
  - grant the API service account `roles/secretmanager.secretAccessor` on them;
  - set `CHANNEL_SECRETS_PROJECT_ID` (and `WHATSAPP_GRAPH_API_VERSION` for sending);
  - register the webhook URL in Meta.
- Firestore uses single-field indexes and in-memory sorting and filtering, like the rest of the repository. Large inboxes will need composite indexes and pagination later.
- No retention rule exists yet (DG-5): messages are kept.

## Deferred

These are later phases, documented in the audit and the CV-1 report, and are not built here:

- CV-2: the human send path through the gate, plus infrastructure.
- CV-3: media.
- CV-4: invoked AI drafts.
- CV-5: handoff.
- CV-6: more channels.
- CV-7: CRM links.
- Later phases: broadcasts, analytics, voice and authorized autonomy.
