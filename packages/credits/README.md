# @melonoffice/credits

The credits foundation ([ADR-0023](../../docs/adr/0023-credits-foundation.md)): one wallet per organization and an append-only ledger, with atomic, concurrent-safe and idempotent operations. A credit is an internal whole unit, not money. Server only, with no HTTP.

- `ledger.ts`: amount, reference and reason checks, `openWallet()` (always empty), deterministic entry ids, the pure `applyOperation()` that decides every movement, including the not-yet-executable adjustment, and `verifyLedger()`.
- `store.ts`: the `CreditStore` port, whose `transact()` writes the wallet, the entry and the audit event together or not at all, and a memory implementation for tests.
- `service.ts`: `createCreditService()`, with `balanceOf`, `grant`, `consume` and `refund` on a resolved `TenantContext`. There is no adjustment or transfer.
- `errors.ts`: the stable error codes (`credits_insufficient`, `credits_reference_conflict`…).

Credits decides no capability (entitlements), knows no plan or price (billing, D-12), measures no usage (metering) and calls no payment or AI provider. No plan grants credits; every wallet starts at 0.
