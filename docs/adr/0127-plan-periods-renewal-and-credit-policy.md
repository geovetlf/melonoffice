# ADR-0127: Plan periods, renewal and credit policy (D-12, block 5)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0022](0022-billing-foundation.md), [ADR-0123](0123-credit-core-buckets-and-holds.md), [ADR-0126](0126-credit-purchases-and-payment-router.md)

## Context

On 2026-10-03 the owner set the D-12 model: a monthly subscription gives the plan, its limits and its included credits; additional credits are bought on top when needed, without changing plan. Both live in the one wallet and ledger of ADR-0123.

The owner decided:

- included credits are spent first, then bought credits, and this must stay configurable;
- bought credits are never lost;
- included credits must support expiry and rollover per plan, with no commercial policy fixed yet;
- renewal must be idempotent: one period never grants its included credits twice;
- no amounts, prices or provider are fixed yet.

Until now there was no period: a subscription had a start and a status, and nothing ever granted included credits.

## Decision

1. **Monthly periods from the subscription's start.** Each period begins on the same day of the month as the subscription did, on the last day of a shorter month (`monthlyPeriodAt`). No new field on the subscription; a payment provider can later supply its own periods through the same renewal.
2. **A renewal is one ledger entry, once per period.**
   - A new entry type, `renewal`, with reference `renewal:<period start>`. A retry, a second API instance or a concurrent read replays the first renewal, even if the plan's values changed in between.
   - It adds the period's included credits and removes the previous period's included credits that do not carry over. Its amount is `granted − expired`, and may be 0 or negative.
   - It records `granted`, `carried`, `expired` and the period on the entry, and is audited as `credits.renewal` by the runtime for the tenant's user.
   - Periods only move forward (`credits_renewal_out_of_order`), and a period is never renewed before it starts.
3. **Never lost by renewal:**
   - bought credits;
   - credits held by running operations: they stay until those operations close;
   - included credits a wallet had before its first renewal, since no plan period gave them.
4. **The wallet knows its period.** `wallet.period` holds the start, the next renewal, the included credits it started with, and what it spent (consumes, less refunds). The API's `GET /credits` returns it as `period: { startsAt, renewsAt, included, consumed }`, or `null` before the first renewal.
5. **The plan decides the amounts, through entitlements.**
   - `credits.monthlyIncluded` sets the credits per period.
   - `credits.rollover` turns carry-over on.
   - `credits.rolloverMax` (new) caps how many carry over; `unlimited` carries all.
   - Unset values deny, as every entitlement does: 0 included and nothing carried, so a renewal adds nothing today. `unlimited` included credits are refused rather than turned into a number.
6. **Renewal runs when credits are used.** The first credits read, hold or spend of an organization in a new period renews it (`ensureCurrent`), through the API's credit routes and the AI gateway's credit port. It only runs while the plan is in force, and it remembers each organization's current period, so most calls read nothing. A failed renewal never blocks the read or the spend; it is retried on the next one. The worker does not renew: by design it does not read billing, so an organization's period is renewed by its first credit use through the API (any GIA, assisted AI or panel read). A scheduled renewal can be added if autonomous agents need it before anyone opens the app. No scheduled job, index or migration is needed now.
7. **The Agent Engine checks what it can spend.** The Harness's credit check before an agent works uses the available credits (balance less what running operations hold), the same figure the AI gateway holds against.
8. **Consumption order is configuration.** `createCreditService({ consumptionOrder })` defaults to `DEFAULT_CONSUMPTION_ORDER` (included, then purchased), as the owner decided for now. An order that does not name each bucket once is refused at startup.

## Still pending (not decided here)

- The included credits per plan, and every rollover value.
- Prices, packs and the credit/USD commercial equivalence.
- The payment provider. Once one is connected, renewal may follow its paid periods instead of the subscription's start.
- What happens to included credits when a subscription is `past_due` or canceled. Nothing renews while the plan is not in force.

## Consequences

- Wallet documents gain `period`; ledger entries gain `renewal`. Old wallets read as before, and their first renewal keeps what they hold, so no data is rewritten.
- `verifyLedger` replays renewals and checks `granted − expired` against each entry's amount.
- In DEV, each organization gets one `renewal` entry of 0 credits the first time its credits are read, then one a month.
