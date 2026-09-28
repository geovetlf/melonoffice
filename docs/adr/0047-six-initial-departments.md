# ADR-0047: Six initial departments, and retiring a catalogue type

- Status: Accepted (B1, PR #51, merged by Geovet on 2026-09-28; the migration has not been run)
- Date: 2026-09-28
- Supersedes: [ADR-0005](0005-initial-departments.md) (D-11, seven departments)
- Amends: [ADR-0025](0025-departments-and-specialists.md) (the catalogue gains retired types; a department is archived by the migration)
- Builds on: ADR-0020 (audit), ADR-0044 (operator tools), the Master Functional Map v1 and Geovet's decisions of 2026-09-28
- Does not change: specialists' identities or statuses, executions, conversations, the tool gate, the AI Gateway, the runtime, credits, permissions or infrastructure.

## Context

The Master Functional Map v1 organizes MelonOffice for small business owners around six departments. Geovet approved the change on 2026-09-28:

- move from seven departments to six;
- archive Design in existing organizations;
- delete no data, agents or history;
- Marketing takes over design and content.

Departments are catalogue data (ADR-0005, ADR-0025). A new organization gets one department per type inside its creation transaction, and nothing re-provisions an existing organization. No code assumes a count.

## Decision

### 1. The catalogue

| #   | ES            | EN         | Catalogue id | Version |
| --- | ------------- | ---------- | ------------ | ------- |
| 1   | Consejo       | Board      | `leadership` | 1       |
| 2   | Comercial     | Commercial | `sales`      | 1       |
| 3   | Marketing     | Marketing  | `marketing`  | **2**   |
| 4   | Operaciones   | Operations | `operations` | 1       |
| 5   | Finanzas      | Finance    | `finance`    | 1       |
| 6   | Investigación | Research   | `research`   | 1       |

- **Marketing** is version 2: it now also covers design and content.
- **Personal** (staff and attendance) is a tool inside Operaciones, not a department.
- **Ids.** They are unchanged, so every existing department id (`{organizationId}_{typeId}`) stays valid. Only the Consejo and Comercial labels changed (i18n).
- **GIA** is still not a department.

### 2. Retired types

- **The rule.** A catalogue type can be **retired** with `retired: { mergedInto }`:
  - New organizations no longer get it.
  - `find` still knows it, so its history keeps its name.
  - Its work moves to the type it merged into.
- **Checks when the catalogue is built.** The catalogue refuses a type that merges into nothing, into itself, or into another retired type.
- **The first retired type.** `design_video` (Design & Video) is retired into `marketing`.

### 3. The migration of existing organizations

`apps/api/src/migrate-departments.ts` is an operator tool, like ADR-0044's. It is run by the project's owner in Cloud Shell with their own credentials, and names an approving MelonOffice user (`APPROVED_BY`).

- **Dry run by default.** It reads and prints, per organization, what it would archive and how many agents it would move. `MIGRATION_APPLY=yes` writes. `ORGANIZATION_ID` limits it to one organization.
- **One transaction per organization, all or nothing.** For each retired type the organization holds:
  1. Every specialist of that department that is **not archived** moves to the organization's own department of the merged-into type. The move is a **new configuration version**:
     - The earlier versions stay unchanged.
     - Identity, status and history are unchanged.
     - The approver is recorded as the version's author.
  2. The retired department is **archived**, one revision later. It is never deleted.
  3. Each change records an audit event in the same transaction:
     - `department.archived`, with target the department and `reference: merged_into:{id}`;
     - `specialist.department_changed`, with target the specialist and `targetVersion`.
     - Both carry reason `department_type_retired`.
- **What it refuses.** If the merged-into department is not active (paused, archived or missing), the organization is **skipped and reported** (`merge_target_unavailable`), with nothing written, for a person to decide. The same happens if an agent cannot be moved (`specialist_not_movable`).
- **Idempotent.** A second run finds nothing to do and records nothing.
- **Isolation.**
  - The transaction reads and writes only the organization's own departments, specialists and events.
  - The plan ignores any record of another organization.
  - Every target id is derived from the organization's own id.
- **Untouched.** Archived specialists stay where they were (history). Executions, conversations, versions and audit events that name the old department keep naming it.

### 4. What people see

- **Web.** The web already leaves archived departments out, so a migrated organization shows six rooms.
- **API.** The departments route still returns the archived department by its name (`department.design_video.name`) as history.
- **Before the migration runs,** an existing organization still shows its Design & Video room, drawn as before.

## Consequences

- No Terraform or IAM change:
  - the migration uses the existing collections;
  - it uses Firestore's automatic single-field indexes (`typeId in […]`, `organizationId ==`);
  - it runs with the owner's own credentials.
- Running it in DEV is a separate step, done only on Geovet's word: dry run first, then apply.
- A later retired type needs only a catalogue entry. The same tool migrates it.
