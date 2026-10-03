# ADR-0124: AI calls hold their credits before the provider is called (D-12, block 2)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0027](0027-ai-gateway-and-provider-registry.md), [ADR-0081](0081-customer-credit-pricing.md), [ADR-0123](0123-credit-core-buckets-and-holds.md)

## Context

The AI Gateway checked the balance, called the provider, and charged the real cost afterwards. Two calls could both pass the check and then not both be paid for. A long task could also start with credits that another operation was about to spend.

ADR-0123 added holds to the one wallet and ledger. Every model call in MelonOffice goes through the gateway: Agent Engine, GIA, conversations, Marketing, Design, Documents and Content. Wiring the gateway therefore covers every AI action.

## Decision

1. **Reserve, run, settle.** After routing and pricing, the gateway holds the most any allowed candidate may cost (`ai:<requestId>`, 30 minutes). Only then is a provider called.
   - The hold is refused when the available balance (balance less other holds) cannot cover it. The call is then denied with `credits_insufficient` and no provider is called.
   - On a checked answer, the gateway settles the real cost, which frees the rest. A free answer releases the hold.
   - On every other end (provider failure, an answer that could not be charged, a thrown error), the hold is released. If the release itself fails, the hold expires by itself.
2. **Never charged twice.** A settle is fixed to its hold (`ai:<requestId>:close`), so a retried request, a duplicate worker or a resumed task replays the first charge. Streaming follows the same path.
3. **Checks use what is available.** The gateway's and the forecasting engine's balance checks count only credits no other operation holds.
4. **Ports without holds keep working.** `hold`, `settle` and `release` are optional on the gateway's credits port. Test doubles without them keep the old check-then-charge path. The API and the worker pass the Credits engine itself, which has them.

## Not in this block

- **A task-level hold** (a task's `maxCredits`) is not added. Each call of a task holds its own estimate, and the harness keeps enforcing the task's cap. Holding the whole cap up front would also block the task's own calls.
- **Forecast runs** keep their fixed price, checked when queued and charged on completion. They do not hold yet.
- **Showing the estimate** before an action ("this will use about X credits") belongs to the usage and out-of-credits work (D12-3).

## Consequences

- No new collection, index, Terraform or migration.
- Each AI call writes a `hold` entry (amount 0) and a closing entry. The audit log shows `credits.hold`, then `credits.consume` or `credits.release`.
