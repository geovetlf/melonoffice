# ADR-0147: the audit trail viewer

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0020](0020-audit-log-foundation.md) (the audit trail), [ADR-0049](0049-office-activity.md) (its read side and the activity view), [ADR-0054](0054-opportunities-and-pipeline.md) (one record's history)
- Terraform: none. Firestore: no new index, no migration. Prompts: none.

## Context

Every audited action is stored in the audit trail (ADR-0020). People only saw a small curated slice of it: the office activity of today, this week or this month, 100 items at most, with no detail. The request was to show the trail itself, read only, to authorized people. There must be no second audit system.

An audit of what existed:

| Piece                     | State                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage                   | Append only. No update or delete exists in code.                                                                                                                                                                  |
| Read API                  | `AuditReader.query`: one organization, up to 30 actions, a time range, a limit, newest first. Indexed in DEV since ADR-0049. `AuditHistoryReader.history`: one record, equality filters only, at most 200 events. |
| HTTP                      | `GET activity?period=` (curated actions, no cursor). Record histories inside the customer and opportunity routes.                                                                                                 |
| Permission                | `activity.read` ("see what happened in the organization's office, read from the audit trail"). Only the owner role has it.                                                                                        |
| Filters the data supports | Action (by category), time range, one record. Filtering by person or by result would need new composite indexes.                                                                                                  |
| Event fields              | Structured codes only, with no free text. Some are internal: request ids, idempotency keys, credit references, job leases, the organization a client asked for, and the partner account.                          |
| UI                        | `PageHeader`, `Toolbar`, `StateMessage`, `Badge`, `Button`, `mo-list`, `agent-facts` in `packages/ui` and the web app.                                                                                            |

## Decision

1. **The same read side, a page at a time.** `createAuditTrailService` in `@melonoffice/activity` reads through the existing `AuditReader` and `AuditHistoryReader`. Nothing new is stored and no index is added.
   - A page has 25 events, newest first.
   - Events of the same instant are ordered by id, so the order is total.
   - The cursor is the last event shown, opaque to the browser and checked on the server.
   - The next page reads up to that instant, inclusive, and drops what was already shown.
2. **Route.** `GET /v1/organizations/:org/audit-trail` takes `category`, `from`, `to` (days in the business's time zone, the last 30 by default, a year at most), `cursor` and `target` (`type:id`, which reads that record's history).
   - The organization is the caller's.
   - Every value is checked on the server. Anything else answers 400 with its code: `invalid_filter`, `invalid_cursor`, `invalid_target` or `invalid_period`.
   - There is no write route.
3. **Who may read.** A person acting directly with `activity.read`. GIA and the runtime are refused. Events another organization's store returned by mistake are filtered out again.
4. **What is shown: an allow-list.**
   - When, the action and its category, and the result.
   - Who acted, as the reader understands it: you, another person in your company, GIA or an agent (for you or for another person), a contact, MelonOffice, or the platform administrator. Never another person's id or email.
   - The record's type. Its id appears only where the app opens it: a conversation, a follow-up or a plan.
   - Detail codes: reason, version, status change, step, tool, permission, model id and decision type.
   - Never request ids, references, idempotency keys, lease ids, the organization a client asked for, or the partner account.
5. **Everything but plumbing.** Tenant resolution, permission checks, job leases, node changes and delivery attempts are left out of "everything" and shown under their own "Technical" filter. The categories come from the action catalogue, and the API returns the list, so the screen keeps none of its own.
6. **The screen.** "Audit history" in the sidebar's tools, for `activity.read`:
   - type and day filters;
   - a list (when, who, what, on what, refused or failed);
   - details on demand, with labels for the codes;
   - "Show older events" for the next page;
   - plain empty and error states.
   - Nothing on it changes an event. All labels are in EN and ES.

## Evals

No prompt, model context, routing, model or Agent Engine behaviour changes. No run is needed, and V3 stays the baseline.

## Consequences

- Tests:
  - `packages/activity/src/trail.test.ts`: the catalogue split, actor mapping, the allow-list, GIA refused, a store leaking another organization, days and refusals.
  - `apps/api/src/audit-trail.test.ts`, on memory and on the Firestore emulator:
    - order and fields;
    - no secrets, references or ids;
    - cursor pages without repeats or gaps;
    - category, technical, days and record filters;
    - invalid inputs answer 400;
    - another organization reads nothing;
    - the permission;
    - no write route;
    - fails closed without a reader.
  - `apps/web/src/audit/audit.test.tsx`: the list, details, paging, filters, empty and error states, read only, and no permission.
- "Everything" reads its actions in groups of 30, one query each (16 Firestore reads per page in DEV, about 50 documents each at most).

## Open

- Who acted, by name: this needs a member directory, which does not exist yet.
- Filtering by person or by result: this needs new composite indexes (Terraform), so it is not done now.
