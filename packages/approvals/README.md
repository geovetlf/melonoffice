# @melonoffice/approvals

Human approvals for tool calls ([ADR-0026](../../docs/adr/0026-tools-approvals-and-guardrails.md)). An approval covers exactly one operation: organization, execution, node, specialist version, tool version, action and input digest. Server only, with no HTTP.

- `model.ts`: `pending` → `approved`, `rejected`, `expired` or `cancelled` (all final), the binding digest, `decide()` and `checkApprovalUse()`.
- `repository.ts`: the `ApprovalRepository` port and a memory implementation; writes carry their audit events.
- `service.ts`: `createApprovalService()`, on a resolved `TenantContext`. Approving and rejecting need `approval.approve` and the user acting directly, never GIA.
