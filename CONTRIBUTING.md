# Contributing to MelonOffice

## Workflow

1. Branch from `main`.
2. Open a pull request into `main`. CI must be green and the change reviewed before merge.
3. Never force-push or rewrite history on shared branches.
4. Record significant architecture decisions as ADRs in `docs/adr/` before implementing them.

## Local setup

Requirements: Node 22 (see `.nvmrc`) and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm validate   # format check, lint, typecheck, tests, build
```

Useful commands:

| Command                                | What it does                                  |
| -------------------------------------- | --------------------------------------------- |
| `pnpm lint`                            | ESLint, including the architecture guardrails |
| `pnpm typecheck`                       | TypeScript in every package                   |
| `pnpm test`                            | Vitest in every package                       |
| `pnpm build`                           | Builds every package and app                  |
| `pnpm --filter @melonoffice/web dev`   | Runs the web app locally                      |
| `pnpm --filter @melonoffice/api start` | Runs the built API (after `pnpm build`)       |

## Architecture guardrails

These are enforced by lint and tests. See the ADRs for the reasoning.

- **No plan-name logic (ADR-0007, D-25).** Never compare or switch on plan names (`entrepreneur`, `business`, `corporate`, `emprendedor`, `empresa`, `corporativo`) or on a plan id. Ask for entitlements, limits, features or permissions instead.
- **No fixed number of specialists (ADR-0006, D-12a)** and **no fixed list of departments (ADR-0005, D-11).** Departments, roles and skills are catalogue data.
- **Layering.** `packages/domain` imports nothing. Browser code (`apps/web`, `packages/ui`, `packages/i18n`) cannot import server code. Packages never import applications. Workspace packages are imported by name, not by path.
- **No hard-coded user-visible text.** All UI text comes from the i18n catalogs, which must contain the same keys in every language.
- **No secrets in the repository.** Configuration comes from environment variables; CI runs a secret scan.

## Workspace layout

```
apps/web            React + Vite single-page app (melonoffice.io)
apps/api            HTTP API service
apps/worker         Background jobs service
packages/config     Shared TypeScript, ESLint and Vitest configuration, custom lint rules
packages/domain     Pure domain types
packages/i18n       Message catalogs and i18n helpers
packages/ui         Design tokens and base components
packages/observability  Structured logging for server services
docs/adr            Architecture decision records
```

Workspace packages expose their TypeScript sources through the `@melonoffice/source` export condition, used by type checks, tests and Vite. Node uses the compiled `dist` output at runtime.
