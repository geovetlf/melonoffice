# ADR-0129: A refusal for credits says about how many the action needed (D-12, block 7)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0124](0124-ai-calls-hold-their-credits.md), [ADR-0128](0128-credits-panel-period-and-pack-catalogue.md)

## Context

The owner wants a person to read "Esta acción utilizará aproximadamente X créditos" and "Necesitas más créditos". When credits refused an AI request, the gateway already knew what each candidate model would cost, but it only returned a code, so the screen could not say how many credits were missing.

## Decision

1. **The gateway's refusal carries an estimate.** For `credits_insufficient` and `credit_limit_exceeded`, the denied response adds `estimatedCredits`: what the cheapest model that could serve the request would cost, from the same pricing the hold uses (ADR-0124). It is an estimate, never a charge. Nothing was held or spent.
2. **GIA and assisted AI pass it on.**
   - `GiaError` and `ConversationError` gain an optional `estimatedCredits`.
   - The API adds it to the `ai_credits_insufficient` body of `POST /gia/messages` and of assisted AI on a conversation. No other refusal carries it.
3. **The screen shows it.** The out-of-credits message adds "Esta acción utilizaría aproximadamente X créditos." when the API sent an estimate, then the balance and the "Comprar créditos" and "Ver mi plan" buttons (ADR-0128).

## Not done here

A preview before running an action, with no refusal, needs an estimate route per capability. That waits until an action exists whose cost a person should confirm first.

## Consequences

No ledger, route, index or migration change. The value is a whole number of credits and says nothing about providers, models or internal cost.
