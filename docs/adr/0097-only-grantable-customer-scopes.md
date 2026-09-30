# ADR-0097: Partners ask only for customer scopes that open something (C-5f)

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0088](0088-commercial-console-reads-and-screens.md), [ADR-0089](0089-customer-invitations-by-email.md)
- Terraform: none.

## Context

A partner or agency could ask a customer for seven scopes, and the customer could grant them. Only four open a read the API serves: `summary`, `usage`, `billing` and `branding`. `support`, `knowledge` and `conversations` open nothing, so the console offered options that did nothing, and a customer could be asked to share "their conversations" or "their company's memory" when nothing would ever read them under that consent.

## Decision

- New invitations and customer requests may ask only for `summary`, `usage`, `billing` and `branding`. Asking for another scope answers 400 on `scopes`, as an unknown scope already did.
- The three others stay known. Relationships and pending invitations that already hold them keep them: they still grant nothing, and an owner can still accept or narrow them.
- The console's invitation form shows only the four. Its "(their company's own content)" marker and the labels for the three are removed.
- A scope is added to the grantable list only together with the read it opens, its permission and its tests.

## Consequences

- No option in the console promises access that does not exist.
- Nothing already granted changes, and no data migration is needed.
- Tests: the API refuses the three in a new invitation and in a new request; the console offers only what it can read.
