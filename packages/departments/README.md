# @melonoffice/departments

Departments of an organization ([ADR-0025](../../docs/adr/0025-departments-and-specialists.md)). Server only, with no HTTP.

- `catalogue.ts`: the department catalogue. The default one offers the six types of ADR-0047 and keeps the retired `design_video` (merged into Marketing) so existing departments still resolve. New types are data.
- `model.ts`: ids (`{organizationId}_{typeId}`), `provisionDepartments()` for a new organization, the lifecycle (`active`, `paused`, `archived`, which is final) and stored-record checks.
- `repository.ts`: the read-only `DepartmentRepository` port and a memory implementation. Departments are created with their organization, by tenancy.
- `service.ts`: `createDepartmentService()`, on a resolved `TenantContext`.
