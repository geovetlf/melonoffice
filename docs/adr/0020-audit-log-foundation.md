# ADR-0020: Audit log foundation

- Status: Proposed (Phase 2E, pending Geovet's review)
- Date: 2026-09-26
- Builds on: [ADR-0016](0016-auth-and-identity-foundation.md), [ADR-0018](0018-tenancy-and-memberships.md), [ADR-0019](0019-rbac-foundation.md)

## Context

Auth, tenancy and RBAC decide who may do what. Nothing records what actually happened. Phase 2E adds a record of security, identity, tenancy and authorization facts. It is a record only: it grants nothing, refuses nothing and is not the source of truth for users, memberships or any business state.

## Decision

### Event model (`packages/audit`)

| Field                     | Meaning                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                      | Random UUID, assigned on the server                                                           |
| `occurredAt`              | Server time                                                                                   |
| `action`                  | From the action catalogue                                                                     |
| `result`                  | `success`, `denied` or `failure`                                                              |
| `actor`                   | `{ type: 'user', userId, via }`. `system` and `anonymous` exist in the model only             |
| `organizationId`          | The organization the actor was **authorized** to act in, from a resolved tenant or a creation |
| `target`                  | `{ type: 'user' \| 'organization' \| 'membership', id }`, ids only                            |
| `requestedOrganizationId` | The organization the client **asked** for when tenancy refused it. Untrusted, kept apart      |
| `permission`              | The permission RBAC checked, for `authorization.check`                                        |
| `reason`                  | A stable error code (`organization_forbidden`, `permission_denied`, `storage_error`…)         |
| `requestId`               | The request's id, as returned in `x-request-id`                                               |
| `source`                  | The recording component. Today only `api`                                                     |

- There is **no free-form metadata**. Every field is structured, and `buildAuditEvent()` copies only these fields and checks each one:
  - Unknown actions and results an action does not allow are programming errors and throw.
  - `reason` must be a code and `permission` must look like `resource.action`.
  - A malformed requested organization or request id is dropped rather than stored.
- **Actor.** It is always built from the verified `AuthenticatedContext` (`actorOf()`) or from the user just created or signed in. Nothing in the body, query or headers can set it.
- **GIA** stays the real user as the actor, with `via: 'gia'` marking the channel. GIA has no identity of its own, and no path to write, change or skip events.
- **Tenant.** `organizationId` comes only from a resolved `TenantContext` or from the organization being created. A refused attempt on another organization records that organization only in `requestedOrganizationId`, never in `organizationId` or `target`, so a rejected request cannot pose as activity inside that organization.

### Results

- `success`: the action was allowed and completed.
- `denied`: tenancy, RBAC or a policy refused it. The policies are the one-organization limit, and GIA not being allowed to create organizations.
- `failure`: the action was allowed but failed technically.

A failed authentication (no, invalid or expired token) is none of these and is not recorded; see below.

### Action catalogue (`packages/audit/src/actions.ts`)

Only actions the code performs today:

| Action                         | Category      | Results                  | Recorded when                                                          |
| ------------------------------ | ------------- | ------------------------ | ---------------------------------------------------------------------- |
| `auth.register`                | auth          | success                  | `POST /v1/me` creates the internal user                                |
| `auth.sign_in`                 | auth          | success                  | `POST /v1/me` for an existing user                                     |
| `organization.create`          | tenancy       | success, denied, failure | `POST /v1/organizations`, except a malformed name (bad input)          |
| `membership.create`            | tenancy       | success                  | The owner membership created with an organization                      |
| `plan.assign`                  | entitlements  | success                  | An organization gets its initial plan (added by ADR-0021)              |
| `billing.subscription_created` | billing       | success                  | An organization's first subscription opens with it (added by ADR-0022) |
| `execution.created`            | execution     | success                  | An execution is created for an organization (added by ADR-0024)        |
| `execution.state_changed`      | execution     | success                  | An execution's status changes, with from and to (added by ADR-0024)    |
| `tenancy.resolve`              | tenancy       | denied                   | A request inside an organization is refused by tenancy                 |
| `authorization.check`          | authorization | denied                   | RBAC refuses a permission                                              |

### Not recorded

- **Rejected authentication.** The caller is unidentified, so recording it would let anyone write to the log at will. It stays in the request log (`auth rejected` with its code).
- **Allowed reads** (`GET /v1/me`, `GET /v1/me/organizations`, `GET /v1/organizations/:id`). They are frequent and change nothing.
- **A malformed organization name.** It is an input error, not a security event.
- **Tokens, authorization headers, cookies, passwords, secrets, emails and request bodies.** Events are built from ids, never from the request. Emails are not needed because the internal user id correlates with the user record.

### Persistence and immutability

- The Firestore collection is `auditLogs/{eventId}`, with flat fields: `occurredAt`, `action`, `result`, `actorType`, `actorUserId`, `actorVia`, `organizationId`, `targetType`, `targetId`, `requestedOrganizationId`, `permission`, `planId`, `planVersion` (added by ADR-0021), `transitionFrom` and `transitionTo` (added by ADR-0024), `reason`, `requestId` and `source`. Absent values are stored as `null`.
- The `AuditStore` port has only `append`. The Firestore store writes with `create` in a batch, so an event is never overwritten and a batch is all or nothing. There is no update or delete in the application.
- **No endpoint** reads or writes audit events. `POST /v1/audit-logs` and similar paths are `404`.
- IAM cannot make one collection append-only. The API's service account (`roles/datastore.user`) could technically change documents, and only the code prevents it. See the risks.

### Queries and indexes

The application runs no audit query yet, so **no index is created** and Terraform does not change. The flat fields support the planned queries. When a query is built, it will need its composite index, added through Terraform, for example:

- `organizationId ==` ordered by `occurredAt`
- `actorUserId ==` ordered by `occurredAt`
- `organizationId ==` and `action ==` ordered by `occurredAt`

A single equality or a time range alone is covered by automatic indexes.

### Error policy

Auditing can never turn a refusal into access, and failures are never silent:

1. **Atomic: organization and membership creation.** `organization.create` and `membership.create` (success) are written in the same Firestore transaction as the organization, its membership and the creator record. If they cannot be written, nothing is created.
2. **Required: sign-in.** `auth.register` and `auth.sign_in` are recorded after the sign-in. If that fails, the request answers `503 audit_unavailable` instead of a success nobody can trace. The user record may already be updated. A retry after a failed register is recorded as `auth.sign_in`; the user's `createdAt` still shows the registration.
3. **Outcome: denials and failures.** The response is already a refusal or an error and stays exactly that. If the event cannot be stored, the failure is logged at error level (`audit write failed`).

No queue or event stream is used.

### Service

`AuditService.record(input)` builds and stores one event. It knows nothing about HTTP and is the interface for API, auth, tenancy, RBAC, MelonMotor, GIA, workflows and jobs. Only the API calls it today. The atomic creation events use `buildAuditEvent()` inside the tenancy store's transaction.

### Relation to RBAC

RBAC decides; the audit log records RBAC's refusals (`authorization.check`) with the authorized tenant and the permission. Nothing reads the audit log to make a decision.

## Tests

- **`packages/audit`:** the catalogue; field validation and dropping of malformed untrusted values; extra input never reaching the event; GIA as channel only; append-only store (no update or delete, frozen events, duplicates refused); a failing store rejects.
- **`packages/tenancy` and Firestore:** creation events are stored with the organization, and nothing is created when they cannot be.
- **`FirestoreAuditStore`:** the flat document shape; an event is never overwritten; a batch is all or nothing.
- **API, in memory and on the Firestore emulator:**
  - every recorded action and its result, including `failure`;
  - actor and tenant cannot be forged through the body or headers;
  - A's refused attempt on OrgB keeps OrgB only as the requested target, and a user without membership is never recorded as a member;
  - suspended and revoked memberships, a suspended organization and an unknown role are recorded as denied;
  - allowed reads and rejected authentication are not recorded;
  - no audit endpoint exists for any method;
  - no token, header, password or email is stored;
  - the error policy for required and denial events.

## Pending decisions

1. Retention, TTL, archiving, export, SIEM or BigQuery. None is built, and retention will be decided later.
2. Who may read audit events, and through which endpoint and permission (for example `audit.read`), with its indexes.
3. A tamper-evident store beyond application-level append-only, such as a separate project, restricted IAM or hash chaining.
4. Whether rejected authentication should be recorded somewhere rate-limited.
5. A system actor for jobs, when jobs exist.

## Risks

- The API service account can technically modify `auditLogs`; append-only is enforced by the code, not by IAM.
- Every authenticated request that is denied writes one document. A signed-in user could cause many writes; rate limiting is not built yet.
- If the audit store is down, sign-in answers `503` until it recovers.
