# MVP launch readiness

Status on 2026-10-12, from the launch readiness sprint. This page is the single place that says what MelonOffice can do today, what was verified and how, and what still stands between the code and a commercial launch. Update it in the pull request that changes any line of it.

**Verdict: not ready to launch.** The core product works end to end in tests and is deployed to DEV, but production has no application deployment, no payment path, no backups and no verification in a real environment. The blockers are listed in [Production blockers](#production-blockers) and reduced to owner actions in [What the owner must do](#what-the-owner-must-do).

## How to read the statuses

| Status                   | Meaning                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `PASS_VERIFIED`          | Implemented, and a test we can name exercises it through the API (memory and the Firestore emulator) or the web app. |
| `IMPLEMENTED_UNVERIFIED` | The code is there; a real check (DEV, a provider, an end-to-end run) is still missing.                               |
| `INCOMPLETE`             | Partly implemented.                                                                                                  |
| `BLOCKED_OWNER`          | Needs a decision, a value or an authorization from the owner.                                                        |
| `NOT_IMPLEMENTED`        | Does not exist yet.                                                                                                  |
| `DEFERRED_POST_MVP`      | Not needed for the agreed launch.                                                                                    |

`PASS_VERIFIED` here never means "verified in DEV or production": Claude's sessions cannot reach DEV or Google Cloud. Every DEV check is listed for the owner in [DEV checks](#dev-checks-for-the-owner).

## MVP scope

One product core sold three ways (Direct, Reseller, White Label), with:

- sign-in, creating an organization and describing the business;
- GIA, the executive assistant, answering from the company's own data within the person's permissions, and preparing tasks, follow-ups, team work and automations that run only after the person confirms;
- departments with AI agents (specialists) that hold one role and versioned skills, and whose tools pass the Tool Gate, approvals and runtime guards;
- Company Brain (company memory, documents, business profile);
- Comercial: contacts, opportunities, follow-ups, conversations (WhatsApp in DEV);
- automations: workflows, plans, approvals, executions, recurrence (owned by the engine thread "Diagnóstico del Agent Engine");
- credits (1 credit = US$0.01, D-12a) consumed by AI calls, with a ledger, refusals on low balance and platform grants;
- partner, reseller, white-label and platform consoles, with passkeys for administrators.

Out of the MVP until the owner decides: J1 (journeys), voice, calendar and email channels, payments and credit packs, plans' commercial values, B7, further providers.

## Capability inventory

| Area                                                         | Status                                                   | Evidence                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in, Identity Platform tokens, recent sign-in            | `PASS_VERIFIED`                                          | `packages/auth` tests, `apps/web/src/App.test.tsx`, `apps/api/src/*` auth cases                                                                              |
| Passkeys for administrators (ADR-0188)                       | `PASS_VERIFIED` locally, `IMPLEMENTED_UNVERIFIED` in DEV | `apps/api/src/passkeys.test.ts`; counters only go forward (#225); the owner has not added a passkey in DEV yet                                               |
| Create an organization                                       | `PASS_VERIFIED`                                          | `apps/api/src/tenancy*.test.ts`, `App.test.tsx`                                                                                                              |
| More than one member per organization                        | `NOT_IMPLEMENTED` / `BLOCKED_OWNER`                      | only the `owner` role exists (`packages/rbac/src/roles.ts`); no member routes. Needs a product decision and ADR                                              |
| Choose between several organizations                         | `NOT_IMPLEMENTED`                                        | the web app always uses the first membership (`AuthProvider.tsx`)                                                                                            |
| Tenant isolation and RBAC on every route                     | `PASS_VERIFIED`                                          | `withPermission` on every `/v1/organizations/:id` route; 46 of 60 API test files use a second user or organization; Front D found no IDOR                    |
| Business profile and company memory                          | `PASS_VERIFIED`                                          | `business.test.ts`, `memory.test.tsx`                                                                                                                        |
| GIA chat with context and permissions                        | `PASS_VERIFIED`                                          | `apps/api/src/gia.test.ts`, `apps/web/src/gia/*.test.tsx`                                                                                                    |
| GIA proposals (task, team work, follow-up, automation offer) | `PASS_VERIFIED`                                          | `giaAgentTask.test.tsx`, `followUps.test.tsx`, `workflowDrafts.test.tsx`; leaving the chat and coming back no longer re-offers a confirmed proposal (#221)   |
| GIA never says something was done before it was              | `PASS_VERIFIED`                                          | every "sent/saved/scheduled" message is shown only after the API returned the record (Front B)                                                               |
| Agents, departments, skills and versions                     | `PASS_VERIFIED`                                          | agent and structure tests; skills and tool grants are owned by the thread "Architecture plan for MelonOffice"                                                |
| Tool Gate, approvals, guardrails, audit                      | `PASS_VERIFIED`                                          | `tools.test.ts`, `plans.test.ts`; approval read errors fail closed                                                                                           |
| Workflows, plans, executions, B6 writes, recurrence, sweep   | owned by the engine thread                               | see that thread and ADR-0178 to ADR-0187; open item below                                                                                                    |
| Unconfirmed external effect (outcome unknown)                | `BLOCKED_OWNER`                                          | a step whose result is unknown shows "running" and later "failed"; no screen says the outcome is unknown. Waiting on the owner's card in the engine thread   |
| Credits ledger, holds, refusals, idempotency                 | `PASS_VERIFIED`                                          | `packages/credits` (111 tests), `packages/firestore/src/credits.test.ts`; same key gives one entry; balance never below zero                                 |
| Balance shown after spending                                 | `PASS_VERIFIED`                                          | the top bar re-reads the balance after GIA answers or drafts (#221)                                                                                          |
| Plan limits enforced                                         | `INCOMPLETE` / `BLOCKED_OWNER`                           | only integrations and credit renewal limits are checked; `storage.bytesMax`, `documents.maxFileBytes`, `agents.*`, `automations.*` have no values or callers |
| Credit purchase, packs, payment provider, payment webhooks   | `NOT_IMPLEMENTED` / `BLOCKED_OWNER`                      | `CREDIT_PACKS = []`, no provider, no route (D-12 frozen)                                                                                                     |
| Ledger reconciliation                                        | `NOT_IMPLEMENTED`                                        | `verifyLedger` has no production caller; a failed AI-usage write is not recovered                                                                            |
| AI answer over 16,000 characters                             | `INCOMPLETE` (engine)                                    | the model call is charged once, then the answer is refused and the step fails; a manual or scheduled rerun charges again; the ledger's refund has no caller  |
| Plan cost estimate before approval                           | `BLOCKED_OWNER`                                          | no DEV plan has an estimate (neither the API nor the worker passes an estimator), so a "deny without estimate" rule would block every plan in DEV            |
| Worker kept free of billing                                  | `PASS_VERIFIED`                                          | the worker no longer loads `@melonoffice/billing` through `@melonoffice/firestore` (#228); a worker test walks the imports                                   |
| Billing (subscription read, plan in force)                   | `PASS_VERIFIED` (read only)                              | `apps/api/src/billing.ts` tests; no plan change or invoice route                                                                                             |
| Comercial: contacts, opportunities, follow-ups               | `PASS_VERIFIED`                                          | API and web tests; links that only change the page's query now open what they name (#224)                                                                    |
| WhatsApp channel and templates                               | `IMPLEMENTED_UNVERIFIED`                                 | DEV only; templates were never wired in deployed servers until #222; not tested against Meta                                                                 |
| Conversation agents' settings                                | `INCOMPLETE`                                             | the API routes exist; no screen turns them on                                                                                                                |
| Forecasts (TimesFM)                                          | `IMPLEMENTED_UNVERIFIED`                                 | tested with a fake model; DEV activation report in the project files                                                                                         |
| Partner, reseller, white label, platform consoles            | `PASS_VERIFIED`                                          | `commercial.test.ts`, `resellers.test.ts`, `platform-operations.test.ts`; versions now always move on change (#225)                                          |
| Discount threshold, offers, contact changes by agents        | `BLOCKED_OWNER`                                          | decided in cards on 2026-10-12, not applied: the White Label thread waits for the owner's own words                                                          |
| J1 journeys                                                  | `BLOCKED_OWNER`                                          | blocked until the owner authorizes it                                                                                                                        |
| Voice, calendar, email, other providers                      | `DEFERRED_POST_MVP`                                      |                                                                                                                                                              |

## Integrations

| From → to                               | Status                   | Note                                                                                                     |
| --------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Web → API                               | `PASS_VERIFIED`          | every path the web clients call is a registered route (214 routes compared, Front A)                     |
| API → worker (Cloud Tasks)              | `IMPLEMENTED_UNVERIFIED` | each side is tested with a recorded scheduler; the live hop runs only in DEV                             |
| Agent Engine → AI Gateway → Vertex AI   | `IMPLEMENTED_UNVERIFIED` | real-model evals run in DEV by the owner only                                                            |
| GIA → workflow draft → plan → approval  | `PASS_VERIFIED`          | `workflowDrafts.test.tsx`, `plans.test.ts`                                                               |
| Plan → execution → result on screen     | `INCOMPLETE`             | one failed poll stops a plan's live view; failed step reads show as no steps (sent to the engine thread) |
| Integration Engine → WhatsApp Cloud API | `IMPLEMENTED_UNVERIFIED` | fake Graph API in tests                                                                                  |
| Credits ↔ AI usage events               | `INCOMPLETE`             | no reconciliation (above)                                                                                |
| Payments → credits                      | `NOT_IMPLEMENTED`        | no provider                                                                                              |

## Test results

- `FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm validate` (format, lint, typecheck, tests with the emulator required, build) passed locally on `main` at d828f5f before the sprint, and on each sprint branch before it was pushed.
- `main` turned red once after #221: `brain.test.ts` matched a price's digits inside a random id (CI run 38194025921). #222 fixed the test without weakening it; CI (run 38195267607) and CD (dev) (run 38195267592) were green on its merge, 018608f.
- #229's first CI run failed in an automations web test it does not touch (a timing race in `automations.test.tsx`, owned and fixed by the engine thread in #226); the one re-run passed.
- CI on `main` is green; every sprint pull request is merged only with "Lint, typecheck, test, build", "Terraform format, validate, test" and "Secret scan" green.
- Not run from here: real-model evals, DEV, Meta, Vertex AI, TimesFM in Cloud Run, a browser against DEV.

## Pull requests of the sprint

| PR      | What                                                                                                                                                 | State   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| #221    | GIA keeps what the person confirmed when they leave the chat; balance refresh; clear 403                                                             | merged  |
| #222    | Channel templates wired in production; CD (dev) runs CI's full gate; rollback doc; Brain test made deterministic                                     | merged  |
| #224    | A link to the page already open with another query opens what it names                                                                               | merged  |
| #225    | Versions strictly later on every versioned change; passkey counter; `PASSKEY_RP_ID` check; GIA plan summary permissions; follow-up cross-tenant test | merged  |
| #227    | Connections and sign-in say errors in words, never raw codes                                                                                         | merged  |
| #228    | The worker no longer loads billing                                                                                                                   | merged  |
| #229    | `/v1` refuses bodies over 1 MB (document uploads keep 10 MB)                                                                                         | merged  |
| this PR | This page and the README status                                                                                                                      | this PR |

The engine thread merged #219, #220 and #223 (ADR-0189) during the sprint.

## CI/CD and DEV

- CI (`ci.yml`): format, lint (with architecture rules), typecheck, tests with the Firestore emulator required, build, forecaster tests, Terraform fmt/validate/tests, environment isolation, gitleaks.
- CD (dev) (`cd-dev.yml`): on every push to `main`; a read-only Terraform plan, then build, deploy and health checks of web, api and worker, and a browser smoke test. From #222 it runs the same gate as CI before deploying.
- Last green CD (dev) before the sprint: d828f5f (2026-10-12 01:25Z). During the sprint, CI and CD (dev) were green on #222's merge (018608f) and on #225's merge (68c42a3, CI run 38197939242, CD run 38197939173); later merges' runs are listed in the final report. Whether DEV serves each revision with 100% traffic, its alerts and its indexes can only be checked by the owner (below).
- Staging and production hold infrastructure only; no deploy workflow exists for them.

## Production blockers

1. **No production deployment path.** There is no staging or production deploy workflow, and `deploy_apps` and `firestore_and_auth` are off outside DEV by design (`infra/scripts/check-environments.sh`). Needs the owner's authorization and apply.
2. **No backups.** Firestore has no point-in-time recovery and no scheduled backups (`infra/modules/environment/main.tf`); DEV has a manual export only.
3. **Alerts can notify nobody.** Without a budget, the six alert policies have no notification channel.
4. **No payments.** No provider, no packs, no webhook (D-12).
5. **Organizations have one member.** No way to add employees.
6. **Unconfirmed external effects** are shown as failed, inviting a repeat (engine thread, owner's card).
7. **Plan limits without values** for storage, documents, agents and automations; uploads have no quota (deny-by-default needs values first).
8. **Passkeys are bound to the DEV host.** Set `PASSKEY_RP_ID=melonoffice.io` and the production web origin before production.
9. **Disabled users keep access for up to an hour** (tokens are checked locally; no revocation check, no user status).
10. **Nothing verified in a real environment** by this sprint: every DEV check below is pending.

## What the owner must do

Configuration and credentials (names only, never values):

- production domain: `melonoffice.io` DNS, `WEB_ORIGINS`, `PASSKEY_RP_ID`;
- `IDENTITY_PLATFORM_PROJECT_ID` and the browser key `MELONOFFICE_IDENTITY_API_KEY` per environment;
- `PLATFORM_ADMIN_USER_IDS` for production;
- `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_LOCATION`; billing on the project (an AI call failing with "dunning" means unpaid billing);
- channel secrets in Secret Manager per connection (`channel-{connectionId}-app-secret`, `-access-token`, `-verify-token`) and `WHATSAPP_GRAPH_API_VERSION`;
- a monitoring notification channel (or a budget with one);
- for payments, after deciding a provider: its adapter, `PAYMENT_*` secrets per environment in Secret Manager, test and live accounts kept apart.

Decisions:

- members per organization and their roles;
- plan values: `credits.monthlyIncluded`, `credits.packsPurchasable`, `storage.bytesMax`, `documents.maxFileBytes`, `agents.*`, `automations.*`;
- credit packs and prices, payment provider, refund and chargeback policy (D-12);
- what the app shows and allows when a step's outcome is unknown (engine thread card);
- the discount threshold, offers and agent contact changes (White Label thread);
- whether passkeys become mandatory for administrators;
- J1;
- Firestore backups and PITR (an ADR and an apply).

## Disabled or deferred

- J1, B7, voice, calendar, email, other providers: blocked or deferred.
- Credit purchase: domain code only, no route.
- Conversation agents: on in the API, no settings screen.
- The microphone button on the Home bar is shown disabled.

## Residual risks

- A transient Firestore error while leasing a job is treated as a permission refusal, so the job is not retried (sent to the engine thread).
- A retried AI call with a fixed request id can call the provider again on a closed hold (sent to the engine thread).
- AI usage reports can undercount the ledger when a usage write fails (no reconcile).
- The Agent Guardian keeps a report built while the Brain was unreadable (sent to the engine thread).
- Other raw codes may still show in the partner console, the audit trail and approvals.
- A webhook delivery whose audit write fails is not audited again on the provider's retry.
- UX gaps found and not fixed in the sprint: every refusal of team work reads "not now"; "review the plan" opens the plan list, not the plan; a department that fails to load looks like one that does not exist; a configuration failure looks like "not configured"; some screen-reader labels are hard-coded in English; a few panels keep desktop minimum widths on phones.
- A disabled NVIDIA secret binding in Terraform would break the planner if it were applied as is; the operator's Workload Identity is broader than CD needs; `/health` does not say which optional parts are configured.

## Rollback

- DEV: route traffic to an earlier revision, or re-run `CD (dev)` on an earlier commit. After pinning a revision, send traffic back with `gcloud run services update-traffic <service> --to-latest` once the fix is deployed (see `docs/infrastructure/README.md`).
- Data: there is no automatic restore. A manual export (`Ops (dev)`) can be imported, and an import overwrites documents.
- Production: no procedure until production is deployed; it must exist before launch.

## DEV checks for the owner

Read-only, in Cloud Shell, with `P` the DEV project id, `R` the region and `N` the project number.

1. Every service serves its latest revision: `for s in web api worker forecaster; do gcloud run services describe $s --project $P --region $R --format='value(status.traffic)'; done`.
2. Indexes are ready: `gcloud firestore indexes composite list --project $P --format='table(name.basename(),state)'`.
3. No missing index at runtime: `gcloud logging read 'jsonPayload.message="firestore.index_missing"' --project $P --freshness=7d --limit 50`.
4. Alerts reach someone: `gcloud alpha monitoring policies list --project $P --format='table(displayName,notificationChannels.len())'`.
5. Backups: `gcloud firestore databases describe --database='(default)' --project $P --format='value(pointInTimeRecoveryEnablement,deleteProtectionState)'`.
6. Health: `curl -sS https://api-$N.$R.run.app/health`, and the worker refuses an anonymous call: `curl -s -o /dev/null -w '%{http_code}\n' https://worker-$N.$R.run.app/health` prints 403.
7. CORS refuses another origin: `curl -sSi -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' https://api-$N.$R.run.app/v1/me` has no `access-control-allow-origin`.
8. In the app (https://web-988106665456.us-central1.run.app): GIA proposes an agent task; confirm it, open the agent, come back to GIA: it says "sent" and offers nothing again; the top bar balance goes down after GIA answers.
9. In Connections (DEV, with a WhatsApp connection): the templates list loads instead of an error.
10. As an administrator in /partner or /platform: add a passkey, then an admin change asks to confirm with it.

## Acceptance criteria for launch

All of these, with evidence linked here:

1. CI green on `main` and the last `CD` green for the environment being launched.
2. A production deploy path approved by the owner and run once, with health checks green.
3. Backups (PITR or daily) on and one restore rehearsed outside production.
4. Alerts deliver to a person.
5. Each DEV check above done and recorded.
6. The owner's decisions above taken, or the capability left off and listed here as deferred.
7. A payment path, or a launch explicitly without paid credits.
8. No open P0 or P1 in this page.
