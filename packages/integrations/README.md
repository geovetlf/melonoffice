# @melonoffice/integrations

The Integration Engine ([ADR-0044](../../docs/adr/0044-integration-engine.md)): the one way MelonOffice reaches an outside service, in both directions. Server only.

- `engine.ts`: `createIntegrationEngine()`: webhook handshake and delivery (verify, normalize, persist, acknowledge), `availability()` and `send()` for the `message_send` executor, and `validate()` for a connection's credentials. It is the only caller of an adapter.
- `registry.ts`: `createIntegrationRegistry()`, the official providers a server speaks to, by provider id, category and channel.
- `lifecycle.ts`: connection states (`created`, `connecting`, `connected`, `paused`, `error`, `disconnected`, `revoked`) and their transitions.

- `adapter.ts`: `ChannelAdapter` (verify signature, handshake, normalize inbound and outbound, send, validate, health check, capabilities) and the normalized delivery.
- `whatsapp.ts`: `createWhatsAppAdapter()` for Meta's official Cloud API. `X-Hub-Signature-256` checked in constant time, payloads bounded and normalized, send only with a configured Graph API version. Meta's numeric error codes map to stable codes; the 24-hour service window is `WHATSAPP_SERVICE_WINDOW_MS`.
- `secrets.ts`: `SecretRef`s derived from the connection id, `SecretStore`, and `createSecretManagerStore()` (Secret Manager REST with the runtime identity; no key, no SDK). Secret values are never stored, logged or returned.
- `connections.ts`: channel connections (non-sensitive account data + secret references), their repository port and `createChannelConnectionService()`: create, rename, connect, pause, disconnect and revoke, each with its own permission (`channel.create`, `channel.update`, `channel.disconnect`, `channel.delete`), a person acting directly, and the organization's `integrations.categoriesAllowed` and `integrations.connectionsMax`.

- `outbound.ts` ([ADR-0034](../../docs/adr/0034-human-tool-invocation.md)): a person's reply. `createChannelMessageExecutor()` is the executor of the `message_send` tool, which only the tool gate calls: it re-reads the reserved message, conversation and identity in the organization and sends once through the engine, which checks the connection, its capabilities and the service window and reads the token. `createMessageSendService()` is the synchronous flow around the gate: authorize, reserve the message, create and start its one-node execution, invoke the gate, settle what the executor did not (`failed`, or `unknown`, never resent).

- `agent-turns.ts` ([ADR-0043](../../docs/adr/0043-conversation-agent.md)): an agent's turn; before any model call it asks the engine whether the connection could send.

Nothing here sends on its own: a message leaves only through the tool gate, for a person or for an agent within its autonomy level. There are no templates or media.
