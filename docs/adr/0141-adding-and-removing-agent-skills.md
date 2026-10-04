# ADR-0141: adding and removing an agent's skills (AC-2)

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0069](0069-skills-grant-tools.md) and [ADR-0083](0083-skill-grants-enforced.md) (a skill is the only way an agent gets a tool), [ADR-0084](0084-agents-propose-and-schedule.md) (skill upgrades), [ADR-0104](0104-follow-up-schedule-v3-model-tool.md) (skills for some departments only), [ADR-0132](0132-agent-guardian.md) (the Guardian's upgrade warning), [ADR-0140](0140-agent-profile-editing.md) (profile editing)
- Roadmap: item 1 of "Next" in `docs/product/FEATURE-SURFACE-MAP.md`.
- Terraform: none. Firestore: none. Data migration: none. Prompts: none.

## Context

An agent's skills came from its template. A person could only move a skill it already had to a newer version (ADR-0084). Giving it another skill, or taking one away, needed the operator `PATCH` with the whole configuration, tools and permissions included, which a browser never sees (ADR-0140).

## Decision

1. **Two audited steps, like an upgrade.** With `specialist.manage`:
   - `POST /specialists/:id/skills/add` `{ fromVersion, skillId, version }`
   - `POST /specialists/:id/skills/remove` `{ fromVersion, skillId }`

   Each writes a new version through `reviseSpecialist`, with the same conflict, catalogue checks and audit event (`specialist.version_created`).

2. **The server derives the tools and permissions.**
   - **Adding** assigns the tools the skill grants at one exact version and lists the permissions they and the skill need, as an upgrade does.
   - **Removing** keeps only the tools another of the agent's skills grants, and only the permissions its skills and tools still need. An agent never keeps access a removed skill alone needed.
3. **What is refused:**
   - A skill whose tool comes in several versions, such as the supervised or autonomous reply (`skills.choice`). That choice is a person's and is set elsewhere.
   - A skill its department does not allow (`skills.department`).
   - A skill it already has, or an unknown one (`skillId`).
   - Removing its last skill (`skills.last`).
4. **What the page offers.** The capabilities view adds:
   - `addable`: the newest version its department allows of each skill it lacks, without a version choice.
   - `removals`: for each skill, what removing it takes away. This is the Guardian's warning from upgrades (`removalImpact`, next to `upgradeImpact`), naming the active workflows that would lose a tool.

   The agent's page shows "Add a skill" and "Remove" to a person with `specialist.manage`. Both ask for confirmation, and a removal's warning comes first.

5. **No second system.** It reuses the same Agent Engine, versions, audit, Guardian warning and permission, and the same `packages/ui` components.

## What it changes in an agent's work

What an agent may do follows its skills, as it always has. The prompt text and its version do not change, so the V3 eval baseline still holds. A new skill's tools keep their own risk and approval policy, and sensitive actions still wait for a person.

## Not in this step

Moving an agent to another department. That changes which company knowledge it reads, so it needs its own step and warning (AC-3).

## Consequences

- Tests:
  - `apps/api/src/agent-skills.test.ts`, in memory and on Firestore: what is offered, adding, removing with what only that skill needed, the refusals, another organization and a missing permission.
  - `removalImpact` in `packages/agents/src/audit.test.ts`.
  - The web tests in `apps/web/src/agents/agents.test.tsx`.
