# ADR-0143: restoring an earlier version of an agent (AC-4)

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0062](0062-agent-engine-core.md) (immutable versions), [ADR-0141](0141-adding-and-removing-agent-skills.md) (the server derives tools and permissions), [ADR-0142](0142-agent-version-history.md) (version history)
- Terraform: none. Firestore: one optional field on new version documents, so no index and no migration. Prompts: none.

## Context

The version history (ADR-0142) shows what each version of an agent changed. Going back to an earlier configuration meant redoing each change by hand.

## Decision

1. **A restore is a new version.** `POST /specialists/:id/restore` `{ fromVersion, version }` needs `specialist.manage`. It writes a new version through `reviseSpecialist`, with the same `fromVersion` conflict (409) and the same refusal of a change that changes nothing. Nothing is deleted or rewritten, and every earlier version stays.
2. **What comes back.**
   - From the chosen version: its department, purpose, description and skills, and the tools those skills grant at the versions it had.
   - Permissions: only those its skills and tools need.
   - Checks: everything is checked again against today's catalogues and departments, so a skill the department no longer allows, or a department that takes no agents, refuses the restore.
3. **What stays as it is now.** How far it acts on its own (ADR-0116), its work settings (ADR-0117) and its conversation profile each change only through their own audited step, so a restore never changes them.
4. **What it records.**
   - The new version carries `restoredFrom`. It is an optional field: absent on every other version and on every document written before.
   - The history shows "Restored from version N" with what changed.
   - The audit log records `specialist.version_created` with `reference: restored_from:N`, and `specialist.department_changed` when the department comes back too.
   - No new action and no new ledger.
5. **The page.** Each earlier entry in "Version history" offers "Restore version N" to a person with `specialist.manage`, after a confirmation that says what comes back and what stays. A conflict is shown instead of overwriting.

## Evals

A restore sets an agent to a configuration it already had, checked by the same rules as any version. It changes no prompt, no context the model receives for a given configuration, and no part of the Agent Engine, routing, tools or policies. The V3 suite builds its agents from the templates, so no run is needed and V3 stays the baseline.

## Consequences

- Tests:
  - `apps/api/src/agent-restore.test.ts`, in memory and on Firestore: a restore that brings back department, purpose and skills; every version kept; the history and the audit; autonomy and work kept; the refusals; another organization; no permission.
  - The web tests in `apps/web/src/agents/agents.test.tsx`.
