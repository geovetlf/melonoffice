# ADR-0069: Skills are the only source of an agent's tools and actions (SK-1)

- Status: Accepted by Geovet on 2026-09-29, on the decision card "¿Hacer que las Skills sean la única fuente…?"
- Date: 2026-09-29
- Builds on:
  - D-28/D-29 (Department → Specialist → Role → Skills → Tools);
  - ADR-0062 (skills, templates);
  - ADR-0043 (conversation agent);
  - ADR-0065 (action catalogue).
- Amends: ADR-0062 §1 ("a skill grants nothing").
- Terraform: none.

## Context

The Skills audit (`melonoffice-plan/MelonOffice-Skills-Audit.md`) found three problems:

- Skills added only read permissions and a name to the prompt.
- An agent's tools were a separate hand-written list, and the only agent that used tools (the conversation agent) had no skills.
- A skill named its tools by id, without versions, so it could not express that `message_send` is version 2 for a supervised agent and version 3 for an autonomous one.

## Decision

1. **A skill grants versioned tools and actions.**
   - `SkillDefinition` gains `tools: {id, versions}[]` in place of `toolIds`, and `actions`, which are Decision Engine `ACTION_CATALOGUE` ids.
   - `conversation_reply@1` grants `message_send` at versions 2 and 3, and `conversation_handoff` at version 1.
   - Every other skill grants no tools and no actions.
2. **An agent's tools come only from its skills.** Creating or revising an agent refuses:
   - a tool that none of its skills grants at that exact version (`tools.not_granted`);
   - a skill whose granted tool is not assigned at one of its versions (`skills.tools`).

   The capabilities report adds `tool_not_granted_by_skill`. Revising still never changes what reaches outside (ADR-0062).

3. **The seeded conversation agent carries `conversation_reply@1`**, and its permissions include that skill's read permission.
4. **A consistency test in the API checks the catalogues against each other:**
   - every granted tool version exists and is the runtime's to call, so a person's own versions (`message_send@1`, `follow_up_schedule@1`) can never be granted;
   - every granted action exists and lets agents propose;
   - every template's skills resolve and grant no tool;
   - each published skill version is pinned by digest, so a change needs a new version.
5. **Nothing new is granted.** Deciding which skill grants a new tool or action (for example follow-ups or discounts to agents) is Geovet's call, and each one gets its own ADR.

## Consequences

- The Tool Gate is unchanged. It still checks the agent's version's tools on every call. Skills now decide what may be put on that list.
- Agents already stored in DEV keep working, because runtime checks are unchanged. The capabilities report of the conversation agent seeded before SK-1 (which has no skills) shows `tool_not_granted_by_skill` until it is seeded again or revised with the skill.
- Next (SK-2): the Decision Engine checks an agent's granted actions when the proposer is an agent. The agent-task prompt uses each skill's description.
