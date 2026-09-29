# ADR-0084: Agents propose follow-ups and facts, and schedule a follow-up only after approval

- Status: Proposed (Geovet's decision of 2026-09-29 21:10Z, option B "Proponer y agendar")
- Date: 2026-09-29
- Builds on: [ADR-0063](0063-agent-tasks.md) (agent tasks), [ADR-0065](0065-decision-engine.md) (Decision Engine), [ADR-0069](0069-skills-grant-tools.md) (SK-1), [ADR-0083](0083-skill-grants-enforced.md) (SK-2), [ADR-0052](0052-gia-chat.md) (facts proposed by GIA), TL-1 (`follow_up_schedule`).
- Terraform: none.

## Context

SK-2 left three proposals for Geovet (see `docs/product/SKILL-TOOL-MATRIX.md`). He chose all three:

> "El agente comercial propone seguimientos y los agentes proponen datos para la memoria, que la persona confirma. Además, el agente comercial puede agendar seguimientos él mismo, pidiendo tu aprobación cada vez."

Offering a discount stays unassigned.

## Decision

1. **New skill versions, nothing changed in the old ones.**
   - `customer_follow_up@2` keeps the reads of v1. It grants the action `follow_up.schedule` and the tool `follow_up_schedule` v2.
   - `company_knowledge@2` keeps the reads of v1 and grants the action `knowledge.propose_fact`.
   - The digests of every v1 skill are unchanged, so agents stored with v1 keep exactly what they had.
2. **`follow_up_schedule` v2 is the agent's version of the tool.** It can be invoked only by the runtime, never by a person. It needs a person's approval every time (`approval_required`), with risk LOW. The approval lasts 2 days. Its input is closed: request key, contact, type, title, date, time and `source: 'agent'`. Version 1 stays the person's own tool.
3. **The Decision Engine lists `agent` as a proposer of `follow_up.schedule` and `knowledge.propose_fact`.** Under ADR-0083 an agent still gets them only when one of its skills grants them. The engine is asked for the person the task is for (`offers(tenant, action, 'agent', grants)`), so RBAC of that person applies too.
4. **What a task may carry.**
   - When the actions are offered, the task's answer schema adds a nullable `followUp` and up to 3 `facts`. Anything not offered is not in the schema.
   - The model never sees contact ids. It chooses from up to 30 contacts (the most recently changed, read as the person the task is for), each named by a letter-only reference derived from the id. The server resolves the reference; an unknown or ambiguous reference is no proposal.
   - Facts below confidence 0.6 are dropped (the same floor as GIA's).
5. **Scheduling goes through the tool gate, never around it.**
   - When the assigned agent's version has `follow_up_schedule@2`, the task's execution gets a second node, `schedule`, which depends on the answer. It is skipped when there is no valid proposal, or when the follow-up service would refuse it (date passed, contact gone, too many open follow-ups).
   - Otherwise the gate creates an approval bound to that exact input, and the execution waits. When a person approves, the API resumes the execution and the worker's executor creates the follow-up as the runtime actor, with `source: 'agent'` and `metadata.automation: 'suggested'`. The follow-up id comes from the task id, so a retry schedules nothing twice.
   - The follow-up service accepts `source: 'agent'` only from the runtime, and refuses it from a person.
   - A rejected or expired approval ends the execution as failed (`approval_rejected` / `approval_expired`). Nothing is scheduled.
6. **Facts are proposed when the task ends.** An execution end hook in the worker sends the facts to Company Brain as `proposed`, with the source `{type: 'agent', id: executionId}`. The owner confirms them in Company memory, as with GIA's.
7. **The answer stays readable while the follow-up waits, and after a rejection.** The task's answer is shown once its answer node completed and the execution is completed, waiting for approval, running, or failed only because of the approval. It carries the number of facts and the follow-up with its state: preparing, waiting for approval, scheduled, rejected, expired or not scheduled.
8. **Moving an agent to a newer skill version is a person's decision.** New templates use the v2 skills. An existing agent keeps v1 until someone with `specialist.manage` presses "Update to version 2" on the agent's page. That stores a new version of the agent (`POST …/specialists/:id/skills/upgrade`) that has the skill at the newer version plus the single-version tools it grants. It passes the same checks as any revision, and is audited as `specialist.version_created`.

## Consequences

- The commercial agent can put a follow-up on a person's calendar, but only after that person approves that exact follow-up. It never schedules by itself, and never for a contact the person cannot read.
- **Web:** the task shows the proposed follow-up with its contact, date and state. A person with `approval.approve` approves or rejects it there (rejecting asks first); others get a link to Approvals. Facts link to Company memory. Follow-ups show "Agent" as their source.
- **DEV:** after the merge, existing agents keep their v1 skills. To try it, open the commercial agent's page and press "Update to version 2" on each skill, then ask it a task about a contact.
- Known limit: an expired approval moves the execution to failed only when something resumes it. Until then, the task shows "The approval expired" but the execution stays waiting for approval. There is no sweeper yet (as with the delegation case accepted in X5).
- `opportunity.offer_discount` stays without a skill.
