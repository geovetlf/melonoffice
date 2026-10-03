# ADR-0123: Credit core v2: included and purchased credits, and holds (D-12, block 1)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0023](0023-credits-foundation.md), [ADR-0091](0091-manual-commercial-operations-and-credit-grants.md)

## Context

D-12 (plans and billing) needs one financial core for all of MelonOffice: Agent Engine, GIA, Marketing, Design, Documents, Content and Automations. It must know, for each organization:

- the balance;
- what the plan includes;
- what was bought;
- what was consumed, reserved, released and refunded;
- the history of every movement.

The wallet and ledger of ADR-0023 already give one balance, an append-only ledger and idempotency per reference. But they cannot tell plan credits from bought ones. They also cannot set credits aside while an operation runs, so today an AI call checks the balance, runs, and charges afterwards. Two operations can both pass the check and spend the same credits, and nothing reserves a maximum before a long task.

There must not be a second credit system, so this extends the same wallet and ledger.

## Decision

1. **Two buckets in the same wallet.** `included` holds the credits that come with the plan. `purchased` holds credits bought on top, or granted by hand. They always add up to `balance`.
   - A grant names its bucket. Without one it goes to `purchased`, which is what every existing grant (manual, testing, courtesy) means.
   - A consume records in `split` how much it took from each bucket. A refund records in `split` what it gave back, bought credits first.
   - An adjustment moves `purchased` only.
2. **No migration.** A wallet written before D-12 has no buckets, and all of its balance reads as `purchased`. Its next movement writes the buckets. Old entries without a bucket or split count as `purchased` when the ledger is checked. No document is rewritten in bulk.
3. **Holds.**
   - `hold` sets credits aside for an operation that is about to run. It is a ledger entry with amount 0, and the balance does not move. The wallet keeps the open hold, with its expiry.
   - `settle` closes the hold with the real cost. It spends that amount and frees the rest. It is recorded as a `consume` with `holdOf`.
   - `release` closes it without spending anything. It is a ledger entry with amount 0.
   - Nobody can spend or hold credits that another live hold has set aside, so `available` = balance − live holds.
   - The settle may exceed its hold only when what is not held covers the difference.
4. **A hold is closed once.** The closing entry's reference is fixed by the hold's (`<hold>:close`), so:
   - retries, timeouts, a duplicate worker or a resumed task replay the first close;
   - a different close (another amount, or a release after a settle) is refused with `credits_hold_closed`;
   - concurrent closes serialize on the wallet, and only one is written.
5. **Holds expire.** A hold lasts at most 7 days. Once expired it holds nothing and is dropped on the next write. It can still be settled later, but only if the available balance covers the cost. A wallet keeps at most 200 open holds.
6. **One view of the balance.** `balanceOf` and `GET /v1/organizations/:id/credits` return balance, included, purchased, reserved, available and updatedAt. There is still no route that moves credits.
7. **Audit.** Two new actions, `credits.hold` and `credits.release`. A settle is audited as `credits.consume`, like any spend. Amounts stay in the ledger.

## Pending product decisions (not made here)

These are documented, not decided. The code keeps a neutral default that the decision can change without a migration.

- **Consumption order.** The provisional default is `included` first, then `purchased` (`CONSUMPTION_ORDER`), so bought credits last longest. The owner has not decided this yet.
- **Expiry or rollover of included credits** at renewal (entitlement `credits.rollover`). Nothing expires today, and no renewal grants or removes anything.
- **Credits included per plan** (`credits.monthlyIncluded`) and every price: still pending. They resolve to 0 or deny.
- **Expiry of purchased credits.** None.

## Consequences

- Every module can reserve a maximum before it runs and pay only the real cost, on the same wallet. Wiring the AI gateway, forecasting and the harness to this flow is the next block (D12-2).
- `verifyLedger` also replays the buckets entry by entry, and reports `buckets_mismatch`.
- No new collection, index or Terraform. Wallet documents gain the optional fields `buckets` and `holds`; ledger entries gain `bucket`, `split`, `held`, `expiresAt` and `holdOf`.
