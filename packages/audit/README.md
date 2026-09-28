# @melonoffice/audit

Records what happened ([ADR-0020](../../docs/adr/0020-audit-log-foundation.md)). It never decides access: authentication, tenancy and RBAC do.

- `actions.ts`: the catalogue of auditable actions, the only place action ids are defined.
- `event.ts`: `AuditEvent`, `buildAuditEvent()` (checks every field) and `actorOf()`.
- `service.ts`: the append-only `AuditStore` port and `AuditService`, plus `AuditHistoryReader.history()`: one target's events, newest first, at most 200 (C2, [ADR-0054](../../docs/adr/0054-opportunities-and-pipeline.md)).
- `memory.ts`: an in-memory store for tests. The Firestore store is in `apps/api`.

It knows nothing about HTTP. Server-only.
