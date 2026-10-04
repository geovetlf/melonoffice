# ADR-0140: editing what an agent is for (AC-1)

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0062](0062-agent-engine-core.md) (Agent Engine core, versions), [ADR-0084](0084-agents-propose-and-schedule.md) (skill upgrades), [ADR-0116](0116-agent-autonomy-and-sensitive-actions.md) and [ADR-0117](0117-agent-memory-handoffs-notifications.md) (autonomy and work settings, each its own step)
- Roadmap: item 1 of "Next" in `docs/product/FEATURE-SURFACE-MAP.md`, "Agent configuration editing, which needs a web-safe configuration view in the API".
- Terraform: none. Firestore: none. Data migration: none. Prompts: none.

## Context

`PATCH /specialists/:id` (ADR-0062) takes a whole configuration: skills, tools, permissions, policies and the conversation profile, with tools and conversation required to be exactly what is stored. The web only reads the safe view (`toSpecialistView`), which never shows tools, permissions, policies or the conversation profile, so a browser could not use it, and it should not have to send or see those fields. An agent's purpose and description, which a person writes, could only be set from the template.

## Decision

1. **One audited step for the profile.** `POST /v1/organizations/:organizationId/specialists/:id/profile`, with `specialist.manage`, takes `{ fromVersion, purpose?, description? }`. Each is a text, or `null` or an empty text to clear it. Like `setAutonomy` and `setWorkSettings`, the server reads the current configuration, changes only those fields and writes a new version through `reviseSpecialist`: the same checks (up to 500 characters, no control characters), the same `fromVersion` conflict (409 `specialist_concurrency_conflict`), the same refusal of an unchanged configuration, and the same audit event, `specialist.version_created`.
2. **The browser never sends or sees the rest.** Any other field is refused (`invalid_specialist`, with the field). The answer is the same safe view. The capabilities view adds `purpose` and `description`, which the safe view already showed.
3. **The web.** The agent's page shows "What it is for". A person with `specialist.manage` edits both texts and saves only what changed, with the version they read. When someone changed the agent meanwhile, the page says so and asks to reload. Everyone else reads them.
4. **No second system.** It is the same Agent Engine, versions, audit, permission and `packages/ui` components. `PATCH` stays as it is for operator tools and tests.

## What it changes in an agent's work

The purpose already reaches the model inside `<agent_profile>`, which the prompt treats as data (G-7). The prompt text and its version (`agent_task@3`) do not change, so the V3 eval baseline still holds.

## Not in this step

Adding or removing skills and moving an agent to another department. Their tools and permissions must be derived from the skills, as an upgrade does (ADR-0084), never sent by a browser. Renaming is an identity change and needs its own decision.

## Consequences

- Tests: `apps/api/src/agent-profile.test.ts`, in memory and on Firestore. They cover the edit as a new version that keeps the rest of the configuration, clearing, refused fields, an old version, nothing new, a text too long, another organization and a missing permission. The web tests are in `apps/web/src/agents/agents.test.tsx`.
