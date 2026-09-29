# ADR-0083: Skill grants are enforced where tools run and actions are decided (SK-2)

- Status: Proposed (Geovet's brief of 2026-09-29 20:46Z, "Skill → Tool/Action authorization matrix")
- Date: 2026-09-29
- Builds on: [ADR-0026](0026-tools-approvals-and-guardrails.md) (tool gate), [ADR-0065](0065-decision-engine.md) (Decision Engine), [ADR-0069](0069-skills-grant-tools.md) (SK-1).
- Terraform: none.

## Context

SK-1 made skills the only source of an agent's tools, but only when an agent is created or revised. At run time:

- The tool gate checked that the agent's version listed the tool. It did not check that one of that version's skills granted it. An agent stored before SK-1, or written by any path that skipped the management checks, could use a tool no skill granted.
- The Decision Engine let "an agent" propose any action whose catalogue entry lists `agent` as a proposer. It did not look at skills at all. ADR-0069 named this as the next step (SK-2).

The audit (`docs/product/SKILL-TOOL-MATRIX.md`) found nothing else missing in the path Agent → Skill → Tool/Action → Permission → Decision Engine → Execution.

## Decision

1. **The tool gate refuses a tool that no skill grants.** After the rule "the version lists this tool version", the gate reads the version's own skills at their exact versions (`grantsOf`, the same function management uses). If none grants the tool at that version, the call is denied with `tool_not_granted_by_skill` and audited like every denial. The gate takes the skill catalogue as an option; it defaults to the catalogue in code.
2. **The Decision Engine gives an agent only the actions its skills grant.** When the proposer is an agent:
   - for a named agent, the caller passes the actions that agent's skills grant (`AgentActionGrants`, from `grantsOf`), never from a request or a model;
   - for agents in general (a plan condition, a policy check), the action must be granted by at least one skill of the catalogue.

   Otherwise the action is `unavailable` with `not_granted_by_skill`. GIA's proposals are unchanged.

3. **Nothing new is granted.** No skill gains a tool or an action. Every new grant is Geovet's decision (ADR-0069 §5). The proposals are in the matrix.
4. **The DEV seed of the conversation agent repairs an agent seeded before SK-1.** When the existing agent lacks `conversation_reply@1`, `seed-test-agent` stores a new version with that skill added. Its tools, level and everything else stay the same.
5. **The agent's page shows each skill at its version with what it grants.** That means the tools it uses (with risk and whether each use needs approval), the actions it may propose for a person to confirm, and the records it reads.

## Consequences

- A tool reaches an agent only through a skill, at both the moment it is assigned and the moment it runs.
- No skill grants an action today. So `action.policy_check` for `proposer: 'agent'` now answers `not_allowed` (reason `not_granted_by_skill`) for every action, and a plan condition built on it stops its branch. That is the true answer until a skill grants the action.
- **DEV:** if the test conversation agent was seeded before SK-1 (2026-09-29), its replies are refused until `seed-test-agent` is run again for its organization and level. The run adds the skill as a new version.
- Action grants are by action id. The actions catalogue has one version per action today; versioned action grants come with the first action that gets a second version.
