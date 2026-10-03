# MelonOffice: rules for coding agents

This file is for engineering assistants working in this repository, such as Claude Code. The product never reads it: MelonOffice runs without Claude Code, and a test forbids product code from calling Anthropic (`apps/worker/src/transport.test.ts`). Start with [CONTRIBUTING.md](CONTRIBUTING.md), which has the setup, commands and guardrails enforced by lint.

## Hard rules

- **Extend, never duplicate.** There is one Agent Engine, one Company Brain, one permission system (RBAC + entitlements), one AI Gateway and one monitoring setup. A new need extends them; it never adds a second one.
- **The model path is fixed:** MelonOffice → Agent Engine → Model Router → Provider Adapter → Model. Providers are reached only through their adapter package (`packages/ai-*`).
- **Never trust the browser** for permissions, credits or approvals. The API checks all three.
- **Tenant isolation is mandatory.** Every read and write is scoped to an organization, and tests cover cross-tenant access.
- **Never invent data**: no prices, credit amounts, plan allotments or business facts. Missing decisions resolve to deny or zero.
- **No plan names in code** (ADR-0007). Ask for entitlements, limits, features or permissions.
- **No new visual system.** Use `packages/ui` and the existing components; do not add Tailwind, shadcn or similar.
- **The worker must not depend on `@melonoffice/billing`.**
- **Never disable, skip or weaken a test** to get CI green. Find the cause.

## Environments

- DEV (project `melonoffice`) is the only environment a change may touch. Staging and production change only with the owner's explicit approval.
- Terraform: write it, `fmt`, `validate`, run the module tests (`terraform test` in `infra/modules/environment`) and let CD's read-only plan show the change. Never apply; the owner applies in Cloud Shell.
- No data migrations without explicit approval.

## Changing things safely

- **Prompts.** Changing the text of a prompt means bumping its `promptRef` version and appending its new digest in `apps/api/src/prompts-catalogue.test.ts` (ADR-0133). The list is append-only.
- **Agent behaviour.** Run the evals in CI mode before opening the PR (see `.claude/skills/evals`).
- **Models.** A model that may serve outside DEV needs a passing eval report (see `.claude/skills/new-model`).
- **Agent checks.** New team review checks go in `auditAgents` (see `.claude/skills/agent-audit`).
- **Records with versions.** Where an update compares `expectedUpdatedAt`, the new `updatedAt` must be strictly later than the previous one, even in the same millisecond (see `apps/api/src/resellers.ts`).
- **Architecture decisions** get an ADR in `docs/adr/` before or with the code.

## Before pushing

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm validate
```

`validate` runs format check, lint, typecheck, tests and build. Tests that use Firestore need the emulator on that port.
