# ADR-0049: The office's activity, read from the audit trail

- Status: Proposed (Fase 1a of the GIA phase)
- Date: 2026-09-28
- Builds on: ADR-0019 (RBAC), ADR-0020 (audit), ADR-0040 (the Home), ADR-0048 (business profile), the Master Functional Map v1 and Geovet's instruction of 2026-09-28 ("connect the Home to the real activity; do not create a second audit system")
- Does not change: what any service audits, the audit event's shape, credits, conversations, the AI Gateway or GIA.

## Context

The Home's "Recent activity" panel showed examples under an "Example" badge (ADR-0040). The audit trail (ADR-0020) already records every meaningful change, append-only, in the same transaction as the change. Geovet asked for the real activity, readable by today, this week and this month in the company's time zone, respecting tenant, user, permissions and privacy, and without a second system.

## Decision

### 1. One source: the audit trail

- The activity is a filtered, read-only window on `auditLogs`. Nothing new is written, and no service records anything for the activity's sake.
- `packages/audit` gains a reader contract, `AuditReader.query({ organizationId, actions, from, to, limit })`, newest first. It is implemented by the in-memory store and by `FirestoreAuditStore`.
- A query names at most 30 actions. Firestore counts each value of an `in` filter against its limit of 100 filters and sort orders, so the Firestore reader asks for 10 actions at a time, in parallel, and merges the results by time.

### 2. What counts as activity

`packages/activity` holds an allowlist of the events a person would call their office's activity (29 today): the office and its profile, members, departments, messages and conversation changes, AI turns and hand-backs, channels and templates, tool results and approvals, tasks, plans, workflows and credits added.

- Plumbing is left out: sign-ins, tenant resolution, permission checks, reads, job leases and retries.
- A new kind of activity is one line in the catalogue and one message in each language.

### 3. What a person sees of each event

`toActivityItem` keeps only: id, time, action, result, who, and a link to the conversation when the event names one (as its target or as a `conversation:` reference).

- Who is `you`, `member`, `gia`, `agent`, `contact` or `system`. Another person's id is never returned.
- Reasons, references, versions, amounts and content stay in the audit trail.

### 4. Periods, in the business's time zone

- `today` starts at local midnight, `week` on local Monday and `month` on the local first. Each ends now.
- The time zone is the business profile's (ADR-0048). Before the profile exists it is America/Lima, and the response says `timeZoneSource: 'default'`.
- Local midnight is computed with Intl, so daylight saving time is respected (tested with Europe/Madrid).

### 5. Who can read it

- The new permission `activity.read` belongs to the owner. GIA acting for the owner may read it; it is a read.
- The service checks the tenant, the permission and that the organization is active. It returns only the organization's own events, even if the reader were to return others.
- A page holds up to 100 items, with `hasMore` when there are more.

### 6. API and app

- `GET /v1/organizations/:organizationId/activity?period=today|week|month` returns `{ period, timeZone, timeZoneSource, from, to, items, hasMore }`. It answers 400 for a bad period, 403 without permission or membership, and 503 `activity_not_configured` when the API runs without a reader.
- The Home's panel reads it with a Today / This week / This month picker (toggle buttons with `aria-pressed`).
  - No items: "No activity yet today / this week / this month".
  - A failed read: "We could not load the activity", never "nothing happened".
  - A role without `activity.read`: the panel says so, and no call is made.
- Tasks and meetings keep their "Example" badge until their data exists.

### 7. Infrastructure

- The query needs one composite index on `auditLogs`: `organizationId ASC, action ASC, occurredAt DESC`. It is declared in Terraform (`google_firestore_index.audit_activity`), only where Firestore is enabled (DEV today).
- So that the CD planner can read the index during a plan, its custom role gains `datastore.indexes.get` and `datastore.indexes.list`. These read index definitions (metadata), not data. The module test now allows exactly those two.
- Until Geovet applies the index in DEV, the route fails and the panel says it could not load.

## Consequences

- The Home's activity is true from the first event, and empty when nothing has happened.
- GIA's Workplace (Fase 1b) and GIA's answers (Fase 1c) read the same window, so the office tells one story.
- No new collection, writer or event bus.

## Not decided here

- Activity for roles other than the owner (D-27, the role catalogue).
- Filters by department or person, and paging beyond the first 100.
