# ADR-0132: the Agent Guardian, deterministic checks of every agent's answer (G-2)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0131](0131-agent-audit.md) (team review, figure checks), [ADR-0117](0117-agent-memory-handoffs-notifications.md) (optional AI review, notifications, trace), [ADR-0029](0029-runtime-guards.md) (task verification), [ADR-0066](0066-event-system.md) (events), [ADR-0084](0084-agents-propose-and-schedule.md) (skill upgrades)
- Decision: Geovet, 2026-10-03 18:52Z, "Autorización: continuar auditoría MelonOffice", block G-2 Agent Guardian, right after G-1. Its rule: WARNING → EVIDENCE → SEVERITY → RECOMMENDATION, and nothing critical is changed automatically.
- Terraform: none. Firestore: no new collection, field or index. Nothing is migrated. No model is called and no credit is used.

## Context

The task verifier checked only an answer's shape. The AI review (ADR-0117) is optional per agent and costs credits. Nothing cheap and always on caught an answer that quotes a price Company Brain records differently, says something "was sent" when nothing sent it, or rests on a tool that failed. A skill upgrade could also remove a tool a workflow needs, and nobody was told before confirming.

## Decision

### 1. `guardAnswer`, run by the task verifier for every agent

The Guardian is part of `createAgentTaskVerifier`, not a second verifier. Once the answer has the task's shape, it checks:

| Code                                                                                                                                     | Severity                                        | Recommendation          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------- |
| `figure_contradiction` (G-1's `figureContradictions` against the facts the agent's department may read, never above `confidential`)      | critical if the fact is confirmed, else warning | `check_figure`          |
| `unsupported_completion` (ES/EN past-tense claims such as "ya envié", "I have scheduled", with no completed step that changes something) | warning                                         | `confirm_before_acting` |
| `tool_failed` (a tool step of the task failed)                                                                                           | warning                                         | `review_tool_error`     |
| `missing_information` (the agent listed what it still needs)                                                                             | info                                            | `provide_missing_data`  |

The report is kept once per execution as the agent output `guardian` (codes, ids, figures as written). A later verification reads it back. The verification gets an `agent_guardian` check, which **fails only on a critical finding**, just as a failed AI review fails it. The Guardian never rewrites the answer and never runs or undoes anything. If Company Brain cannot be read, figures are left unchecked and the task is not failed.

### 2. The person is told

When the report has a warning or critical finding, the worker publishes `agent_guardian.warning` (`specialistId`, `code`, `severity`) with the task's end. It becomes a `guardian_warning` in-app notice for the task's person. The task trace shows the findings as codes, and the task details show them as sentences in ES and EN.

### 3. A warning before a skill upgrade removes a tool

The capabilities route now lists, for each upgrade, the tools it `removes` and the steps of active workflows this kind of agent performs that need them (`breaks`). `breaks` is filled only when the reader holds `workflow.read`. `upgradeImpact` applies exactly the rules `upgradeSkill` uses. The web shows the warning next to the upgrade and repeats it in the confirmation. It warns and does not refuse: the person decides.

### 4. AI checks stay optional

The deterministic checks above cost nothing. The AI review stays an opt-in setting of each agent (`aiVerification`). No mandatory model call is added.

## Rollback

Revert the merge commit. Older `guardian` outputs are ignored by an older verifier. The new event type and notice kind are additive.
