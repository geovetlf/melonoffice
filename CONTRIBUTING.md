# Contributing to MelonOffice

## Workflow

1. Branch from `main`.
2. Open a pull request into `main`. CI must be green and the change reviewed before merge.
3. Never force-push or rewrite history on shared branches.
4. Record significant architecture decisions as ADRs in `docs/adr/` before implementing them.

## Local setup

Requirements: Node 22.22.2 or a later 22.x (see `.nvmrc`; jsdom needs at least 22.22.2 and `engine-strict` refuses to install below it) and pnpm (version pinned in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm validate   # format check, lint, typecheck, tests, build
```

Tests that use Firestore need its emulator on `127.0.0.1:8085`, the version CI pins in `.github/workflows/ci.yml` (it needs Java 21):

```sh
java -jar cloud-firestore-emulator-v1.22.0.jar --host 127.0.0.1 --port 8085 &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm validate
```

### Visual checks

The web app has a preview with representative data (`apps/web/preview.html`, scenarios in `apps/web/src/preview/`), and scripts in `apps/web/scripts/` that drive it in Chromium through `@playwright/test`. Start the preview server, then run them from `apps/web`:

```sh
pnpm --filter @melonoffice/web exec vite --port 5198
node scripts/capture-pages.mjs <out-dir>   # every page at 1440, 1024, 768 and 390; fails on sideways scroll
node scripts/capture-home.mjs <out-dir>    # the Home and its keyboard and phone states
node scripts/audit-a11y.mjs <out-dir>      # axe WCAG 2.2 AA, target sizes, overflow, one h1, Home motion
```

Set `CAPTURE_CHROMIUM_PATH` to a Chromium binary when Playwright's own is not installed. These scripts are not part of `pnpm validate`.

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
