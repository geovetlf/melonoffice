# ADR-0132: the Agent Guardian, deterministic checks of every agent's answer (G-2)

- Status: Proposed
- Date: 2026-10-03
- Amended: 2026-10-12, complete reads. The Guardian reads the Company Brain page by page, in document-id order, at most `LIMITS.completeReadPages` (ten) pages of `LIMITS.readWindow` (1000) items: the bounds the sweep uses (ADR-0187, decision 9). A Brain of 10,000 items or more is refused as incomplete, and no report is kept; below that, the figures and secrets are checked against all of it. Geovet's answer «Paginar y mostrar» to the card in the project chat, relayed by the coordinator on 2026-10-12. Before this amendment a Brain of 1000 items or more was refused.
- Amended: 2026-10-12, the complete read is hardened (branch `claude/complete-read-hardening`). A complete read returns the whole Brain or nothing, never a part as the whole. Pagination: one equality on the organization, the document id as the order, `startAfter` the last id of the previous full page, `LIMITS.readWindow` (1000) per page, no composite index (ADR-0187). Completeness: refused with `read_incomplete` when the count is 10,000 or more (decided before any page is read); when all `LIMITS.completeReadPages` (ten) pages are full; when a cursor is not a document id or does not move forward; when an item repeats across pages; when the walk has run longer than `LIMITS.completeReadMs` (30 s, checked before each page). A failed page throws its error as it was, so nothing partial comes back, and no state is kept: a retry starts from the first page. Guardian: any read error leaves the figures and secrets unchecked and keeps no report, so the next verification reads again. Read cost: the count is one aggregation billed per 1,000 index entries; a complete read reads at most 10,000 documents; the Guardian makes two complete reads per verification (figures and secrets), so a Brain near 10,000 items costs up to about 20,000 document reads each time. Sharing one read between the two is the next change and is not made here. Metrics: `brain.complete_read` (info) with `pages`, `items`, `elapsedMs` when a read completes; `brain.complete_read_refused` (warn) with `reason` (`items`, `pages`, `time`, `cursor`, `repeated_item`, `read_failed`), `pages`, `items`, `elapsedMs` when one stops. No item id, value or content is logged. Residual risks: the ten pages and the 30 s budget are bounds, not measurements, and DEV's logs decide whether they hold; a complete read is not a snapshot, so an item changed between two pages can be seen before or after the change, and a kept verdict is not checked again while it is kept (the window is the length of one walk). Recovery: revert the merge commit; nothing is migrated, and the logs are additive.
- Amended: 2026-10-12, the notice of an unchecked organization (Geovet's answers «Mostrar aviso» and «Esperar DEV», in the project chat, relayed by the coordinator). When the complete read stops on time or pages, or is refused for 10,000 items or more, the report keeps one informative finding, `organization_unchecked` (recommendation `check_by_hand`), and the task shows it in Spanish and English. It raises no Guardian warning, so nobody is notified for it. The verification leaves the `agent_guardian` check out rather than passing it; a critical finding in the report still fails the check. The next verification reads again, and a checked report replaces the notice. Before this amendment such a report was not kept.
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

The report is kept per execution as the agent output `guardian` (codes, ids, figures as written). A later verification reads it back. The verification gets an `agent_guardian` check, which **fails only on a critical finding**, just as a failed AI review fails it. The Guardian never rewrites the answer and never runs or undoes anything. If Company Brain cannot be read, figures are left unchecked and the task is not failed. Such a report is kept with the `organization_unchecked` notice and nothing else from the figures and secrets: the task shows it, and the verification leaves the `agent_guardian` check out, so it is never shown as passed. A later verification reads again and replaces the notice with a checked report once Company Brain can be read whole.

### 2. The person is told

When the report has a warning or critical finding, the worker publishes `agent_guardian.warning` (`specialistId`, `code`, `severity`) with the task's end. It becomes a `guardian_warning` in-app notice for the task's person. The task trace shows the findings as codes, and the task details show them as sentences in ES and EN.

### 3. A warning before a skill upgrade removes a tool

The capabilities route now lists, for each upgrade, the tools it `removes` and the steps of active workflows this kind of agent performs that need them (`breaks`). `breaks` is filled only when the reader holds `workflow.read`. `upgradeImpact` applies exactly the rules `upgradeSkill` uses. The web shows the warning next to the upgrade and repeats it in the confirmation. It warns and does not refuse: the person decides.

### 4. AI checks stay optional

The deterministic checks above cost nothing. The AI review stays an opt-in setting of each agent (`aiVerification`). No mandatory model call is added.

## Rollback

Revert the merge commit. Older `guardian` outputs are ignored by an older verifier. The new event type and notice kind are additive.
