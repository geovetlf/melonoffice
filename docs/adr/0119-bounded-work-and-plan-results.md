# ADR-0119: Bounded agent work, expiring handoffs and a plan's result told to its person (AE-6)

- Status: Proposed
- Date: 2026-10-02
- Builds on: [ADR-0063](0063-agent-tasks.md), [ADR-0070](0070-approved-plans-run.md), [ADR-0101](0101-harness-multi-step-limits-and-handoff.md), [ADR-0115](0115-agent-lifecycle-readiness-pagination.md), [ADR-0117](0117-agent-memory-handoffs-notifications.md)

## Context

After AE-5 the Agent Engine has memory, handoffs, GIA as orchestrator and in-app notices. A review of what was still open found four gaps:

- **No bound on open work.** A person, GIA's team flow or an accepted handoff could start any number of tasks for one agent or one organization at once.
- **Handoffs never expired.** A handoff nobody decided stayed "proposed" forever and could be accepted months later, on a stale request.
- **GIA's loop did not close.** When a plan of several agents ended, nobody was told. The person only learned the result by going back to the chat and asking GIA for the summary. If they had left the page, the plan was lost from view.
- **The trace had times but no durations.** "How long did this take?" needed arithmetic.

## Decision

1. **Open work is bounded** (`AGENT_WORK_LIMITS`, `packages/agents/src/tasks.ts`).
   - A new task is refused with `agent_busy` (HTTP 429) while its agent has 10 executions that have not ended.
   - It is refused with `organization_busy` (429) while its organization has 200.
   - Only new work is checked. Repeating a request for a task that already exists is never refused.
   - The check sits in the one place tasks are made (`AgentTaskService.assign`), so a person's request, GIA's team flow through the Harness and an accepted handoff are all bounded the same way.
   - The agent count reuses `openOfSpecialist` (AE-4). The organization count is a new `countOpenOfOrganization`: one Firestore `count()` per open status, equality filters only, stopped at the limit. No composite index and no documents are read.
   - These are our safety defaults, not a plan's limits. Plan limits still wait for D-12.
   - The check is not transactional, so two requests at the same moment may both pass. That is acceptable for a safety bound.
2. **Handoffs expire** (`HANDOFF_LIMITS.expiryDays = 7`).
   - A proposed handoff older than 7 days reads as `refused` with refusal `expired`, without a write.
   - Accepting or declining it is refused with `handoff_expired`. That first attempt records it as refused, audited as `agent_handoff.refused` with reason `expired`. Nothing is started.
   - Nothing sweeps old handoffs, and no stored data changes until a person acts.
3. **A plan's end is told to its person.**
   - The worker's plan conductor hook publishes `plan.finished`, a new catalogue event with subject `plan`, source `plans`, `outcome` and an optional `code`.
   - It is published only by the step end that moved the plan from `executing` to `completed` or `failed`. Its idempotency key is `{planId}:finished`, so a repeat stores nothing new.
   - The `agent_notifications` subscriber reads the stored plan in the event's organization and gives `plan.createdBy` one notice: `result_available` or `plan_failed`.
   - Such a notice names the plan (`planId`) and no agent (`specialistId: null`).
   - The bell opens GIA's page at `/gia?plan=…`. There the person asks GIA for the summary (ADR-0117): one call, on request, with the same permissions. Opening the page runs nothing.
4. **Durations.** The trace gives `durationMs` for each step (start to end) and for the task (creation to end). It is null until a step or task has ended.

## Not done

- **A "task started" notice.** The person who asks for a task, or approves a plan, started it themselves, so a notice would only repeat their own action. Task finished, approval required, blocked, failed, stopped, handoff and now result available are notified.
- **Plan limits by subscription.** These wait for D-12.
- **A sweeper for expired handoffs.** None is needed, because an expired handoff is read as refused.

## Consequences

- No migration and no Terraform: the new queries use single-field indexes only.
- Notices written before this change have no `planId`, and they read as `planId: null`.
- An organization that reaches 200 open executions gets 429 until some end. The limits are options of the task service if they need to change.
