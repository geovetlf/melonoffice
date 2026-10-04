# ADR-0142: an agent's version history (AC-3)

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0062](0062-agent-engine-core.md) (immutable versions), [ADR-0140](0140-agent-profile-editing.md) and [ADR-0141](0141-adding-and-removing-agent-skills.md) (edits as versions)
- Terraform: none. Firestore: none (no index, no new collection). Data migration: none. Prompts: none.

## Context

Every change to an agent writes an immutable `SpecialistVersion` with its whole configuration, the time and the person (`createdBy`). The audit log records `specialist.version_created` for it, and `specialist.department_changed` for a move. Nothing showed a person what changed, when or by whom.

## Decision

1. **The versions are the source.** No new ledger and no new event. A version holds the whole configuration it had, so comparing it with the one before tells exactly what it changed. That is always consistent with the audit log, which records one `version_created` per version and one `department_changed` per move (tested).
2. **What is told (`agentChanges`, `@melonoffice/specialists`).** Changes are listed in a fixed order, each with its state before and after:
   - `department`
   - `purpose`
   - `description`
   - `skills` (added, removed, and updated with from and to versions)
   - `autonomy`
   - `work` settings

   Version 1 is `created`. Tools, permissions, policies and the conversation profile are never described. A version that changed only those reads as `other`.

3. **The read.** `GET /specialists/:id/versions?before=&limit=` needs `specialist.read`.
   - Entries come newest first, at most 20 per page. `nextBefore` continues to older versions.
   - Each entry has its version, the previous version, the time, who made it (`you` or `another_person`) and its changes.
   - The server reads each version by number, plus the one before the oldest so that version's change can still be told. No index is needed.
   - An agent of another organization answers `specialist_not_found`.
   - No person's id is returned. Only the owner administers today (D-22), so a person is "you" or "another person". Names come with the role catalogue (D-27).
4. **The page.** The agent's page has a "Version history" section. Each entry shows:
   - `vN → vN+1`
   - who made it
   - the date and time
   - the kind of change
   - a short summary, such as `+ skill`, `− skill`, `Sales → Marketing`, `Propose → Controlled` or "Purpose updated"

   Its detail shows the state before and after. The section is read only: no rollback, no edit and no deletion from it.

## Evals

The history only reads stored versions. It does not change prompts, the context sent to the model, the Agent Engine, routing, tools or policies. The V3 suite's 36 cases therefore get exactly what they got before, so no run is needed and V3 stays the baseline.

## Consequences

- Tests:
  - `packages/specialists/src/history.test.ts` covers `agentChanges`.
  - `apps/api/src/agent-history.test.ts` runs in memory and on Firestore. It covers a new agent, several versions, each kind of change, several changes in one version, order, paging, another organization, no permission, nothing sensitive shown, and consistency with the audit log.
  - The web tests are in `apps/web/src/agents/agents.test.tsx`.
