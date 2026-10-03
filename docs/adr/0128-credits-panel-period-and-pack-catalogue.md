# ADR-0128: The credits panel shows the plan period; packs carry their status (D-12, block 6)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0125](0125-plan-and-credits-panel.md), [ADR-0126](0126-credit-purchases-and-payment-router.md), [ADR-0127](0127-plan-periods-renewal-and-credit-policy.md)

## Context

The owner wants a person to understand their credits at a glance:

- "Tu plan incluye X créditos. Has usado Y. Te quedan Z."
- "Necesitas más créditos."
- Two choices: [Comprar créditos] or [Ver mi plan], and never a forced upgrade.

The panel must show:

- the plan;
- included, consumed, reserved and purchased credits;
- the available balance;
- the next renewal;
- usage by agent and by function;
- the consumption history.

Credit packs must record a package id, credits, price, currency, status, purchase date, transaction, tenant and the credits actually credited. The catalogue stays empty until prices are decided.

## Decision

1. **Panel (`/ai-usage`, "Plan y créditos").**
   - Once the wallet has a period (ADR-0127), the panel opens with the sentence above, built from the period's included and consumed credits and the available balance.
   - It adds "Consumidos en este periodo" and the date of the next renewal. "Sin definir todavía" remains only before the first renewal.
   - It lists the top agents and the top functions (capabilities) by credits this month.
   - It links to the operations history on the same page.
   - "Comprar créditos" stays disabled with its explanation while no pack and no payment provider exist.
2. **Out of credits.** The message now reads "Necesitas más créditos: esta acción no se ejecutó." and shows what is available, with two buttons: "Comprar créditos" and "Ver mi plan". Both open the plan and credits panel, and it says no plan change is needed. Nothing buys, upgrades or retries by itself.
3. **Packs.** `CreditPack` gains `status` (`active` | `retired`), and only active packs are on sale. A fulfilled `CreditPurchase` records `credited` (ledger entry, credits, time) next to the existing pack id and version, credits, price and currency, status, provider transaction (`paymentRef`), organization and creation date. `CREDIT_PACKS` stays empty.

## Not done here

- The cost preview "Esta acción utilizará aproximadamente X créditos" needs the AI gateway's estimate to reach the screen. It is the next block.
- Checkout routes and screens wait for packs, prices and a payment provider.

## Consequences

Web and domain only: no route, index, migration or Terraform. Purchase documents gain an optional `credited` field. Purchases written before it read as before.
