# ADR-0025: Departments, specialists and the execution profile

- Status: Accepted (Phase X2; accepted by Geovet, 2026-09-27)
- Date: 2026-09-27
- Builds on: [ADR-0005](0005-initial-departments.md) (D-11), [ADR-0006](0006-no-fixed-specialist-quantity.md) (D-12a), [ADR-0008](0008-entity-model.md) (D-28), [ADR-0009](0009-one-main-specialty-per-specialist.md) (D-29), [ADR-0018](0018-tenancy-and-memberships.md), [ADR-0019](0019-rbac-foundation.md) and [ADR-0024](0024-execution-foundation.md)

## Context

ADR-0008 stated the entity model as types only: specialist management was left for a later phase. X1 (ADR-0024) gave executions a place to name a specialist, but nothing stored departments or specialists, so an execution could name one that did not exist.

X2 builds the organizational layer that agents run in: departments, the specialist as the agent (D-28) with a versioned execution profile, and a deterministic answer to "can this specialist take this work?". It runs no AI.

## Decision

### Packages

- `packages/departments`: the catalogue, the department model and lifecycle, provisioning, and a read service.
- `packages/specialists`: the specialist model, lifecycle, versioning, eligibility and a read service.

The domain types stay in `@melonoffice/domain`, and the Firestore adapters stay in `apps/api`, as for every other store. There is **no Agent entity**: the existing `Specialist` is extended (D-28).

### Department

A department has these fields:

- `id` and `organizationId`;
- `origin`: a catalogue type with the type's version, or the company's own custom name;
- `status`;
- optional `purpose` and `description`: the company's own words, absent until written;
- `revision`, `createdAt` and `updatedAt`.

Rules:

- **Names.** A catalogue department is named by its type's message keys, translated by the app (D-17), not by a stored string. No purpose or description text is invented for catalogue departments.
- **Lifecycle.** `active ↔ paused`, and either of them → `archived`, which is final. A department is never deleted. Only an `active` department takes new specialists or new work.
- **Ids.** A catalogue department's id is `{organizationId}_{typeId}`. An organization can hold only one department per type, the id names its organization, and provisioning is idempotent.

### Catalogue (D-11)

The default catalogue holds the seven approved types:

| Id             | Department          |
| -------------- | ------------------- |
| `leadership`   | Consejo y Dirección |
| `operations`   | Operaciones         |
| `sales`        | Comercial y Ventas  |
| `marketing`    | Marketing           |
| `design_video` | Diseño y Video      |
| `research`     | Investigación       |
| `finance`      | Finanzas            |

**Consejo y Dirección and Finanzas are two separate departments.** The catalogue is data: adding Legal, HR, Customer Support, Purchasing or Technology is a new entry, with no model or code change. No code lists the types itself. The EN and ES names are in the i18n catalogues.

### Provisioning: with the organization, in the same write

The existing flows were reviewed before choosing:

- Billing opens the account and first subscription inside the organization's creation transaction (ADR-0022).
- The audit events for the creation are written in that same transaction (ADR-0020).

Departments follow the same pattern. `createOrganization` takes an optional `departments` builder; the API passes one that provisions every catalogue type as `active`. The organization, membership, billing, departments and audit events are created together or not at all.

The alternatives were rejected:

- A separate provisioning service would leave a window where an organization exists without departments.
- An explicit bootstrap would need a write route, which X2 does not add.

Tenancy stays independent of the departments package: it receives plain `Department` records and checks that they belong to the new organization.

**No specialists are created automatically.** There is no approved policy for a default composition (D-12a).

Organizations created before X2 have no departments. The provisioning function is deterministic and its ids are unique per type, so a backfill can use it safely; running one is a separate, explicit decision.

### Specialist = agent

A specialist has:

- **Identity:** a permanent id (UUID), `displayName`, optional `avatar`, `createdAt` and `createdBy`. Identity is not versioned (ADR-0008).
- `organizationId`, `status`, the current `version` and its `configuration`, `revision` and `updatedAt`.

The **configuration**, which is its execution profile, holds:

- `departmentId`;
- `mainRoleId` and `roleVersion`: one main role (D-29);
- optional `purpose` and `description`;
- `capabilities`: stable codes;
- `skills` and `tools`: versioned references;
- `permissions`: RBAC permission ids;
- `policies`: versioned references for `model`, `context`, `budget`, `approval` and `verification`.

X2 only references skills, tools and policies. The engines behind them come later, and no data is invented for them. Every permission must exist in the RBAC catalogue. A specialist holds no permissions of its own: it acts for a user, and `permissions` only lists what that user must hold (D-25).

### Specialist lifecycle

