# ADR-0184: a plan's tool step may write data (B6)

- Status: Accepted
- Date: 2026-10-07
- Builds on: [ADR-0026](0026-tools-approvals-and-guardrails.md) (tools, approvals, guardrails), [ADR-0029](0029-runtime-guards.md) (runtime guards, idempotency), [ADR-0034](0034-human-tool-invocation.md) (invocation modes), [ADR-0084](0084-agents-propose-and-schedule.md) and [ADR-0104](0104-follow-up-schedule-v3-model-tool.md) (`follow_up_schedule`), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps in plans), [ADR-0153](0153-failed-plan-steps-run-again.md) (retries), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (read-only tool steps), [ADR-0161](0161-tool-step-input-from-earlier-steps.md) (inputs from earlier steps), [ADR-0163](0163-the-approved-credit-budget-caps-a-plan.md) (budget), [ADR-0165](0165-tool-steps-in-the-workflow-editor.md) (editor), [ADR-0179](0179-workflow-lifecycle-and-reliability.md) (cancellation)
- Product decision: Geovet, B6, 2026-10-05 07:45Z ("write tools may be workflow steps when they are assigned to the agent and pass risk, autonomy, approval policy and audit; not a blanket permission") and 2026-10-07 03:01Z (build B6 end to end on the existing engines; no recurrence, no J1).
- Terraform: none. Firestore: no new field, collection or index; no migration. Prompts, models and providers: none. The planner's prompt and reader (plan_proposal@3, ADR-0176) are unchanged.

## Context

ADR-0159 let a workflow's tool steps only read: the validator refuses every tool that changes data, reaches an external provider or needs a credential (`tool_not_read_only`). Product decision B6 opens writes, but not as a blanket permission.

Almost everything a write needs already exists, on the one path every tool takes, the Tool Gate:

- **Authorization.** The agent's version must list the tool, a skill must grant it, the person the plan runs for must hold `tool.execute` and the tool's permissions, and the department and environment must allow it.
- **Approval.** A tool step's approval is asked when its agent's step is ready (ADR-0151). It is bound to the organization, the child execution, the node, the agent, the tool version, the action and the digest of the exact input. Rejected, expired or withdrawn, the branch is skipped and the rest of the plan goes on.
- **Double execution.** Only one caller moves a node from pending to running, in one transaction. The second gets `node_not_pending`.
- **Idempotency.** A mutating tool gets its node's idempotency key, recorded before the effect.
- **Timeouts.** A timeout is never retried. A plan step is retried only when no tool in it started (ADR-0153).
- **Cancellation.** A cancelled plan withdraws its approvals and no node starts in an ended execution (ADR-0179). A call that ends after the plan ended is `execution_ended`.
- **Budget.** A tool has no price. The step's agent call goes through the Credit Core, and a step the approved budget cannot cover never starts (ADR-0163), so neither do its tools.
- **Audit and tenancy.** The `tool.*` and `execution.*` events, and every read and write, are scoped to the execution's organization.

What was missing:

1. a way for a tool version to say it may write as a plan step;
2. the validator, the editor and the API accepting such a version;
3. a first write tool built for plans;
4. a skill that grants it;
5. the worker running it.

## Decision

1. **A version opts in with the invocation mode `plan`.** `plan` means a plan's tool step may run this version although it changes data. It is never implied by `runtime`. `isPlanWritable(version)` holds only when all of these hold:
   - the version is mutating;
   - it names `runtime` and `plan`;
   - its provider is internal and it needs no credential;
   - its approval policy is `approval_required`.

   External providers, credentials and `auto` writes stay out of plans.

2. **The validator accepts a plan-writable version as a tool step.**
   - Any other mutating, external or credentialed tool is still refused with `tool_not_read_only`.
   - A write step always waits for a person: the validator marks it `approvalRequired` whatever the risk policy says.
   - The existing rule follows from that: an approved call takes fixed input only (`input_ref_needs_fixed_input`). Its arguments are what the person wrote in the workflow and approves, never an earlier step's or a model's text (D3).
3. **The Tool Gate enforces it again (defense in depth)** in an execution of a plan step:
   - a mutating tool that is not plan-writable is denied with `tool_not_plan_writable`, even if a stored plan names it;
   - a plan-writable one never runs without an attached approval. `auto` becomes `approval_required`.
