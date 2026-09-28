# ADR-0058: Commercial follow-ups (C5)

- Status: Proposed
- Date: 2026-09-28
- Builds on:
  - ADR-0032 (worker and Cloud Tasks transport) and ADR-0029 (runtime actor);
  - ADR-0049 (office activity) and ADR-0051 (Company Brain);
  - ADR-0053 (customers and leads), ADR-0054 (opportunities) and ADR-0055 (contact context);
  - ADR-0052 and ADR-0057 (GIA's chat and commercial intelligence);
  - Geovet's C5 brief of 2026-09-28.
- Does not change:
  - Terraform, queues, service accounts, IAM or Firestore indexes;
  - the job runtime, the tool gate, executions or MelonMotor;
  - the AI Gateway, its policy or credits;
  - the Integration Engine: nothing is ever sent to a contact.

## Context

C1 to C4 gave Comercial its contacts, opportunities, pipeline and GIA's reading of them. A business still had no way to say "call Juan tomorrow at 10" and be reminded when the time came. C1 and C2 only had a free-text `nextAction` with a day.

Geovet's rules:

- Reuse. No new scheduler if MelonMotor already has one, no parallel engine and no general task manager.
- A person creates follow-ups from a contact or an opportunity (level A). GIA may propose one and the person confirms it (level B). Automatic rules (level C) are prepared, not enabled.
- Use the business's time zone and relative dates. Ask for the time; never invent it.
- When a follow-up is due, show it inside MelonOffice. Nothing external.
- Audit without personal data. Company Brain gets totals only. No credits, and no model for deterministic work.

## Decision

### 1. One entity, `followUps/{id}`

`FollowUp` (in `packages/domain/src/follow-up.ts`) belongs to one contact, and optionally to one of that contact's opportunities. Its fields:

- identity and scope: `id`, `organizationId`, `contactId`, `opportunityId?`;
- what and when: `assignedTo`, `type`, `title`, `description?`, `scheduledAt` (UTC), `timeZone`;
- state: `status`, `source`, `schedule`, `history`, `revision`;
- outcome stamps: `dueAt`, `completedAt/By`, `cancelledAt/By/Reason`, `failure`, `failedAt`;
- `metadata.automation` and the creation stamps.

Values:

- **Types:** `follow_up`, `call`, `message`, `review` and `check_in`. A `message` follow-up is a reminder to write; nothing is sent.
- **States:** `scheduled` → `due` → `completed`, plus `cancelled` and `failed`. `due` and `failed` stay open, so a person can complete, cancel or reschedule them. Rescheduling a completed or cancelled one reopens it and keeps the earlier time in `history` (at most 20 entries).
- **Source:** `manual` (level A), `gia` (level B) or `rule` (level C, reserved and not reachable from any code path).

Service rules (`createFollowUpService`, `packages/conversations/src/follow-ups.ts`):

- The id is `followUpIdFor(org, requestKey)`, so the same request is the same follow-up.
- The time is required: a date plus a local time, read in the business's zone. Daylight saving is handled in `zonedInstant`.
- A time more than 5 minutes in the past, or more than 366 days ahead, is refused.
- A record may have at most 20 open follow-ups.
- A closed opportunity or an archived contact takes no new follow-up.
- The assignee is, in order: the chosen member (who must belong to the organization), the opportunity's owner, the contact's owner, then the creator.
- Every change is a person's (`actor === 'user'`) and carries a revision.

### 2. No new scheduler: the existing job transport, with a schedule time

MelonMotor's only scheduler-like piece is the X6d transport (ADR-0032). It is one Cloud Tasks queue (`execution-jobs`, 10 attempts, 10 s to 600 s backoff), an OIDC invoker service account, and the worker's internal routes.

C5 reuses all of it:

- `packages/runtime/src/cloud-tasks.ts` gains an optional `scheduleTime`, used by a second small facade, `createCloudTasksScheduler`. The same private client serves both it and the job dispatcher.
- The task body is `{ organizationId, followUpId, schedule }`: codes only, never a name or a title.
- The worker route is `POST /internal/follow-ups/run`. It runs behind the same token, content type and size checks as `/internal/jobs/run`, and does nothing else.
- Cloud Tasks holds a task for at most 30 days, so the service queues at most 29 days ahead. A task that arrives early (`early`) queues the next hop and returns. A follow-up a year out is reached in about thirteen hops.

Follow-ups are **not** X1 executions or tool calls. The tool gate needs a specialist, and a reminder has no agent. Making it one would invent an agent, credits and verification for a date check.

### 3. Idempotent and retried by the queue

- `schedule` grows on every reschedule or reopen. A task whose `schedule` differs from the stored one is `stale` and does nothing. A duplicate, late or superseded task is therefore harmless.
- `runDue` re-reads everything in one Firestore transaction. If the follow-up is still `scheduled`, its time has come and the record is still open, it becomes `due`.
- If the record ended (opportunity won or lost, contact archived), the follow-up is cancelled with `opportunity_closed` or `contact_archived`.
- An error answers 503, so Cloud Tasks retries with its own policy. There is no retry loop of our own.
- On the last attempt (`x-cloudtasks-taskretrycount` ≥ 9) the worker calls `failDue`, which marks it `failed` / `retries_exhausted`. It never silently stays `scheduled`.
- If the task cannot be queued at creation or reschedule, the follow-up is kept as `failed` / `not_scheduled`, and the API answers 503 `follow_up_not_scheduled`. The person sees it and can give it a new time.
- If no scheduler is configured (staging and prod today), the API answers 503 `follow_up_scheduler_unavailable` and creates nothing. Nothing is ever pretended to be scheduled.

### 4. The runtime marks it due, as the system

Due, automatic cancel and failure are written by the runtime actor (ADR-0029), `initiatedBy` the creator. They are never recorded as the person. The activity feed (ADR-0049) shows these as `system`, with a link to the follow-up.

### 5. `nextAction` mirrors the earliest open follow-up

C1 contacts and C2 opportunities keep their `nextAction`, and C4's attention rules read it. The alternative, two sources of truth, would leave C4 blind to follow-ups or double-count them.

The rules:

- The record's `nextAction` (the opportunity if the follow-up has one, else the contact) is `{ text: title, dueOn: local date, followUpId }` of its earliest open follow-up.
- It is written in the same transaction as the follow-up, and audited as `contact.updated` or `opportunity.updated` with reason `follow_up` or `next_action_cleared`.
- With no open follow-up left, a derived `nextAction` is cleared, and a person's own note (one without `followUpId`) stays.
- Changing a derived `nextAction` through C1 or C2 is refused with 409 `next_action_from_follow_up`. The screens show it read-only and point to the follow-up.
- A contact without a commercial profile (a bare channel contact) gets follow-ups but no mirror.

C4's "next action overdue" rule therefore covers follow-ups with no change to C4.

### 6. Permissions, audit, activity and Company Brain

- **Permissions:** `follow_up.read` and `follow_up.manage`, given to the owner. There is no new role (D-27 remains open).
- **Audit:** category and target type `follow_up`, with these actions:
  - `follow_up.created` (reason = type, reference = source);
  - `updated`, `rescheduled`, `completed`, `cancelled` (reason = cancel reason) and `due`;
  - `failed` (result `failure`, reason = failure).
  An event never carries a title, description, name or phone.
- **Activity:** a new action group `FOLLOW_UP_ACTIONS`, read through the existing composite index. It is queried in groups of ten actions, as before.
- **Company Brain:** after each change the API ingests `commercial.open_follow_ups_count` and `commercial.overdue_follow_ups_count`, best effort. Totals only.

### 7. GIA: reads, proposes, never writes

- The insights read (ADR-0057) now receives the follow-ups (only with `follow_up.read`): counts, the person's own, and up to 10 listed (references `f_a`…).
- It also receives the person's words, to bring in the contacts named in the message (`mentionedContacts`, by full or first name).
- The prompt carries a 14-day grid of real dates. The model picks a date; it never computes one.
- With `follow_up.manage` only, the output schema gains `followUp { record, type, title, date }`. `record` is a closed list of the references she was given. There is no time field.
- `followUpProposalOf` rebuilds the proposal on the server:
  - **Date:** first the person's own words, by fixed rules (`relativeDate`: hoy, mañana, pasado mañana, en N días, próxima semana, weekdays, in Spanish and English), newest turn first. Otherwise the model's date, if it is a real date within the horizon. Otherwise none.
  - **Time:** only from the person's words (`relativeTime`); otherwise none.
- The web shows the proposal as a form: nothing is pre-filled that the person did not say, and the time is required. The follow-up is created only when the person confirms, as `source: 'gia'`. The chat says "Scheduled" only after the API answers.
- Without `follow_up.manage` there is no schema field, and she says the person cannot schedule.

GIA's audit and credits are unchanged: one model call, 1 credit, no extra write.

### 8. Levels

| Level | What                                         | State                                                  |
| ----- | -------------------------------------------- | ------------------------------------------------------ |
| A     | A person schedules from a contact or deal    | Enabled                                                |
| B     | GIA proposes; the person confirms            | Enabled                                                |
| C     | Automatic rules create follow-ups themselves | Prepared (`source: 'rule'`, `automation`), not enabled |

Enabling C needs its own decision: which rules, their limits, and who they act for.

## Consequences

- **No infrastructure change.** In DEV the API and worker already have `JOB_QUEUE`, `WORKER_URL` and `JOB_INVOKER_EMAIL`, the enqueuer role and `actAs` on the invoker (X6d, CV-6). Both follow-up queries are equality-only, so they need no composite index.
- Where the transport is not configured (staging and prod today), follow-ups can be read but not created (503). No silent fallback exists.
- Follow-up tasks share the job queue's rate and retry policy. That is acceptable at this volume, and a separate queue is a one-line change later.
- Due is shown in the activity feed, not pushed. There are no push, email or WhatsApp notifications.
- A task queued for a reschedule that then fails leaves a stale task behind, which is harmless because `schedule` differs.

## Alternatives rejected

- **A cron sweeper over all follow-ups:** a second scheduler, an org-wide scan every minute, and a new job to deploy.
- **X1 executions with a "reminder" tool:** an invented agent, credits and verification for a date comparison.
- **Keeping `nextAction` separate from follow-ups:** two answers to "what's next", and C4 would miss follow-ups.
- **Letting the model pick the time:** Geovet's rule is to ask and never invent. A model-picked time is one the person did not say.
