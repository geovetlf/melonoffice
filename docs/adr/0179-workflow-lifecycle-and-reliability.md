# ADR-0179: a workflow's lifecycle is checked, recorded and recoverable

- Status: Accepted
- Date: 2026-10-06
- Builds on: [ADR-0070](0070-approved-plans-run.md) (plans run), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) (the sweep), [ADR-0146](0146-step-approvals-inside-running-plans.md) (step approvals), [ADR-0168](0168-one-truth-for-drafts-before-gia-writes-workflows.md) (dry run), [ADR-0178](0178-saved-workflows-run-end-to-end.md) (a saved workflow runs end to end)
- Product decision: Geovet, 2026-10-06 17:39Z, block "WORKFLOW LIFECYCLE & RELIABILITY": a workflow goes from draft to validated, active, running and an end state, safely under edits, concurrency, restarts and retries, reusing the engines that exist. No new engine and no new versioning system. Not in scope: recurrence or a scheduler, B6, B7, new providers, production.
- Terraform: none. Firestore: one optional field on a workflow (`lastStatusChange`), no migration. Prompts: none. Models and providers: none.

## Context

An audit of the lifecycle against the 14 points of the block found the store layer sound:

- every plan, execution, approval and job write is a revision-checked transaction;
- child execution ids and job ids are fixed, so a second start finds what the first made;
- a plan keeps its own version, steps and source (`workflowId`, `workflowVersion`), so editing the workflow never changes a plan already made;
- a decision needs its approval to be `pending`;
- AI holds are per model call; waits and approvals hold nothing.

It also found six gaps:

1. **Any workflow could be activated**, including one whose steps no plan would accept, and a new version of an active workflow was not checked either. The person learnt it only when preparing a plan.
2. **Who switched a workflow on or off, and when**, was only in the audit trail; the screen could not say it.
3. **Cancelling a plan left its step approvals in the inbox.** They could no longer do anything, but a person could still be asked.
4. **A plan could stall.** The runtime tells the plan a step ended through a hook that swallows its failure, and a redelivered job ends the step without the hook. The sweep abandoned work only after 24 hours idle, so such a plan sat `executing` for a day.
5. **A plan approved but not started stayed `approved` for good** when the request that approved it ended before the conductor ran. Approving again was refused.
6. **The plan's trace did not say which workflow version made it**, nor who decided each step approval.

## Decision

1. **Only a workflow that would plan now is activated.** Activating runs the same dry run as `POST workflows/check` (ADR-0168) on the current version, and a refusal is `409 workflow_not_valid` with `stage:reason[:where]` as its detail. A new version of an active workflow is checked the same way before it is stored. Both writes refuse with `workflow_concurrency_conflict` when the workflow changed between the check and the write. Drafts and turned-off workflows can still be edited freely; a draft never runs, since only an active workflow prepares plans.
2. **A workflow records its last status change**: from, to, when and who (`lastStatusChange`). The audit keeps every change; the API and the screen show the last one.
3. **Cancelling a plan withdraws its step approvals.** The cancellation cascade cancels each approval nobody decided, with reason `plan_cancelled`. One already decided or withdrawn is left as it is. A tool that already started is never aborted; the Tool Gate records that its execution ended, and a plan's tool steps are read-only (D2).
4. **The sweep moves a stalled plan.** Each sweep (every 3 hours) also reads plan executions still `running` and idle for more than 30 minutes (`PLAN_IDLE_MS`). A plan that is `executing` with its delegation completed is advanced through the conductor, the same call a step's end makes. Advancing is idempotent, so a plan that was not stalled moves nothing.
5. **Approving again an approved plan starts it.** When the plan is `approved`, or `executing` with its delegation not completed, and the person approves the same version and digest, the API runs the conductor without a second decision. Another version or digest is refused as before. Once started, approving again is `409` and starts nothing.
6. **The trace names the workflow and version, and each step approval and its actor.**
7. **The Automations screen shows the lifecycle in words**: Borrador, Activa, Desactivada and Archivada, what each means, the last change, and for a draft or a turned-off workflow whether it can be activated ("Validada") or why not. A plan says "De «nombre», versión N". An approved plan that did not start offers "Iniciar ahora". Desactivar replaces "Pausar" for a workflow: a turned-off workflow prepares no new plans and the ones already running go on.

## Tests

- `apps/worker/src/workflow-runs.test.ts`, in memory and on the Firestore emulator, with the worker's real composition:
  - lifecycle: a draft never plans, an activated workflow plans, a turned-off one refuses new plans while its running plan ends;
  - versions: a running plan keeps its version after an edit, and an invalid version of an active workflow is refused;
  - cancel: the plan's approval is withdrawn, its children are cancelled, a later wake moves nothing, nothing stays held, and the audit names the actor and reason;
  - nothing runs twice: concurrent starts, a job delivered twice, three workers advancing at once, a decision repeated, two resumes at once and a wake delivered twice. Each step runs once and each model call is held and closed once;
  - recovery: a plan whose step end was never told is advanced by the sweep.
- `packages/workflows`: activation and new-version refusals, concurrency and `lastStatusChange`.
- `apps/api/src/plans.test.ts`: `409 workflow_not_valid` with its detail; approving again starts a plan cut short, once, and never another version.
- `packages/agents`: the trace's workflow version and approval actors.
- `apps/web/src/automations/automations.test.tsx`: statuses in words, "Activar de nuevo", readiness, the activation refusal, the plan's workflow version and "Iniciar ahora".

## Known limits

- A first job lost before it ever ran is still closed by the 24-hour sweep (`stale_execution`). Queueing it again later would fail on the Harness time limit, which counts from the execution's start.
- The plan sweep reads at most `SWEEP_LIMITS.perStatus` executions per run.
- Two workers deciding the same check at the same moment can record its decision twice in the audit; the plan itself moves once.
- A plan is cancelled with reason `director_request`; a free-text reason is not stored.
- A plan has no "paused" state of its own: it waits for an approval or a wait, and the screen says which.
