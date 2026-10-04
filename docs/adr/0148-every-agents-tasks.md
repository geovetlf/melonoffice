# ADR-0148: every agent's tasks, read only

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0063](0063-agent-tasks.md) (agent tasks), [ADR-0115](0115-agent-lifecycle-readiness-pagination.md) (agents a page at a time), [ADR-0147](0147-audit-trail-viewer.md) (the same read-only pattern)
- Terraform: none. Firestore: no new index, no migration. Prompts: none.

## Context

A person read an agent's tasks only on that agent's page. The feature map recorded "no organization-wide task list yet": to see what the company's agents were asked, a person opened each agent in turn.

A task is a record (`agentTasks`) and its state is its execution's (ADR-0063). The store has one composite index, `organizationId, specialistId, createdAt desc`. A list of the whole organization by date would need a second index, which means Terraform and an apply in each environment.

## Decision

1. **The same service, one more read.** `AgentTaskService.listAll(tenant, query)` returns the organization's tasks newest first, a page at a time.
   - It uses the same permission (`specialist.read`) and the same page sizes (20 by default, at most 50) as an agent's own list.
   - It needs no new task system and no second record of executions.
2. **No new index.** It reads each agent's own list through the existing index, after the cursor and up to the page size, and merges them.
   - The newest `limit` tasks of the organization are always among each agent's newest `limit`, so nothing is skipped or repeated.
   - It reads ten agents' lists at a time.
   - Every agent counts, in any status, so an archived agent's tasks stay in the history.
3. **Filters, all checked on the server.**
   - **Agent:** only that agent's list is read. Another organization's agent narrows to nothing.
   - **State:** the execution's real state. The API lists the states (`pending` … `retrying`); any other value is refused.
     - A state is read from each task's execution, so a page narrowed by state is filled from at most five merged reads.
     - Such a page may hold fewer tasks and still have a next cursor. The screen then says "none among the latest tasks read" and offers older ones.
   - **Days:** read in the business's time zone, at most a year, using the same `dayRange` as the audit history.
   - **Not added:** a filter by task type, since agent tasks have one type, and a filter by who asked. Neither needs new infrastructure, but neither was asked for.
4. **Cursor.** It is the same cursor as an agent's list, scoped to `all` instead of one agent. A cursor of one agent's list, or of another organization, is refused.
5. **Fields the server decides.** `GET /v1/organizations/:organizationId/agent-tasks` returns only these fields:
   - id, the agent (id, name, status), and what was asked;
   - the execution's state and failure code;
   - created, last change, started and finished;
   - progress (steps done or skipped, out of all) and each step's type, state, times and failure code;
   - the plan when the execution is a plan step, and the task it was handed from;
   - a summary of the verified answer (at most 280 characters) with the number of missing items.

   It never returns the model, its cost or credits, request ids, who asked, the agent version, contacts, approvals or handoff details. The answer is shown only once it passed its checks, the same rule as the agent's page.

6. **Read only.** The route is GET only. The page has no stop, retry, pause, reassign, approve or edit action. Those stay on the agent's own page, where they already are.
7. **No AI.** Reading the list or a task's details calls no model and spends no credits.
8. **Screen.** "Every agent's tasks" at `/agents/tasks`, linked from the Agents page.
   - Filters by agent, state and days.
   - Each task shows its state, agent, date, progress and answer summary.
   - Details show the dates, steps, plan link, handover and missing data.
   - It has error, empty and loading states, and EN/ES.

## Evals

No prompt, model context, routing, model or Agent Engine behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

- One page costs one indexed read per agent, plus one execution read per task shown. That is fine for tens of agents. An organization with hundreds would justify the composite index `organizationId, createdAt desc`. The merge would then give way to it, with no change on the screen.
- Plan steps are executions, not task records, so they are not in this list. They stay in Automations, on each plan. The `plan` field is there for when a task is a plan step.
- Tests:
  - `packages/agents/src/agents.test.ts`:
    - twelve agents, one with more tasks than a page, paged to the end in order with no repeats;
    - the agent, state and day filters;
    - another organization; a foreign cursor; invalid states and days; no `specialist.read`.
  - `apps/api/src/agent-tasks.test.ts`:
    - an empty list, one task, many in order, and the cursor;
    - the filters and refusals;
    - another organization and no permission;
    - the allow-listed fields and summary;
    - no write methods.
  - `apps/web/src/agents/organizationTasks.test.tsx`:
    - order, states, one task and an empty list, detail, paging and filters;
    - read only, unknown fields never shown, and the link;
    - a role without the permission, and API errors.

## Open

- Plan steps in the same list, and acting on tasks from it, if the roadmap asks for them.
