# ADR-0011: Separate dev, staging and production cloud projects

- Status: Accepted (D-5, approved by Geovet on 2026-09-26). Dev is applied and deployed; staging and production are planned only.
- Date: 2026-09-26

## Decision

- The platform runs in three separate Google Cloud projects, managed as code, all in the `geovetlf-org` organization and region `us-central1`:

  | Environment | Project ID            | Terraform root       | State prefix          | GitHub environment |
  | ----------- | --------------------- | -------------------- | --------------------- | ------------------ |
  | dev         | `melonoffice`         | `infra/envs/dev`     | `melonoffice/dev`     | `dev`              |
  | staging     | `melonoffice-staging` | `infra/envs/staging` | `melonoffice/staging` | `staging`          |
  | production  | `melonoffice-prod`    | `infra/envs/prod`    | `melonoffice/prod`    | `prod`             |

- Each project keeps its Terraform state in a bucket inside that same project, so no environment can read or lock another's state.
- Each project has its own Workload Identity pool, deployer and planner. A deployer trusts only jobs in its own GitHub environment; a planner trusts only the `main` branch and is read-only. No service-account key exists.
- Project IDs, the billing account and bucket names live in each root's `terraform.tfvars`, which Git ignores. The code names no project.
- Development work can never modify production resources: the dev identities have no role in the other projects.
- In Phase 1B, staging and production create no Cloud Run service and have no deploy workflow. Applying them needs Geovet's explicit approval. CI never applies.

## Bootstrap exception

A project, its billing link, the two APIs Terraform needs to start, and its state bucket must exist before Terraform can manage the project. The owner creates them once with `gcloud`, as recorded in [the infrastructure runbook](../infrastructure/README.md). Everything else is created by Terraform.

## Consequences

- Three projects cost nothing while empty; each state bucket costs cents a month.
- `infra/scripts/check-environments.sh` runs in CI and fails if an environment root refers to another environment, shares a state prefix, deploys apps outside dev, drops deletion protection, or commits real identifiers.
