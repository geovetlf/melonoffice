# Architecture

The MelonOffice architecture was defined in the **Phase 0 Architecture Plan (v0.7, approved 2026-09-26)**, kept in the project's shared files at `melonoffice-plan/MelonOffice-Phase0-Architecture-Plan.md`. The decisions that bind this repository are recorded as ADRs in [`../adr`](../adr):

| ADR                                                                | Decision                                                  | Plan ref         |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ---------------- |
| [0001](../adr/0001-record-architecture-decisions.md)               | Record architecture decisions                             | —                |
| [0002](../adr/0002-modular-monolith-monorepo.md)                   | Modular monolith in a pnpm + Turborepo monorepo           | D-1              |
| [0003](../adr/0003-react-vite-spa.md)                              | React + Vite single-page app                              | D-2              |
| [0004](../adr/0004-git-baseline-and-licence.md)                    | Git baseline and proprietary licence                      | D-19             |
| [0005](../adr/0005-initial-departments.md)                         | Seven initial departments as catalogue data               | D-11             |
| [0006](../adr/0006-no-fixed-specialist-quantity.md)                | No fixed number of specialists                            | D-12a            |
| [0007](../adr/0007-plans-entitlements.md)                          | Plan → Entitlements → Limits → Features → Permissions     | D-25             |
| [0008](../adr/0008-entity-model.md)                                | Department → Specialist/Agent → Role → Skills → Tools     | D-28             |
| [0009](../adr/0009-one-main-specialty-per-specialist.md)           | One main specialty per specialist                         | D-29             |
| [0010](../adr/0010-initial-languages.md)                           | English and Spanish first, extensible i18n                | D-17             |
| [0011](../adr/0011-cloud-environments.md)                          | Separate dev, staging and production cloud projects       | D-5              |
| [0012](../adr/0012-dev-deployment-on-cloud-run.md)                 | Phase 1B infrastructure and dev deployment on Cloud Run   | D-5              |
| [0013](../adr/0013-entitlements-core.md)                           | Entitlements core                                         | D-25, D-12, D-22 |
| [0014](../adr/0014-firestore-and-identity-platform-in-dev.md)      | Firestore and Identity Platform in dev                    | D-6              |
| [0015](../adr/0015-least-privilege-terraform-planner.md)           | Least-privilege Terraform planner                         | Security review  |
| [0016](../adr/0016-auth-and-identity-foundation.md)                | Auth and identity foundation                              | D-6, D-25        |
| [0017](../adr/0017-user-persistence-in-firestore.md)               | User persistence in Firestore                             | D-6              |
| [0018](../adr/0018-tenancy-and-memberships.md)                     | Tenancy and memberships foundation                        | D-10, D-22       |
| [0019](../adr/0019-rbac-foundation.md)                             | RBAC foundation                                           | D-22, D-25       |
| [0020](../adr/0020-audit-log-foundation.md)                        | Audit log foundation                                      | D-25             |
| [0021](../adr/0021-entitlements-plan-and-capability-foundation.md) | Entitlements: plan and capability foundation              | D-25, D-12, D-22 |
| [0022](../adr/0022-billing-foundation.md)                          | Billing foundation: subscription and plan authority       | D-12, D-25       |
| [0023](../adr/0023-credits-foundation.md)                          | Credits foundation: wallet, ledger and atomic accounting  | D-12, D-25       |
| [0024](../adr/0024-execution-foundation.md)                        | Execution foundation: states, graph and version snapshots | D-28, D-25       |
| [0025](../adr/0025-departments-and-specialists.md)                 | Departments, specialists and the execution profile        | D-11, D-28, D-29 |
| [0026](../adr/0026-tools-approvals-and-guardrails.md)              | Tools, approvals and guardrails                           | D-28, D-25       |
| [0027](../adr/0027-ai-gateway-and-provider-registry.md)            | AI Gateway and provider registry                          | D-7, D-12, D-28  |
| [0028](../adr/0028-planner-delegation-and-workflows.md)            | Planner, delegation and workflow foundation               | D-7, D-12, D-27  |
| [0029](../adr/0029-runtime-guards.md)                              | Runtime guards: actor, start, cancellation, verification  | D-7, D-12, D-27  |
| [0030](../adr/0030-execution-jobs-and-lease.md)                    | Execution jobs with lease; shared Firestore repositories  | D-7, D-12, D-27  |
| [0031](../adr/0031-runtime-advance.md)                             | Runtime advance(): one node at a time, runtime authority  | D-7, D-12, D-27  |
| [0032](../adr/0032-worker-and-job-transport.md)                    | Worker and job transport (Cloud Tasks)                    | D-X6-JOB, D-7    |
| [0033](../adr/0033-conversations-foundation.md)                    | Conversations foundation and human inbox API              | DG-1, DG-2       |
| [0034](../adr/0034-human-tool-invocation.md)                       | Human tool invocation through the Tool Gate (CV-2)        | DG/CV-2 (B)      |
| [0035](../adr/0035-conversations-inbox.md)                         | The Conversations Center inbox (CV-3)                     | CV-3             |
| [0036](../adr/0036-web-identity-foundation.md)                     | Web identity foundation: sign-in, session, API client     | D-6, D-4         |
| [0037](../adr/0037-assisted-conversation-intelligence.md)          | Assisted AI on conversations (CV-4)                       | CV-4, D-7, D-12  |
| [0038](../adr/0038-vertex-ai-activation.md)                        | Assisted AI activation: Vertex AI, Gemini, credit rate    | D-7, D-12, CV-5  |

## Current phase

Phase 2: the entitlements core in [`packages/entitlements`](../../packages/entitlements) and, in Phases 2A and 2B, auth and identity in [`packages/auth`](../../packages/auth) with users stored in Firestore by the API. The Phase 1B infrastructure code is in [`infra`](../../infra); how to apply it and deploy dev is in [`../infrastructure`](../infrastructure/README.md).
