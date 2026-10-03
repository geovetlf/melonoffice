---
name: new-model
description: Add a model or provider to MelonOffice's AI Gateway catalogue and pass the model gate (G-5) before it may serve outside DEV.
---

# A new model

Every provider is an adapter package (`packages/ai-vertex`, `packages/ai-deepseek`, `packages/ai-nvidia`) reached only through the AI Gateway and its Model Router. Never call a provider from product code.

## Steps

1. Add the model to its provider's catalogue with `environments: ['dev']` only, and with its prices from the provider's public price list. Never guess a price.
2. Run the adapter's tests and the evals in CI mode:
   ```sh
   pnpm --filter @melonoffice/ai-vertex test   # or the provider's package
   pnpm --filter @melonoffice/evals test
   ```
3. The owner runs a pinned eval in Cloud Shell and writes its report (`docs/evals/reports/README.md`). The PR commits the report file.
4. Only then may the catalogue allow `staging` or `prod`. `packages/evals/src/gate.test.ts` fails CI for any model allowed outside DEV without a report that:
   - matches the current prompt and dataset;
   - has every case answered;
   - passes at least 90% of the cases (ADR-0135).

A new provider package must also be added to `gate.test.ts`, and needs an ADR plus the owner's approval.
