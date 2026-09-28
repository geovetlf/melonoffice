# ADR-0044: The Integration Engine, connections and the first real channel

- Status: Proposed (CV-6C, pending Geovet's review)
- Amended by: [ADR-0045](0045-channel-delivery-limits-and-retries.md) (limits and retries), [ADR-0046](0046-channel-templates-and-media.md) (templates and media)
- Date: 2026-09-28
- Amends:
  - [ADR-0033](0033-conversations-foundation.md) (connections: lifecycle, routes, permissions; `channel.manage` is replaced)
  - [ADR-0007](0007-plans-entitlements.md) concept of per-organization overrides, now wired and audited
- Builds on: ADR-0020 (audit), ADR-0021 (entitlements), ADR-0026 (tool gate), ADR-0027 and ADR-0038 (AI Gateway, credits), ADR-0032 (worker, Cloud Tasks), ADR-0034 (sending through the tool gate), ADR-0039 (control and autonomy), ADR-0043 (conversation agent).
- Does not change: plans or their values, credit rates, models, the tool gate, the AI Gateway, the credits engine, the jobs queue.

## Context

CV-1 to CV-6B built WhatsApp pieces one by one: a connection record, a webhook ingress, a send executor and an agent that uses it. Geovet's CV-6C brief asks for the general structure every future integration uses (WhatsApp first, then email, calendar, CRM, storage), with WhatsApp as its first real adapter and the MOpruebas organization as its first real DEV connection. It forbids any DEV-only hack, any permanent change to a plan's limits, any parallel path (webhook → model, agent or runtime → provider) and any second gateway, credits engine or tool gate.

## Decision

### 1. One engine, both directions

`packages/integrations` exposes `createIntegrationEngine()`. It is the only code that calls a provider adapter (an architecture test enforces it):

```
Inbound:  provider → POST /webhooks/{channel}/{connectionId} → engine.deliver
          → adapter.verifySignature → adapter.normalizeInbound → connection → organization
          → conversations ingress (identity → contact → conversation → message)
          → agent turn trigger (ADR-0043) → Cloud Tasks → worker

Outbound: person (API) or agent turn (worker) → Tool Gate → message_send executor
          → engine.send (connection, lifecycle, capability, service window, last check,
            credential) → adapter.normalizeOutbound → adapter.send → official API
```

The engine decides whether a connection may be used. It never decides who may use it (RBAC and the tool gate do) and never calls a model (the AI Gateway does).

### 2. Provider registry

`createIntegrationRegistry(adapters)` holds the adapters a server speaks to. Provider ids are stable (`^[a-z][a-z0-9_]{2,40}$`), each belongs to one category (`messaging`, `email`, `calendar`, `crm`, `storage`) and one channel, and a channel has one provider. The API and worker register `meta_whatsapp_cloud` only where channel secrets are configured. Tests register fakes. `GET /v1/organizations/:id/integrations/providers` lists what is registered.

### 3. Connection model

`ChannelConnection` (domain) carries: `id`, `organizationId`, `provider`, `category`, `channel`, `status`, `statusReason?`, `displayName`, `account` (non-sensitive, checked by the adapter), `capabilities`, `secrets` (references only), `createdAt/By`, `updatedAt/By`, `lastValidatedAt?` and `revision`. The provider, category, channel, account and secret references are immutable after creation.

Lifecycle (`lifecycle.ts`): `created → connecting → connected | error`, `connected ↔ paused`, any live state → `disconnected`, anything → `revoked` (final). `connected` is reachable only from `connecting`, that is, only after the provider confirmed the credentials. Only `connected` sends; `connected`, `paused` and `error` still accept inbound messages (nothing a customer sends is lost); a disconnected or revoked connection accepts nothing. A provider credential failure while sending (Meta code 190) moves the connection to `error`, audited as `channel.connection_failed`.

### 4. Channel adapter

`ChannelAdapter`: `checkAccount`, `accountIdOf`, `verifySignature`, `handshake` (receive side), `normalizeInbound`, `normalizeOutbound`, `send`, `validateConnection`, `healthCheck`, and static `capabilities`. Capabilities (`inboundText`, `outboundText`, `outboundMedia`, `outboundTemplates`, `deliveryStatus`, `maxOutboundTextLength`, `serviceWindowMs`) are data: the engine refuses what a provider cannot do (`capability_not_available`) rather than code knowing the channel.

### 5. WhatsApp adapter

Meta's official WhatsApp Cloud API only, called directly (no intermediary, no SDK):

- `X-Hub-Signature-256` HMAC with the connection's app secret, compared in constant time; bounded payload; the payload must name the connection's own phone number id.
- `validateConnection`/`healthCheck`: `GET graph.facebook.com/{version}/{phoneNumberId}?fields=id` with the access token; valid only when the id matches. Meta's codes map to stable codes; rate limits and temporary errors are `unavailable`, never retried in a loop.
- Sending needs a configured Graph API version (`WHATSAPP_GRAPH_API_VERSION`, from Terraform); without one it fails closed. Text only, within the 24-hour service window; templates and media are not offered (since added by ADR-0046).

### 6. Permissions

`channel.manage` is removed and split: `channel.read`, `channel.create`, `channel.update` (rename, connect, pause), `channel.disconnect`, `channel.delete` (revoke). Using a channel is not a channel permission: it is `conversation.send` through the tool gate's `message_send`. All are given to the owner only (D-27). Every change needs a person acting directly. `specialist.manage` is not created.

### 7. Plans, limits and per-organization overrides

Creating (and reconnecting from `disconnected`) checks the organization's entitlements: `integrations.categoriesAllowed` must include the provider's category, and `integrations.connectionsMax` must leave a slot (connections not disconnected or revoked occupy one). Emprendedor sets neither, so every organization on it is refused. The plan is not changed.

An organization can be allowed past its plan only through an entitlement override: one value, for one organization, with a reason, an approver who is a MelonOffice user and an optional expiry. Overrides live in `entitlementOverrides/{orgId}`, are written with their audit event (`entitlements.override_set`) in one transaction, and are applied by the entitlement service after the plan. Server code has no organization, plan or environment special case. The only writer is an operator CLI (`apps/api/src/set-entitlement-override.ts`) run by the owner from Cloud Shell with their own credentials; there is no HTTP route.

### 8. Identity, tenancy and idempotency

The organization comes from the stored connection, never from a request. Resolution is organization → connection → contact identity (by the provider's id for the contact, per connection) → contact → conversation (one per identity and connection) → message (unique by the provider's message id). A redelivered event stores nothing new, starts no turn (turn idempotency key `conversation-turn:{inboundMessageId}`), charges no credit twice (credit reservations keyed per turn) and sends nothing twice (one reserved message per send; `unknown` is never resent).

### 9. Tool gate, autonomy and control

Every send, a person's or an agent's, is `message_send` through the one tool gate (ADR-0034, ADR-0043), whose executor calls `engine.send`. MANUAL never lets an agent answer, ASSISTED only drafts, SUPERVISED needs a person's approval, AUTONOMOUS sends within its reply limit. Before an agent turn calls the model, the trigger asks `engine.availability`: when the connection cannot send (not connected, no text capability, outside the service window), the conversation goes to a person (`channel_unavailable`) with no model call and no credit. The engine asks the agent's last check (control, epoch, latest inbound) right before calling the provider, so takeover and epoch protections still hold.

### 10. Credits and AI

Only the AI Gateway calls a model and only the credits engine charges, as in ADR-0038 and ADR-0043. The engine adds no charge: MelonOffice has decided no price for WhatsApp messages, so none is charged or invented. Without credits the gateway refuses before the provider (model) is called.

### 11. Limits

Limits come from existing mechanisms: the plan's connection count and categories, the agent's reply limit per conversation, the turn's attempt limit, credits, the service window and the provider's text length. A provider rate limit is reported as `unavailable` and handed to a person, never retried in a loop. A per-connection throughput limiter is not added in CV-6C.

### 12. Secrets

Each connection's secrets are `channel-{connectionId}-{app-secret|access-token|verify-token}` in the environment's own Secret Manager, created by the owner. The connection stores only references derived from its id. Values are read at the moment of use with the runtime identity (no key) and never stored, logged, audited, returned or put in an error. The API returns only the secret ids to create and the webhook path.

### 13. Audit and observability

Audited: `channel.connection_created`, `_updated`, `_checked`, `_paused`, `_disconnected`, `_revoked`, `_failed`; `conversation.message_received`; the existing `conversation.message_sent`/`_failed`, `execution.*`, `tool.*`, `approval.*`, `ai.*`, `credits.*` and handoff events. `entitlements.override_set` for overrides. Log lines carry organization, connection, provider, conversation, execution, node and request ids, never content or secrets.

### 14. Infrastructure

Dev only (`conversation_agents`, `whatsapp_channel`, `whatsapp_graph_api_version`; staging and prod refuse them in `check-environments.sh`):

- worker: the existing Vertex invoker custom role;
- api: `cloudtasks.enqueuer` on the existing execution jobs queue, and `serviceAccountUser` on the job dispatch identity only;
- api and worker: `secretAccessor` conditioned on `secrets/channel-*`;
- the Secret Manager API.

No new queue, service or identity. Terraform is not applied by this change.

### 15. The first DEV connection (MOpruebas)

Through the same engine and routes as any organization:

1. The owner sets two audited overrides for MOpruebas: `integrations.categoriesAllowed=["messaging"]`, `integrations.connectionsMax=1`.
2. The owner creates the connection (`POST channel-connections`), creates its three secrets in Secret Manager and configures Meta's webhook to `{api}/webhooks/whatsapp/{connectionId}`.
3. `POST channel-connections/:id/connect` validates the credentials with Meta.
4. `seed-test-agent` (DEV only, refuses any other environment, no organization in code) seeds the test agent and chooses it at the requested level.

Another organization on the same plan still gets nothing. Prod gets no DEV configuration.

## Consequences

- A new channel is one adapter registered in the engine plus its capabilities; no route, tool or agent code changes.
- Connections can be created only through an audited override until D-12 gives plans integration allotments.
- Settings → Connections (web, `/settings/connections`) is the screen over these routes: it lists the registry's providers and the organization's connections, offers each action only with its own permission (the API still decides), asks only for non-secret account fields, and shows the secret names and webhook URL to set up, never a secret value.
- Pending: per-connection throughput limits, templates and media, delivery-status driven retries (CV-6D and later).
