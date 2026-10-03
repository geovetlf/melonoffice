---
name: evals
description: Run, extend or compare MelonOffice agent evals (G-4) when a prompt, the agent task wiring or a model route changes.
---

# Agent evals

The cases and scoring live in `packages/evals` (ADR-0134). Scoring is deterministic: `parseAgentAnswer` plus the Guardian. There is no judge model.

## In CI (free)

The same 36 cases run against scripted models:

```sh
pnpm --filter @melonoffice/evals test
```

Run this before any PR that changes a prompt, `agentTaskMessages`, the Guardian or routing.

## Real runs (DEV only, costs credits)

A coding agent never runs these: there is no Google Cloud access from the agent's container, and they spend real credits. The owner runs them in Cloud Shell, with steps in `docs/evals/README.md`.

- The budget is capped at 70 credits per run (`EVAL_MAX_BUDGET_CREDITS`). A full run on Gemini 2.5 Flash-Lite costs under 1.
- Node 22 is required (`nvm use 22`).
- `cli.js compare baseline.json current.json` returns `accept` or `revert`. A change that reverts does not ship.

## Adding a case

1. Add it in `packages/evals/src/cases.ts`, about the same invented business. Never use real customer data.
2. Changing cases changes the dataset digest, so every model report in `docs/evals/reports/` goes stale. Say so in the PR.
3. Prove the scorer catches the failure: add a scripted bad answer in `evals.test.ts` that must fail.
