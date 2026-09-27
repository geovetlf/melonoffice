# @melonoffice/specialists

Specialists: the agents of MelonOffice ([ADR-0025](../../docs/adr/0025-departments-and-specialists.md), D-28). A specialist is a record with an identity and a versioned execution profile, not a running AI. Server only, with no HTTP.

- `lifecycle.ts`: `draft`, `active`, `paused`, `disabled`, `archived` (final); only `active` takes new work.
- `model.ts`: the configuration (role, skills, tools, permissions and policy references), `newSpecialist()`, `reviseSpecialist()` (every change is a new, immutable version), `applySpecialistStatus()` and the write checks that keep history from being rewritten.
- `repository.ts`: the `SpecialistRepository` port and a memory implementation.
- `eligibility.ts`: `decideEligibility()`, the deterministic answer to "can this specialist take new work?", returning the assignment and the versions for the execution's snapshot.
- `service.ts`: `createSpecialistService()`, on a resolved `TenantContext`, including the `AssignmentGuard` the execution service asks before recording a specialist.
