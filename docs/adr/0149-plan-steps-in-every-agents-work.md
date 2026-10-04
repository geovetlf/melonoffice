# ADR-0149: plan steps in the list of every agent's work

- Status: Proposed. Its window of the newest 100 plans and the step order are changed by [ADR-0150](0150-every-plan-in-every-agents-work.md).
- Date: 2026-10-04
- Builds on:
  - [ADR-0148](0148-every-agents-tasks.md): every agent's tasks
  - [ADR-0145](0145-following-advanced-workflow-steps-in-plans.md): step states
  - [ADR-0146](0146-step-approvals-inside-running-plans.md): step approvals
- Product decision: Geovet, 2026-10-04 06:57Z, "Añadir los pasos de planes a la lista". Steps are joined only when they are read; an agent task is not a plan step execution.
- Terraform: none. Firestore: no new index, no migration. Prompts: none.

## Context

`/agents/tasks` listed only tasks that people asked agents for. Agents also run plan steps. A plan step is the plan's child execution, not a task record, so a step showed only on its plan.

## Decision

1. **Two sources, read where they live.**
   - Tasks come from the task service (`specialist.read`), as in ADR-0148.
   - Plan steps come from the plan service, read with `plan.read`, the plan routes' own permission. Each step is read through `readPlanSteps`, the same function the plan's steps page uses. That function is extracted from that page's route, so a step's state, branch, approval and answer are the plan engine's own, read once and in one way.
   - Nothing is copied into tasks and nothing new is stored.
2. **One order, one cursor.**
   - A task's place is its creation. A step's place is when its plan was approved, which is when its execution was created. Both use the execution id after the time.
   - The two are merged newest first. The cursor is ADR-0148's position cursor, so existing cursors keep working.
   - When a source has more items left (a page full, or reads used up while filtering), the page stops at the last item that source read. No item of either source is ever skipped between pages.
3. **Filters.**
   - Agent, state and days apply to both sources. A step's state is its execution's real state; the plan engine's state for the step is shown beside it.
   - Origin (all, agent tasks, plan steps) is new and needs no index.
   - All filters are checked on the server.
4. **Permissions.**
   - Without `plan.read`, the list shows tasks only and says so (`sources.plan_step: not_permitted`). Asking for plan steps alone is refused (403).
   - The tenant is checked by each service, so another organization's plans are never read.
5. **One source failing.** If plan steps cannot be read, tasks still show and the list says plan steps are missing (`unavailable`). The failure is logged with its code only.
6. **Fields.** A step shows:
   - its agent, its label, its origin `plan_step`, and its execution's state and safe failure code;
   - its dates, progress and nodes;
   - its plan (id, status, and the step's state there);
   - the steps it depends on, with their states;
   - its approval as one word: pending, approved, rejected, expired, cancelled or mismatch;
   - a summary of its verified answer.

   It never shows the plan's digest, the model, request ids, approval ids or who decided.

7. **Screen.** Each item is marked "Agent task" or "Plan step". A step also shows its state in its plan.
   - A step's details show its plan's status, its state in the plan, what it waits on and its approval, with a link to Automations, where the plan is acted on.
   - The page is still read only, and reading it calls no model.

## Evals

No prompt, model context, routing, model or Agent Engine behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

- Plan steps come from the plan service's list, which holds the newest 100 plans (`MAX_PLANS_LISTED`), like Automations. Steps of older plans are not listed, and the screen says so once 100 plans are reached.
  - A composite index `organizationId, createdAt desc` on plans, or on child executions, would lift this. That needs Terraform, so it is left for when an organization reaches it.
- One page reads every listed plan's document and, for the steps it shows or skips while filtering, each plan's version and child executions.
- Tests:
  - `apps/api/src/plans.test.ts` (ADR-0149 block), on a running plan with two branches:
    - each step's plan state matches the plan's own page;
    - dependencies;
    - a task mixed in, newest first, and the origin filter;
    - one cursor across both sources;
    - agent, state and day filters;
    - rejected, approved and expired steps;
    - the summary and the fields never shown;
    - no `plan.read`;
    - another organization;
    - the plan source failing.
  - `apps/api/src/agent-tasks.test.ts`: tasks only, the fields, and an empty list.
  - `apps/web/src/agents/organizationTasks.test.tsx`: origin marks, plan step details, approvals in words, the origin filter, and the warnings.

## Open

- Steps of plans older than the newest 100.
- Tool steps, waits and acting from this list, which need their own decisions.
