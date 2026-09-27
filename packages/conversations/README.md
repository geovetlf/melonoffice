# @melonoffice/conversations

The conversations domain ([ADR-0033](../../docs/adr/0033-conversations-foundation.md)): contacts, channel identities, conversations and messages, tenant-scoped, with no provider types. Server only.

- `model.ts`: the records' rules. Deterministic ids (identity, conversation, inbound and outbound message), `checkInbound`, `applyInbound` (new address → new contact, never merged by name), `applyStatus` (forward only, `failed` final), status transitions and tags.
- `repository.ts`: the `ConversationRepository` port and a memory implementation. `receive` is idempotent on organization + channel + provider message id.
- `service.ts`: `createConversationService()` for the human inbox (list with filters, read, assign to a member or department, status, tags, contacts) on a resolved `TenantContext`; changes need a person acting directly and are audited. `createConversationIngress()` stores what a verified channel delivered; it never runs a model, a tool or a workflow.
