# ADR-0023: Credits foundation, wallet, ledger and atomic accounting

- Status: Proposed (Phase 2H, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0018](0018-tenancy-and-memberships.md), [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), [ADR-0021](0021-entitlements-plan-and-capability-foundation.md), [ADR-0022](0022-billing-foundation.md)

## Context

MelonOffice will need an internal unit to account for work that costs something. Phase 2H builds only the accounting: a wallet per organization and an append-only ledger, with atomic, concurrent-safe and idempotent operations. It sets no prices, grants no credits with any plan, measures no usage and calls no provider. D-12 values stay pending and resolve to zero.

## Decision

### Boundary

| Module       | Question                                                            |
| ------------ | ------------------------------------------------------------------- |
| Auth         | Who is calling?                                                     |
| Tenancy      | In which organization, through which membership?                    |
| RBAC         | May this member do this?                                            |
| Entitlements | What does the plan include?                                         |
| Billing      | What commercial relationship is there, which plan is in force?      |
| Credits      | How many credits does the organization have, and how did they move? |
| Audit        | What happened?                                                      |

`packages/credits` has no HTTP. It does not decide capabilities (entitlements does), does not know plans or prices (billing and D-12 do), and does not measure usage (metering, a later phase). Whether an action is allowed is asked of RBAC and entitlements before credits is asked to consume.

### The credit unit and integer accounting

One credit is an internal whole unit. It is not a currency, not USD and not tied to any price. Every amount is a JavaScript safe integer: an operation moves 1 to 10^12 credits and a balance holds 0 to 10^15, both far below 2^53, so every sum is exact. Amounts of 0, negative (except a signed adjustment), decimal, `NaN`, `Infinity`, strings or anything out of range are refused with `invalid_amount`. There are no floats anywhere in the ledger.

### Wallet

`CreditWallet { id, organizationId, balance, createdAt, updatedAt }`, one per organization. There are no user wallets and no transfers between wallets or users.

The wallet is opened by `openWallet(organization)` when the organization is created, **in the same transaction** as the organization, its owner membership, its billing and its audit events. It starts at balance 0: no plan comes with credits until D-12 decides otherwise. Tenancy checks that the wallet belongs to the new organization and is empty before writing anything. An organization without a wallet (none exist in dev) gets `credits_wallet_missing`; nothing is invented.

### Ledger

`CreditLedgerEntry { id, organizationId, walletId, type, amount, balanceAfter, referenceId, reason, refundOf?, createdAt }`.

| Type         | Amount   | Who can run it today                              |
| ------------ | -------- | ------------------------------------------------- |
| `grant`      | positive | Server-side code, through `CreditService.grant`   |
| `consume`    | negative | Server-side code, through `CreditService.consume` |
| `refund`     | positive | Server-side code, for an earlier `consume`        |
| `adjustment` | signed   | Nobody: prepared in the pure domain only (below)  |

The ledger is append-only: entries are created, never updated or deleted. `balanceAfter` records the running balance, so the ledger can be checked on its own. `verifyLedger(wallet, entries)` checks that every entry belongs to the wallet, the running balance matches each `balanceAfter` and never dips below 0, the sum of amounts equals the wallet's balance, and no consume was refunded beyond what it spent.

`reason` is a stable code (`task_execution`, same shape as audit reasons). `referenceId` is the caller's idempotency key (`[A-Za-z0-9._:-]`, 1 to 128 characters).

### Atomicity

`applyOperation()` is pure: given the operation and what the ledger holds, it returns the new wallet and the new entry, or a stable error. The store writes both, with the operation's audit event, in one transaction:

- Firestore: `runTransaction` reads the wallet, the entry id and, for a refund, the original consume and earlier refunds, then updates the wallet, `create`s the entry and `create`s the audit document. Any failure writes nothing.
- Memory: the writes are staged and applied only when the work completes.

There is never a wallet without its entry, an entry without its wallet change, or a movement without its audit event.

### Concurrency

Every operation reads and writes the organization's wallet document inside its transaction. Firestore serializes transactions that touch the same document (it retries the loser against the new balance), and the memory store runs one transaction per wallet at a time. So two consumes of 80 on a balance of 100 cannot both succeed: one is refused with `credits_insufficient`. Tests run this against memory and the Firestore emulator, with two and with many concurrent operations.

