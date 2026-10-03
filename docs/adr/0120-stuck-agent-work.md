# ADR-0120: Stuck agent work never blocks an agent (AE-7)

- Status: Proposed. Its "Not done" sweeper is built by [ADR-0121](0121-automatic-sweep-of-abandoned-work.md).
- Date: 2026-10-02
- Builds on: [ADR-0029](0029-runtime-guards.md), [ADR-0032](0032-worker-and-job-transport.md), [ADR-0119](0119-bounded-work-and-plan-results.md)

## Context

ADR-0119 bounds open work: at most 10 open executions per agent. Nothing in MelonOffice closes an execution that stopped moving. There is no sweeper, no scheduler and no cron. Every stop or expiry is checked only when a job delivery runs, and an execution can stay open forever when:

- its job was dropped after Cloud Tasks' last retry, or its first dispatch failed and was only logged;
- a node was found `running` on a fresh delivery and ended `outcome_unknown`, which is never retried;
- an approval expired and nobody came back to decide it.

With the new limit, ten such executions would block an agent for good.

## Decision

1. **Stuck is read, not written.** `isStaleWork` (`packages/agents/src/stale.ts`) applies two rules:
   - An open execution not updated for 6 hours is stuck. That is well past the longest a job is retried and the Harness's 10 minutes of work.
   - One `waiting_approval` is stuck only after 31 days: the longest an approval may wait (30 days), plus a day.
   - An ended execution is never stuck.
2. **Stuck work does not count toward the agent's limit.**
   - When an agent reaches its limit, the task service reads up to twice the limit of its open executions and counts only the ones still moving.
   - Each is read with the repository's `find` in the organization, so no composite index is needed.
3. **The person sees it and decides.**
   - A task's view says `stale: true`.
   - The screen says the agent has made no progress for hours and may be stuck, next to the existing "Stop" button (`execution.cancel`, a person's decision, audited).
   - MelonOffice never closes or fails the person's work on its own: it does not decide that a task the person asked for is over.

## Not done

- **An automatic sweeper.** Closing stuck executions across organizations needs three things:
  - a scheduled trigger (Cloud Scheduler);
  - a composite index on `executions (status, updatedAt)`;
  - a product decision on whether the runtime may fail work a person started.

  All three are infrastructure or product decisions for the owner. They are documented here and not built.

- **The organization's limit (200) still counts stuck work.** It is a cheap count that cannot see `updatedAt`. The people of the organization see and can stop each stuck task.

## Consequences

- No migration, no Terraform and no new dependency.
- An agent with stuck tasks keeps taking work. Its stuck tasks are shown as such until a person stops them.