| From       | To                                 |
| ---------- | ---------------------------------- |
| `draft`    | `active`, `archived`               |
| `active`   | `paused`, `disabled`, `archived`   |
| `paused`   | `active`, `disabled`, `archived`   |
| `disabled` | `active`, `archived`               |
| `archived` | nothing (history; nothing changes) |

- Only `active` is eligible for new executions.
- A status change is not a configuration change, so it creates no version.
- A specialist with history is never deleted.

### Versioning

- **Every configuration change creates the next version** (`n + 1`). A change that says nothing new is refused, and so is a change built on an older version.
- Versions are stored in `specialistVersions/{specialistId}_{version}` with Firestore `create`: written once and never changed.
- The repository refuses anything that would rewrite history:
  - a configuration change without a new version;
  - a skipped version number;
  - a version whose configuration differs from the specialist's;
  - re-creating an existing version.
- Moving to another department is a configuration change, so it is a new version, and it needs the target department to be `active`.

The version is recorded in the execution's existing version snapshot as `{ kind: 'specialist', id, version }` (ADR-0024). There is no second versioning system.

### Execution relationship

`Execution` gains `specialistVersion` and `departmentId` next to the existing `specialistId`.

- The three fields are present together or not at all.
- The snapshot must record the same specialist version. This is checked on creation and on every read.

The execution service takes an `AssignmentGuard`, implemented by the specialists service:

- An execution that names a specialist is created only when the guard confirms eligibility.
- Without a guard, it is refused (`specialist_not_eligible`).

From the stored records alone, an execution rebuilds organization → department → specialist → specialist version → the configuration that version held. Later changes to the specialist do not change what an execution recorded.

### Eligibility

`decideEligibility` is deterministic: no AI and no matching. A specialist is eligible only when every check holds, in this order:

1. it exists in the tenant's organization (another organization's answers `specialist_not_found`, like a missing one);
2. it is `active`;
3. it belongs to the requested department;
4. that department is in the organization and `active`;
5. the requested version is the current one and is stored as the specialist says;
6. the user holds every permission the version lists.

When eligible, the decision returns the assignment and the version references (specialist, role, skills, tools, policies) for the execution's snapshot.

Plan entitlements (`departments.allowed`, `agents.perDepartmentMax`) are not checked yet. They apply when executions are started for real, through the existing `authorize()` chain (ADR-0013).

### Tenancy and RBAC

- Every service method takes a `TenantContext` from `resolveTenant()` and refuses an inactive organization.
- Nothing is read from the body, query or headers.
- Two new permissions, `department.read` and `specialist.read`, are given to `owner`. There is no `specialist.execute` and no new role: D-27 is still pending, and tests use test role catalogues only.

### API

| Route                                                   | Answer                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/organizations/:organizationId/departments`     | `{ departments: [...] }`                                            |
| `GET /v1/organizations/:organizationId/departments/:id` | one department, or `404 department_not_found`                       |
| `GET /v1/organizations/:organizationId/specialists`     | `{ specialists: [...] }`, in every status, so history stays visible |
| `GET /v1/organizations/:organizationId/specialists/:id` | one specialist, or `404 specialist_not_found`                       |

- Another organization's department or specialist, a missing one and a malformed id all get the same 404.
- The views leave out the revision and storage details. The specialist view also leaves out tools, required permissions, policies and its creator.
- There is no route that creates, changes, deletes or runs a department or specialist.
- Without the stores, these routes answer `503 structure_not_configured`.

### Persistence

| Collection                                    | Holds                                         |
| --------------------------------------------- | --------------------------------------------- |
| `departments/{organizationId}_{typeId}`       | the department                                |
| `specialists/{specialistId}`                  | the specialist with its current configuration |
| `specialistVersions/{specialistId}_{version}` | every version, immutable                      |

- Lists use `where('organizationId', '==', …)`, which Firestore's automatic single-field index serves. There is no new index and no Terraform change.
- Every read checks the organization field and validates the record. A malformed record is refused, never repaired.
- Specialist writes run in a transaction: the specialist is written at one revision ahead, together with its new version.

### Audit

No new audit events.

- Departments are created inside the organization's creation, which is already audited.
- No route writes a department or specialist. Creating, changing and archiving specialists will be audited in the same transaction when the first route that does it exists.
- No execution events are invented.

## Not in this change

Planner, Agent Engine, LLM execution, AI Gateway, Provider Registry, Skills and Tool engines, MCP, browser automation, Workflow Engine, scheduler, events, approval, guardrails and verification engines, memory, Company Brain, cost and metering, GIA orchestration, voice, connectors, UI, write routes, plan-entitlement checks on assignment, Terraform and Cloud Run changes.

## Consequences

- Later phases turn specialists into running agents through the execution service. Eligibility and the version snapshot already apply to them.
- Specialist history can only grow. An execution's specialist version always means the configuration it ran with.
- New department types, custom departments and new policy kinds need no migration.
