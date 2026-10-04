# ADR-0139: "Project this" in Reports (R-1)

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0059](0059-forecasting-engine.md) (Forecasting Engine), [ADR-0060](0060-business-metrics-and-reports.md) (business metrics and Reports)
- Roadmap: item 1 of "Next" in `docs/product/FEATURE-SURFACE-MAP.md`.
- Terraform: none. Firestore: none. Data migration: none. API: none.

## Context

The Forecasting Engine (ADR-0059) has an API, `POST /v1/organizations/:id/forecasts`, guarded by `forecast.run`, that charges credits through the existing wallet and answers with the projection, or with why it could not make one. Reports already shows each metric's history and whether it is enough to project (`readiness`). Until now the only way to ask for a projection was through GIA.

## Decision

1. **A button on each ready metric card.** "Project the next 7 days" (4 weeks, 3 months, by the card's frequency) appears only when the person has `forecast.run` and the metric's history is ready. The browser only hides the button; the API still checks the permission, the credits and the history.
2. **Nothing runs by itself.** Opening Reports never calls the engine, so it never spends credits. One click sends one request with `wait: true`, for the card's metric, entity and frequency.
3. **The answer is labelled as a projection.** Each period shows the value and its likely range. A note says it came from the recorded history and is not a record, whether the model or the fallback made it, and how many credits it used, as the API reported them.
4. **Refusals are explained.** Not enough credits, the monthly limit, the model unavailable and no price set each have their own message; anything else has a generic one. A pending projection or one with too little history shows a warning, not an error.
5. **No new system.** It is the same forecasts API, the same permission, the same wallet and the same `packages/ui` components. No horizon, price or credit amount is set in the browser beyond the default horizon per frequency, which is within the engine's maximum.

## Consequences

- People with `forecast.run` can project a metric from Reports without asking GIA. GIA still works the same way.
- The fake backend in `apps/web/src/identity/testing.ts` answers forecasts, and `apps/web/src/reports/reports.test.tsx` covers the button, the request it sends, the permission and readiness gates, a refusal and too little history.
