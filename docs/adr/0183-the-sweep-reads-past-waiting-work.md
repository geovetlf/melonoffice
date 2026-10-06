# ADR-0183: the sweep reads past work that is rightly waiting

- Status: Accepted
- Date: 2026-10-06
- Builds on: [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) (the sweep), [ADR-0146](0146-step-approvals-inside-running-plans.md) (steps waiting in a plan), [ADR-0179](0179-workflow-lifecycle-and-reliability.md) (the sweep moves a stalled plan)
- Product decision: Geovet, 2026-10-06 19:01Z, autonomous cycle: workflows and plans must be reliable, with recovery and multi-tenant isolation, on the existing engines.
- Terraform: none. The paged query uses the existing status and update index on executions, which already orders by document id after its last field, and falls back as before where the index is missing. Firestore: no new field, no migration. Prompts, models and providers: none.

## Context

Each sweep run read, per status, the 50 executions that had gone longest without changing. It acted on at most 100 of them.

Some work is rightly waiting and never changes while it waits:

- a plan waiting for a person's approval or for a wait step;
- a plan step that has not started because its plan waits;
- a plan that is running and waiting on its steps.

The sweep reads such work and leaves it alone, correctly. But it stays the oldest, so it fills the same 50 places on every run.

With more than 50 plans waiting across all organizations, two things the sweep exists for stopped happening for everything behind them:

- abandoned agent work was never closed (ADR-0121);
- a stalled plan was never advanced (ADR-0179).

One organization's waiting plans could therefore hold back another organization's recovery. A test with 60 waiting plans shows it: before this change the sweep read 50 of them and nothing else.

## Decision

1. **The candidates' read continues.** `StaleExecutionIndex.openSince` takes an optional `after` position (update, then id) and returns candidates strictly after it, oldest first by update and then id. In Firestore it orders by `updatedAt` and the document id and starts after both. Where the index is missing, the existing fallback filters and orders the same way in memory.
2. **The sweep reads page after page.** It reads 50 at a time, per status, until none remain or 500 have been read (`SWEEP_LIMITS.readPerStatus`). Reaching 500 is logged (`sweep read limit reached`), and the next run reads them again from the oldest.
3. **The limit of 100 counts what the sweep does, not what it reads.** An action is closing an execution or advancing its plan. Reading work that waits, has moved or is out of scope uses none of the limit.
4. **Stalled plans have their own 100.** Closing abandoned work never uses the budget for advancing stalled plans.

Every candidate is still read again in its own organization before anything is done, and the sweep still starts nothing, calls no model or tool, and charges no credits.

## Known limits

- More than 500 executions of one status rightly waiting still hide what comes after them, until some of them move or end.
- Each run starts from the oldest again; the sweep does not keep where it stopped.

## Tests

- `apps/worker/src/sweeps.test.ts`: 60 plans waiting and their 60 unstarted steps, all older than an abandoned task and a stalled plan. The task is closed, the stalled plan is advanced once, and every waiting step and plan is left alone. Without this change the same test reads only 50 waiting plans.
- `packages/firestore/src/open-work.test.ts`, on the emulator: candidates continue after a position, by update and then id, across organizations, each once. A position that is not one reads nothing.
- The existing sweep and workflow-run tests pass unchanged.
