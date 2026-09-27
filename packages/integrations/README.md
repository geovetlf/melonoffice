# @melonoffice/integrations

Channels behind one interface ([ADR-0033](../../docs/adr/0033-conversations-foundation.md)). Server only.

- `adapter.ts`: `ChannelAdapter` (verify signature, handshake, parse, send) and the normalized delivery.
- `whatsapp.ts`: `createWhatsAppAdapter()` for Meta's official Cloud API. `X-Hub-Signature-256` checked in constant time, payloads bounded and normalized, send only with a configured Graph API version. Meta's numeric error codes map to stable codes; the 24-hour service window is `WHATSAPP_SERVICE_WINDOW_MS`.
- `secrets.ts`: `SecretRef`s derived from the connection id, `SecretStore`, and `createSecretManagerStore()` (Secret Manager REST with the runtime identity; no key, no SDK). Secret values are never stored, logged or returned.
- `connections.ts`: channel connections (non-sensitive account data + secret references), their repository port and `createChannelConnectionService()` (create/disable need `channel.manage`, a person acting directly, and room under `integrations.connectionsMax`).
- `ingress.ts`: `createWebhookIngress()`: receive, verify, normalize, persist, acknowledge. The organization comes from the stored connection, and every event must name that connection's own account.

- `outbound.ts` ([ADR-0034](../../docs/adr/0034-human-tool-invocation.md)): a person's reply. `createChannelMessageExecutor()` is the executor of the `message_send` tool, which only the tool gate calls: it re-reads the reserved message, conversation, connection and identity in the organization, checks the service window, reads the token from the secret store and sends once. `createMessageSendService()` is the synchronous flow around the gate: authorize, reserve the message, create and start its one-node execution, invoke the gate, settle what the executor did not (`failed`, or `unknown`, never resent).

Nothing here sends on its own: a message leaves only when a person sends it, through the tool gate. There are no templates, no automation and no AI.
