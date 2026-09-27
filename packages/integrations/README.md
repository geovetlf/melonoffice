# @melonoffice/integrations

Channels behind one interface ([ADR-0033](../../docs/adr/0033-conversations-foundation.md)). Server only.

- `adapter.ts`: `ChannelAdapter` (verify signature, handshake, parse, send) and the normalized delivery.
- `whatsapp.ts`: `createWhatsAppAdapter()` for Meta's official Cloud API. `X-Hub-Signature-256` checked in constant time, payloads bounded and normalized, send only with a configured Graph API version.
- `secrets.ts`: `SecretRef`s derived from the connection id, `SecretStore`, and `createSecretManagerStore()` (Secret Manager REST with the runtime identity; no key, no SDK). Secret values are never stored, logged or returned.
- `connections.ts`: channel connections (non-sensitive account data + secret references), their repository port and `createChannelConnectionService()` (create/disable need `channel.manage`, a person acting directly, and room under `integrations.connectionsMax`).
- `ingress.ts`: `createWebhookIngress()`: receive, verify, normalize, persist, acknowledge. The organization comes from the stored connection, and every event must name that connection's own account.

Nothing here sends on its own: sending goes through the tool gate (CV-2).
