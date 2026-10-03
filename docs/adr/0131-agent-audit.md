# ADR-0131: the team review, a read-only audit of agents, workflows and plans (G-1)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0115](0115-agent-lifecycle-readiness-pagination.md) (readiness, AE-4), [ADR-0084](0084-agents-propose-and-schedule.md) (skill upgrades), [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (model policies), [ADR-0103](0103-harness-tool-use-mid-task.md) (tools mid-task), [ADR-0051](0051-company-brain.md) (Company Brain), [ADR-0028](0028-planner-delegation-and-workflows.md) and [ADR-0070](0070-approved-plans-run.md) (workflows and plan delegation)
- Decision: Geovet, 2026-10-03 18:52Z, "Autorización: continuar auditoría MelonOffice", block G-1 Agent Audit, first of G-1..G-5.
- Terraform: none. Firestore: no new collection, field or index. Nothing is migrated. No model is called and no credit is used.

## Context

Problems that make an agent's work fail were only found when the work ran: an agent still on the model policy from before the Harness, conversation instructions that give a price Company Brain records differently, a workflow whose step no active agent can take, an agent version that no longer has a tool a workflow step needs, and a plan pinned to an agent version that changed. Each piece of the check already existed (`agentReadiness`, the policy migration map, the skill catalogue, workflow binding by department type and main role, plan delegation by exact version), but nothing put them together, and nothing compared instructions with Company Brain.

## Decision

### 1. `auditAgents`, in `@melonoffice/agents`

A pure function over what the API already reads. It extends `agentReadiness`; it does not add a permission system, an agent engine or a brain. Findings have a `code`, a `severity` (`info`, `warning`, `critical`), a `subject` (agent, workflow or plan, with id, version and name), `evidence` (codes, ids, versions and figures only) and a `recommendation` code. Archived agents are not reviewed.

| Code                                    | Severity                                        | Recommendation                                    |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `agent_not_ready`                       | critical if the agent is active, else info      | `fix_agent_configuration` / `activate_department` |
| `model_policy_outdated`                 | warning                                         | `run_agent_policy_migration`                      |
| `skill_upgrade_available`               | info                                            | `upgrade_skill`                                   |
| `model_tools_unreachable`               | warning                                         | `upgrade_skill`                                   |
| `instructions_contradict_company_brain` | critical if the fact is confirmed, else warning | `review_instructions`                             |
| `workflow_assignee_unavailable`         | critical                                        | `activate_or_assign_agent`                        |
| `workflow_tool_missing`                 | critical                                        | `review_workflow`                                 |
| `plan_agent_not_active`                 | critical if the plan is approved, else warning  | `replan`                                          |
| `plan_agent_version_changed`            | critical if the plan is approved, else warning  | `replan`                                          |

Only active workflows are reviewed, and only plans not yet handed to their agents (`ready`, `approval_required`, `approved`, no delegations).

### 2. Deterministic contradictions with Company Brain

`figureContradictions` (`@melonoffice/brain`) compares a text with Company Brain's money and number facts, without a model. Money is read only next to a currency mark; numbers only with the fact's unit; the fact's label (3 characters or more) must appear as a whole phrase in the same sentence. Anything it cannot read with certainty is left alone. An AI check, if ever added, will be optional per agent (G-2), never required for this one.

### 3. `GET /v1/organizations/:org/agents/audit`

`specialist.read`. Read-only, tenant-scoped. Company Brain is compared only if the reader holds `knowledge.read`, workflows only with `workflow.read`, plans only with `plan.read`; what was not reviewed is listed in `skipped`. At most 200 workflows and 200 plans are read per review.

### 4. "Team review" on the agents page

It runs when the person asks, and shows each finding with its severity, subject, what was found and what to do, in ES and EN.

## What it does not do

- It changes nothing. The policy migration (`migrate-agent-policies`, ops-dev workflow) stays a separate step an administrator runs.
- A warning when a new agent version removes a tool a workflow needs, before it is saved, belongs to G-2 (Agent Guardian).

## Rollback

Revert the merge commit. Nothing is stored, so nothing needs cleaning.