Entries of one wallet get strictly increasing timestamps (at least 1 ms after the wallet's last movement), so the ledger has one order.

### Idempotency

The entry id is `sha256(organizationId + "\n" + referenceId)`. The same operation therefore always lands on the same entry, and two organizations never share one.

- The same `referenceId` with the same type, amount, reason and refunded operation returns the stored entry with `replayed: true`. Nothing moves twice and no second audit event is written, also when the repeats arrive concurrently.
- The same `referenceId` with different parameters is refused with `credits_reference_conflict`, and nothing changes.
- A different `referenceId` is an independent operation.

### Operations

- **grant**: adds credits. It is a domain operation for server-side flows only. No client route reaches it, and no plan triggers it (D-12).
- **consume**: validates the tenant, the amount and the wallet, and refuses with `credits_insufficient` if the balance would go below 0. The balance never goes negative.
- **refund**: needs `refundOf`, the `referenceId` of an earlier `consume` of the same organization and wallet. The sum of its refunds can never exceed what it consumed, so a refund cannot create credits (`credits_refund_invalid`). It is idempotent like the rest.
- **adjustment**: exists only in the pure `applyOperation()`, with a signed amount, and is tested there. `CreditService` does not expose it and no route reaches it, because an adjustment needs an internal authority (an operator or a system actor) that does not exist yet. Adding one is a later decision.

Errors are stable codes: `unresolved_tenant`, `organization_inactive`, `invalid_amount`, `invalid_reference`, `invalid_reason`, `credits_wallet_missing`, `credits_insufficient`, `credits_balance_limit`, `credits_reference_conflict`, `credits_refund_invalid`.

### Tenant isolation

Every operation takes a `TenantContext` issued by `resolveTenant()` and uses its organization; anything else is `unresolved_tenant`. An organization id, wallet id or balance in a body, query or header is never read. A suspended or revoked membership gets no context; an organization suspended after its context was resolved gets `organization_inactive`. Entry ids include the organization, and a refund must point at the same organization's wallet, so one organization can never read, spend or refund another's credits. GIA acting for a user gets exactly that user's access, and is recorded as `via: gia`.

### RBAC

New permission `credits.read`, given to `owner`, for the balance route. There is no `credits.consume` permission: no route consumes credits yet, and a permission is only added when something checks it (ADR-0019). The code that consumes credits will be checked with its own feature permission. No grant, adjust or admin permission, and no new role.

### API

`GET /v1/organizations/:organizationId/credits`, through `withPermission('credits.read')`. It returns:

- `{ organizationId, status: 'present', balance, updatedAt }`, or
- `{ organizationId, status: 'unavailable', reason }`.

There is no route to grant, consume, refund, adjust, transfer or list the ledger; they answer 404. Query parameters, headers and bodies are ignored. Without a credit store the route answers 503 `credits_not_configured` (fail closed).

### Firestore

- `creditWallets/{organizationId}`: `walletId`, `balance`, `createdAt`, `updatedAt`. Keying by organization makes one wallet per organization, lets `create` refuse a second one, and gives every operation one document to lock on.
- `creditLedger/{entryId}`: `organizationId`, `walletId`, `type`, `amount`, `balanceAfter`, `referenceId`, `reason`, `refundOf`, `createdAt`. A top-level collection with the deterministic id makes idempotency a single read, and the entry is written with `create`, which never overwrites.
- Queries are single-field equality (`organizationId`, `refundOf`), which Firestore indexes automatically. No composite index and no Terraform change.
- Records are checked on read; a malformed wallet or entry is refused, never repaired.

### Audit

The existing AuditService records `credits.grant`, `credits.consume` and `credits.refund` (category `credits`), with the ledger entry as target (new target type `credit_entry`), the actor, the organization, the operation's `referenceId` (new optional field `reference`, a stored column) and its reason. Only real, successful operations are recorded, in the same transaction as the movement. Amounts and balances stay in the ledger: audit is not the ledger. Tokens, headers and bodies are never recorded. `credits.adjustment` is not in the catalogue yet, since nothing can run one. Refused operations are not audited yet, because there is no caller; the future caller will audit its own decision.

## Not in this change

Payment processing or any provider (Stripe, Mercado Pago, PayPal), checkout, invoices, taxes, money refunds, cards, webhooks; AI or media provider APIs (Gemini, OpenAI, Anthropic, Seedance, Kling, Meshy); metering, usage or provider cost tracking, monthly usage, overage; plan-based grants or any commercial credit values; transfers; an admin or billing UI; new roles; Terraform changes.

## Consequences

- Every organization has an empty wallet from creation, so later phases can grant and consume without a migration.
- The balance can always be rebuilt and checked from the ledger.
- Metering, when approved, will decide how much a task costs and call `consume` with a stable reference; a failed task can call `refund`. Neither needs to change this accounting.
- Setting credit values per plan (D-12) will be a grant flow with its own decision, not a change to the ledger.
