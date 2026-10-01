# ADR-0115: Agent lifecycle, activation readiness and the paginated agents list

- Status: Proposed
- Date: 2026-10-01
- Builds on: [ADR-0024](0024-execution-foundation.md), [ADR-0025](0025-departments-and-specialists.md), [ADR-0029](0029-runtime-guards.md), [ADR-0062](0062-agent-engine-core.md), [ADR-0083](0083-skill-grants-enforced.md), [ADR-0103](0103-harness-tool-use-mid-task.md)

## Context

The Agent Engine diagnosis (AE-4) found three gaps before agents can run in production:

- Pausing or disabling an agent changed its record only. Its tasks in progress kept running, and could still call the model and spend credits.
- An agent could be activated while it could not work: a skill missing from the catalogue, a tool retired, an access the person activating it does not have.
- The agents' list was read whole. An organization with a thousand agents read a thousand records on every visit.

The owner decided (D1) that pausing stops work cooperatively, with no orphans and no more credits, and that disabling is stronger: it records who, when and why, and only an explicit activation undoes it. Plan limits (D3) wait for D-12 and do not block creating agents.

## Decision

1. **Lifecycle (AE-4.1).** The states stay those of ADR-0025; nothing new is stored but the last change.
   - Every status change records `lastStatusChange {from, to, at, by, reason}` on the agent. The reason is free text up to 500 characters, kept on the agent only; the audit records `reason_given`, never the text.
   - Disabling requires a reason (`invalid_specialist`, field `reason`).
   - After pausing, disabling or archiving, the API cancels the agent's open executions (`createAgentWorkStop` in `packages/agents`) with the reason `agent_paused`, `agent_disabled` or `agent_archived`, cascading to children as ADR-0029 does, and withdraws their pending approvals. It reads at most 200 per change, through an equality-only query per open status; it never fails the status change.
   - Independently, the Harness (`createHarnessAgentWork`) reads the agent's status before every step of agent work: tasks, conversation turns and plan steps. An agent that is not active stops the step with `agent_paused`, `agent_disabled` or `agent_not_active` before the model is called, so no credits are spent, and the hand-off is `policy`. The Tool Gate already refused tools of an agent that is not active.
2. **Readiness (AE-4.2).** Activation runs `agentReadiness` (pure, `packages/specialists`) and is refused with `409 specialist_not_ready` and the list of `problems`, each naming its skill, tool, permission or department: unknown skill or version, no skills, a skill for another department, a tool unknown or not active, an access the person lacks, a department not active, and (where the caller knows the policies) an unknown model policy. Readiness is computed, never stored.
3. **Pagination (AE-4.3).** `GET /specialists` with any of `limit`, `cursor`, `status`, `departmentId`, `q` or `skill` answers `{specialists, nextCursor}`, ordered by agent id. Status and department filter in the store; a name search (any case and accents) and a skill filter read at most 500 records per request and return a cursor where they stopped. Without parameters the route answers the whole list as before. The web page reads 25 at a time with previous and next, search and filters.

## Consequences

- No composite index and no data migration: the queries use equality filters and the document id. Old agents have no `lastStatusChange` until their next change.
- A search by name or skill over many agents may return a short page with a cursor; a denormalized search field would remove that limit later.
- The office (Home, departments) still reads the whole list; moving it to pages is a later step.
- Autonomy filters, plan limits and notifications are AE-4.4 onward.