4. **The first write tool is `workflow_follow_up@1`.** It is its own tool, not a version of `follow_up_schedule`, because an agent holds one version of a tool and keeps `follow_up_schedule@3` for its model mid-task. It schedules a follow-up with a contact, through the follow-up service's own `create`, as the runtime for the person the plan runs for, with source `agent`.
   - Input: `contactId`, `type`, `title` (1–120 characters), `inDays` (0–30) and `time` (`HH:MM`). Every field is fixed in the workflow.
   - The date is today in the business's time zone plus `inDays`, read when the step runs. The time is never assumed.
   - The request key is made by the server from the organization's follow-up content: contact, type, title, resolved date and time. A retry, a concurrent plan or a person running the workflow again the same day after an ambiguous failure all reach the same follow-up, which the service makes once (`created: false` after the first).
   - It refuses to run without the runtime, the plan's agent and an attached approval.
   - The contact must be in the execution's organization; the service checks that, as for every follow-up.
   - Risk is low; permission is `follow_up.manage`; it is never retried in the gate.
5. **The skill `customer_follow_up@4`** (sales agents only) grants `follow_up_schedule@3` and `workflow_follow_up@1`, so an upgrade from version 3 keeps what the agent had and adds the write. It reaches an agent only when a person upgrades the agent's skill. Nothing is granted by default.
6. **A schema string may name the record it refers to**, with `ref: 'contact'`. It is a hint for screens, so the editor offers a contact picker instead of an id field. It grants nothing; the server checks the record as before.
7. **The planner does not offer write steps.** Its context lists a write tool as not usable as a step (`tool_changes_data`). The prompt and reader are frozen, so a person adds write steps in the editor. Whether GIA may propose writes is a later decision that needs its own evals.
8. **Screens.**
   - The editor offers a plan-writable tool's fields: a contact picker, the type in words, the title, the days and the time. Every value is fixed there; no earlier step's answer or result is offered as a source. It says the step changes data and that a person approves it each time.
   - A plan's step waiting for approval shows exactly what will be written, with the contact by name, before Aprobar or Rechazar.
9. **Nothing else is new.** No tool, approval, credit, audit or runtime engine is added. The worker runs `workflow_follow_up` with the follow-up executor it already has (provider `follow_up`), also when no contact resolver is configured (only version 3 needs one).

## Adding the next write tool

A new write tool, for contacts, documents, inventory or calendars, needs only these:

- its version in the registry, with `mutating: true`, `invocationModes: ['runtime', 'plan']`, `approval_required`, an internal provider, no credentials and a bounded input;
- an executor that requires an attached approval and the runtime, runs the owning domain service as the person the plan is for, and uses a request key the server derives (from `context.idempotencyKey`, or from the content when a re-run must reach the same record);
- a skill version that grants it.

The validator, gate, approvals, cancellation, budget, audit and screens need no change. External providers and credentials need the credential engine and a new decision first.

## Known limits

- A follow-up that a person cancelled and a workflow asks for again the same day, with the same content, is not made again: the service returns the cancelled one.
- The approval is for "in N days at HH:MM". The date is fixed when the step runs, which is right after the approval.
- The Approvals page shows the tool and its impact (`changes_data`), not the values. The plan's card shows the values.
- Recurrence is out of scope: a workflow still runs when a person starts it.

## Tests

- `packages/tools`: `plan` is a known mode; `isPlanWritable` holds only for the conditions above; `ref` is checked in schemas.
- `packages/planning`: a plan-writable write step is accepted and needs approval; other writes stay refused; its input cannot come from an earlier step; the planner context marks writes as not usable.
- `packages/guardrails`: in a plan step's execution a non-plan-writable write is denied, and a plan-writable one with `auto` policy still needs approval.
- `packages/integrations`: `workflow_follow_up` refuses without approval, the runtime or the agent; the date is read in the business's time zone; the key is the same for the same content.
- `apps/worker`, end to end, workflow → plan → approval → execution → tool step → follow-up → audit → next step:
  1. an authorized write succeeds;
  2. a write without authorization (no skill grant, permission or approval) does not happen;
  3. a double execution writes once;
  4. a retry after a timeout writes once;
  5. a retry after an ambiguous response writes once;
  6. concurrent plans write once;
  7. cancelling before it runs writes nothing;
  8. cancelling during the flow writes nothing after;
  9. a withdrawn approval writes nothing;
  10. a budget that cannot cover the step writes nothing;
  11. tenant A cannot reach tenant B's contact;
  12. the audit trail is complete;
  13. the step after the write runs;
  14. a failing write fails its branch only;
  15. after the failure, running again recovers safely.
- `apps/api` and `apps/web`: the tool view exposes the write step's fields, the editor offers them, and the plan's card shows what will be written.
