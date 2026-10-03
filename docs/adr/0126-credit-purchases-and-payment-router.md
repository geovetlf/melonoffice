# ADR-0126: Credit purchases and the Payment Router (D-12, block 4)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0123](0123-credit-core-buckets-and-holds.md), [ADR-0091](0091-manual-commercial-operations-and-credit-grants.md)

## Context

The monetization model is a subscription plus additional credits that are bought separately. Buying credits never forces a plan change, and it is not pure pay-per-use. Packs and prices are not decided yet, and no payment provider is connected. The base must still be in place, so that a provider (card, local methods, dLocal) can be added without a second credit system.

## Decision

1. **Packs are configuration.** A pack has an id, a version, a number of credits, and a price in minor units of an ISO currency. Floats are never used. `CREDIT_PACKS` is empty until the owner decides sizes and prices, so nothing is on sale.
2. **The Payment Router is a port.** `PaymentProvider.createCheckout` opens a checkout. `createPaymentRouter` picks the first provider that charges the pack's currency. There are no providers yet, so starting a purchase is refused with `payments_unavailable`. A provider's adapter verifies its own signed notifications and hands on a `VerifiedPayment`; the core never trusts a raw webhook.
3. **A purchase.**
   - `start` creates one purchase per organization and request key. A double click or a retry opens one checkout, and nothing is credited yet.
   - The person sees the pack's price and their balance before confirming. That screen comes with the first provider.
4. **Credits arrive once, after payment.**
   - `confirm` checks that the provider, currency and amount match the purchase.
   - The credits are added to the `purchased` bucket of the same wallet with reference `purchase:<id>`, so the ledger itself refuses a second credit. Repeated webhooks, concurrent workers and a crash between the credit and the status change are all safe.
   - A declined attempt leaves the purchase open, because the buyer may pay again on the same checkout.
   - A payment that does not match closes the purchase as `failed`, for a person to review. Nothing is credited.
5. **Audit.**
   - `credits.purchase_started` (success or denied);
   - `credits.purchase` (the credit itself, with the buyer as the one who started it);
   - `credits.purchase_failed`.
6. **Storage.** The collection is `creditPurchases/{id}`, read by id only. There is no index, no Terraform and no migration.

## Pending product decisions

- Pack sizes, prices and currencies.
- The first payment provider and methods (card, local methods, dLocal).
- Taxes and invoices.
- Refunds of purchased credits.
- Whether purchased credits ever expire. Today they do not.

## Not in this block

- No API route or screen to buy yet. With no packs and no provider, they would only refuse. They come with the first provider.
- The manual grant by the platform administrator (ADR-0091) stays as it is, for courtesy, support and testing.
