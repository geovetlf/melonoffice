# ADR-0118: Agent search by skill and autonomy through Firestore indexes (Stage 1)

- Status: Proposed
- Date: 2026-10-02
- Builds on: [ADR-0115](0115-agent-lifecycle-readiness-pagination.md), [ADR-0116](0116-agent-autonomy-and-sensitive-actions.md), [ADR-0117](0117-agent-memory-handoffs-notifications.md)

## Context

Since AE-4 (ADR-0115), an organization's agents are listed one page at a time in id order.

- Status and department are equality filters in the store.
- A name search, a skill or an autonomy level is checked on what the store returns. Each request reads at most 500 agents (`AGENT_SCAN_MAX`) and returns a cursor where it stopped.
- The results are correct, but in an organization with thousands of agents and few matches, pages come back short or empty and the person has to ask for more.

The owner authorized only Stage 1 of the plan (`melonoffice-plan/MelonOffice-AE5-Busqueda-Agentes-Plan.md`). That means indexes and a fallback, with no data change and no migration.

## Decision

1. **Skill.** The store is asked for `configuration.skills array-contains-any [{id, version: 1}, …, {id, version: 30}]`, ordered by document id.
   - Firestore compares each stored `{id, version}` map whole, so no document is rewritten.
   - Thirty is Firestore's limit for `array-contains-any`. Catalogue skills are at version 3 at most today.
2. **Autonomy.** A level other than the default (`propose`, `within_policy`) is asked as `configuration.autonomy == level`.
   - The default, `controlled`, is not stored on older agents. It is still read the AE-4 way, never through the index.
3. **Combined filters.** The store asks one filter through the index: the skill if there is one, otherwise the autonomy level.
   - Status, department, name, and autonomy alongside a skill are checked on what the store returns, under the same 500-record bound.
   - Every filter, the organization included, is checked again on what the store returns.
   - When nothing else is checked, a page reads only the page size plus one record to look ahead.
4. **Fallback.** Without the index, Firestore answers FAILED_PRECONDITION.
   - The repository then throws `SpecialistIndexUnavailable` and logs `firestore.index_missing` with `specialists_skills` or `specialists_autonomy`.
   - The listing reads the same request the AE-4 way. Any other error is not hidden.
   - The code can therefore be deployed before the indexes exist.
5. **Cursors** stay the agent's id in both ways, so a cursor from one way goes on in the other. An agent added during a walk is seen once or not at all, never twice.
6. **Indexes** (Terraform, `infra/modules/environment/main.tf`, `google_firestore_index.specialists`), both on `specialists`, with the document id implicit:
   - `organizationId ASC`, `configuration.skills CONTAINS`;
   - `organizationId ASC`, `configuration.autonomy ASC`.

The API and the screen do not change: it is the same `GET /specialists?q=&skill=&autonomy=&status=&departmentId=&cursor=&limit=`.

## Not done (Stage 2, future work)

A `searchTokens` field for name search, with its backfill, is a data migration. It is documented in the plan and is **not** implemented or run. A name search keeps the AE-4 reading.

## Consequences

- With the indexes, a skill search reads only matching agents. 1,200 agents with 400 matches, 50 per page, take 8 requests and about 408 reads, instead of reading all 1,200.
- Applying the indexes is Terraform: a plan and an apply in DEV, by the owner. Until then, everything works as before and the missing index is logged.
- No document, version or audit record changes.
