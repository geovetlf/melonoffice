# ADR-0189: a plan's follow-up date is fixed at approval

- Status: Accepted. Amends the date rule of [ADR-0184](0184-plan-tool-steps-that-write-data.md) (`workflow_follow_up@1`).
- Date: 2026-10-12
- Builds on: [ADR-0026](0026-tools-approvals-and-guardrails.md) (approvals), [ADR-0029](0029-runtime-guards.md) (idempotency), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps in plans), [ADR-0184](0184-plan-tool-steps-that-write-data.md) (write steps).
- Terraform: none. Firestore: no new field, collection or index; no migration. Contract: the input and output of `workflow_follow_up@1` are unchanged, so no new version.

## Context

ADR-0184 said the follow-up's date is "today in the business's time zone plus `inDays`, read when the step runs". The person approves "in N days at HH:MM", so they approve a date they can read from the approval's day. The step runs after the approval, and nothing ties the two together. Across midnight in the business's time zone the follow-up lands one day later than the person approved. The request key is made from the date, so the same approved call run again after midnight also gets another key, and a second follow-up can be made for it.

## Decision

1. **The date is fixed at approval.** It is the day the person decided the approval, in the business's time zone, plus `inDays`. The day is read from the approval's decision instant (`decidedAt`), never from the clock when the step runs.
2. **The approval is read by the executor, and only accepted when it covers this call.** The approval is read from the store, scoped to the execution's organization. It must be `approved`, belong to this execution and this node, and carry its decision instant. Anything else refuses with `approval_missing` and schedules nothing. A missing instant is never replaced by the clock.
3. **Nothing else changes.** The input, the output, the request key (contact, type, title, date and time), the follow-up service's `create` and the audit are as before. An approval decided on one local day gives one key, so a retry or a re-run after midnight reaches the same follow-up. A new approval on another day is another follow-up.
4. **No new version.** The fields and the answer are the same, so `workflow_follow_up@1` still reads already-approved plans. A plan approved before this change, and not yet run, takes its date from its approval's decision instant, the same way.
5. **The executor no longer reads a clock.** Its `now` option is removed; nothing else used it for this tool.

## Known limits

- The business's time zone is read when the step runs. Changing the time zone between approval and run moves the date. Storing the zone with the approval would need a new approval field, which this change does not add.
- The approval shows "in N days at HH:MM", not the date. Showing the date is a screen change, not part of this decision.
- A follow-up made before this change keeps the key it was made with. This change does not move it.

## Tests

- `packages/integrations`: the date is the approval's local day plus `inDays` across midnight in the business's time zone, both ways (approved at 23:55 and run at 00:20, and approved at 00:05 and run later). A retry after midnight is the same follow-up. A missing, pending, cancelled, foreign, undecided or other-execution approval writes nothing.
- `packages/guardrails`: an approval withdrawn before its call is denied, and nothing runs.
