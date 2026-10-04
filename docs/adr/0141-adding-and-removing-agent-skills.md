# ADR-0141: an agent's skills and department from its page (AC-2)

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0069](0069-skills-grant-tools.md) and [ADR-0083](0083-skill-grants-enforced.md) (a skill is the only way an agent gets a tool), [ADR-0084](0084-agents-propose-and-schedule.md) (skill upgrades), [ADR-0104](0104-follow-up-schedule-v3-model-tool.md) (skills for some departments only), [ADR-0132](0132-agent-guardian.md) (the Guardian's upgrade warning), [ADR-0140](0140-agent-profile-editing.md) (profile editing)
- Roadmap: item 1 of "Next" in `docs/product/FEATURE-SURFACE-MAP.md`.
- Terraform: none. Firestore: none. Data migration: none. Prompts: none.

## Context

An agent's skills came from its template. A person could only move a skill it already had to a newer version (ADR-0084). Giving it another skill, or taking one away, needed the operator `PATCH` with the whole configuration, tools and permissions included, which a browser never sees (ADR-0140).

## Decision

1. **One core, three routes.** All need `specialist.manage`:
   - `POST /specialists/:id/skills/add` `{ fromVersion, skillId, version }`
   - `POST /specialists/:id/skills/remove` `{ fromVersion, skillId }`
   - `POST /specialists/:id/changes` `{ fromVersion, add?: [{ skillId, version }], remove?: [skillId], departmentId? }`, for several skills and a department as one version.

   All three go through one function (`changeAgent`). It writes a new version through `reviseSpecialist`, with the same `fromVersion` conflict (409), catalogue checks and audit event (`specialist.version_created`). A move also records `specialist.department_changed` with the department in `reference`, as the catalogue migration does (ADR-0047). Earlier versions stay as they were.

2. **The browser names skills and a department, nothing else.** Any other key is refused with its name, in the body or in an added skill: `tools`, `permissions`, `policies`, `configuration`, `capabilities`. The server derives the rest:
   - **Added skills** give their tools at one exact version, as an upgrade does.
   - **Removed skills** take away the tools no remaining skill grants.
   - **Permissions** are recomputed as exactly what the resulting skills read and their tools need, so an agent never keeps access that only a removed skill needed.
3. **What is refused:**
   - A skill whose tool comes in several versions, such as the supervised or autonomous reply (`skills.choice`). That choice is a person's and is made elsewhere.
   - An unknown skill, one it already has, one it does not have, or the same skill named twice (`skillId`).
   - Removing its last skill (`skills.last`).
   - A department that is not one of this organization's, does not exist, or is the one it is in (`departmentId`).
   - A department that takes no agents (`department_not_assignable`).
   - A department that does not allow a skill it keeps (`skills.department`).
4. **What a department changes, and how this step treats it.**
   - **Skills.** Some skills are for some departments only (ADR-0104). A move is refused while it keeps one, and the person can remove that skill in the same change.
   - **Company knowledge.** What it reads follows its department's type (`DEPARTMENT_ACCESS`). The page says so before the move.
   - **Workflows.** Steps choose agents by department type and role. The page names the active workflows that use its kind of agent where it is now (`moveImpact`, next to the Guardian's `upgradeImpact` and `removalImpact`). This is a warning, not a refusal.
   - **Visibility and routing.** Offices, listings and agent routing already read `departmentId`, so the agent appears in its new office. The page goes there after the move.
   - **Role, autonomy, work settings and conversation profile** are kept as they are.
5. **What the page offers.** The capabilities view adds four lists:
   - `addable`: the newest version its department allows of each skill it lacks, with no version choice.
   - `removals`: the Guardian's warning for each skill it has.
   - `moves`: each other department that takes agents, with the skills that must go first.
   - `moveLeaves`: the workflows its kind of agent works in.

   The agent's page shows "Add a skill", "Remove" and "Move to another department" to a person with `specialist.manage`. Each asks for confirmation, says the change creates a new version, and says when someone else changed the agent meanwhile.

6. **No second system.** It uses the same Agent Engine, versions, audit, Guardian warnings, permission and `packages/ui` components.

## Evals

The V3 suite builds each eval agent from its template (`packages/evals/src/run.ts`), not through these routes. The prompt text and its version (`agent_task@3`) do not change. Nothing in this step changes what the model receives for the 36 V3 cases, so no new run is needed and V3 stays the baseline. An agent a person changes works with the skills it was given, under the same prompt and rules.

## Consequences

- Tests:
  - `apps/api/src/agent-skills.test.ts` and `apps/api/src/agent-changes.test.ts`, in memory and on Firestore. They cover adding, removing, several skills at once, a move with its audit, the earlier version kept, a move blocked by a skill, unknown skills, invalid departments, tools and permissions sent from the browser, a 409, another organization and a missing permission.
  - `removalImpact` and `moveImpact` in `packages/agents/src/audit.test.ts`.
  - The web tests in `apps/web/src/agents/agents.test.tsx`.
