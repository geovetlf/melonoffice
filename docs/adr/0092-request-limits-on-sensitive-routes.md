# ADR-0092: Request limits on sensitive routes (C-5b)

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0045](0045-channel-delivery-limits-and-retries.md) (the fixed-window rule), [ADR-0091](0091-manual-commercial-operations-and-credit-grants.md)
- Terraform: none. One new Firestore collection, read by id; no index.

## Context

The closing audit of the commercial phases listed rate limiting as the last "finish now" item: platform changes, manual credit grants, invitation links and commercial changes had no limit per person, so a script or a stolen session could repeat them without end.

## Decision

- After authentication and before any route, every `POST`, `PUT`, `PATCH` or `DELETE` under these paths takes one slot of the caller's window. Reads are never limited.

  | Scope                | Paths                                                                            | Limit per person  |
  | -------------------- | -------------------------------------------------------------------------------- | ----------------- |
  | `platform_write`     | `/v1/platform/*`                                                                 | 30 per minute     |
  | `credit_grant`       | `/v1/platform/organizations/:id/credit-grants` (also counts as `platform_write`) | 20 per hour       |
  | `invitation_token`   | `/v1/invitations/lookup`, `accept`, `reject`                                     | 20 per 10 minutes |
  | `commercial_write`   | `/v1/commercial/*`                                                               | 60 per minute     |
  | `relationship_write` | `/v1/organizations/:id/commercial-relationships/*`                               | 30 per minute     |

- The window is per scope and user id, whether the person acts directly or GIA acts for them. It is stored in `requestRateWindows/{scope}_{userId}` (scope, user id, start, count; nothing from the request) and taken in a transaction, so every API instance shares it. Tests and local runs use an in-memory limiter.
- Past the limit: 429 `{error: 'rate_limited', retryAfterSeconds}` with `Retry-After`, before the route runs, so nothing is read, changed or audited. The refusal is logged with its scope.
- Replayed credit grants count: a retry loop is still a loop.

## Consequences

- Tests: which requests count; a person past the limit is refused and nothing changes; grants limited on their own; one person's window never stops another. On memory and the Firestore emulator.
- Not in this change: limits by IP or before authentication (Cloud Armor, at the edge, when moving to production); limits on AI or conversation routes, which have their own (ADR-0045 and the AI Gateway).
- **DEV:** nothing to apply.
