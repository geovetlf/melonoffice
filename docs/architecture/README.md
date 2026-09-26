# Architecture

The MelonOffice architecture was defined in the **Phase 0 Architecture Plan (v0.7, approved 2026-09-26)**, kept in the project's shared files at `melonoffice-plan/MelonOffice-Phase0-Architecture-Plan.md`. The decisions that bind this repository are recorded as ADRs in [`../adr`](../adr):

| ADR                                                      | Decision                                                | Plan ref |
| -------------------------------------------------------- | ------------------------------------------------------- | -------- |
| [0001](../adr/0001-record-architecture-decisions.md)     | Record architecture decisions                           | —        |
| [0002](../adr/0002-modular-monolith-monorepo.md)         | Modular monolith in a pnpm + Turborepo monorepo         | D-1      |
| [0003](../adr/0003-react-vite-spa.md)                    | React + Vite single-page app                            | D-2      |
| [0004](../adr/0004-git-baseline-and-licence.md)          | Git baseline and proprietary licence                    | D-19     |
| [0005](../adr/0005-initial-departments.md)               | Seven initial departments as catalogue data             | D-11     |
| [0006](../adr/0006-no-fixed-specialist-quantity.md)      | No fixed number of specialists                          | D-12a    |
| [0007](../adr/0007-plans-entitlements.md)                | Plan → Entitlements → Limits → Features → Permissions   | D-25     |
| [0008](../adr/0008-entity-model.md)                      | Department → Specialist/Agent → Role → Skills → Tools   | D-28     |
| [0009](../adr/0009-one-main-specialty-per-specialist.md) | One main specialty per specialist                       | D-29     |
| [0010](../adr/0010-initial-languages.md)                 | English and Spanish first, extensible i18n              | D-17     |
| [0011](../adr/0011-cloud-environments.md)                | Separate dev, staging and production cloud projects     | D-5      |
| [0012](../adr/0012-dev-deployment-on-cloud-run.md)       | Phase 1B infrastructure and dev deployment on Cloud Run | D-5      |

## Current phase

Phase 1B (cloud environments and dev deployment). The infrastructure code is in [`infra`](../../infra); how to apply it and deploy dev is in [`../infrastructure`](../infrastructure/README.md).
