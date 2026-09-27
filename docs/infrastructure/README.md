# Infrastructure

This document covers the cloud environments and the dev deployment. The decisions are in [ADR-0012](../adr/0012-dev-deployment-on-cloud-run.md) and, for Firestore and Identity Platform in dev, [ADR-0014](../adr/0014-firestore-and-identity-platform-in-dev.md). Where Firestore and Identity Platform are on, Terraform also sets `IDENTITY_PLATFORM_PROJECT_ID` on the `api` service, which turns auth on ([ADR-0017](../adr/0017-user-persistence-in-firestore.md)).

| Environment | Terraform      | Cloud Run services     | Deployed by              |
| ----------- | -------------- | ---------------------- | ------------------------ |
| dev         | plan and apply | `web`, `api`, `worker` | `CD (dev)` from `main`   |
| staging     | plan only      | none                   | not deployed in Phase 1B |
| prod        | plan and apply | none                   | not deployed in Phase 1B |

## Layout

```
infra/
├─ modules/
│  ├─ environment/        # composes everything one environment needs (+ offline tests)
│  ├─ project_services/   # enables the required Google Cloud APIs
│  ├─ artifact_registry/  # Docker repository with a cleanup policy
│  ├─ github_oidc/        # Workload Identity Federation for this repository
│  ├─ cloud_run_service/  # one service, its runtime identity and its IAM
│  └─ budget/             # optional monthly spend alert
└─ envs/
   ├─ dev/  staging/  prod/   # same module, different inputs and state
```

Each environment has its own Google Cloud project and its own Terraform state. Nothing in the code names a project, billing account, region or bucket. Those values come from `terraform.tfvars`, which Git ignores; start from `terraform.tfvars.example`.

## Security model

- No service-account keys exist. GitHub Actions authenticates through Workload Identity Federation, and people use `gcloud` login.
- `github-deployer` can be used only by jobs in the matching GitHub environment. It can push images and roll out revisions of the three services.
- `github-planner` can be used only from `main`. It runs `terraform plan` with one custom role that reads only the metadata and IAM policies of the managed resources: no Firestore documents, Identity Platform users, logs, images or secrets ([ADR-0015](../adr/0015-least-privilege-terraform-planner.md)). A new resource type needs its read permission added to that role.
- The worker is private. Only the deployer (for its health check) and, in dev, `job-dispatch` can call it. `job-dispatch` is the identity Cloud Tasks signs job deliveries as, and the worker checks that token again ([ADR-0032](../adr/0032-worker-and-job-transport.md)).
- In dev, the worker's runtime identity reads and writes Firestore (`roles/datastore.user`), enqueues on the `execution-jobs` queue only, and may act only as `job-dispatch`.
- Terraform is applied by the owner, never by CI.

## One-time setup (owner)

You need the Google Cloud CLI and Terraform 1.16 or later. For each project you need the Owner role. For the optional budget, you also need Billing Account Administrator on the billing account.

1. **Projects and billing.** Create one project per environment inside the organization (the project IDs are in [ADR-0011](../adr/0011-cloud-environments.md)), then link billing:
   ```sh
   gcloud projects create <project id> --organization=<organization id> --name=<display name>
   gcloud billing projects link <project id> --billing-account=<billing account id>
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project=<project id>
   ```
2. **State bucket.** Create one per environment, inside that environment's project:
   ```sh
   gcloud storage buckets create gs://<state bucket> --project=<project id> --location=<region> \
     --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://<state bucket> --versioning
   ```
3. **Short-lived local credentials:**
   ```sh
   gcloud auth application-default login
   ```
4. **Apply dev:**
   ```sh
   cd infra/envs/dev
   cp terraform.tfvars.example terraform.tfvars   # fill in the real values
   terraform init -backend-config="bucket=<dev state bucket>"
   terraform plan -out=tfplan
   terraform apply tfplan
   terraform output
   ```
   On first creation, the services run Google's sample image until CD deploys MelonOffice.
5. **Plan staging and prod.** Run the same `init` and `plan` in `infra/envs/staging` and `infra/envs/prod`, each with its own project and state bucket, and remove the `budget` block from `terraform.tfvars` unless you want one. Plans are read-only; do not apply staging or prod without explicit approval.

   Production has been applied (infrastructure only). Before applying staging, create its GitHub environment first (step 6), because its deployer trusts any job that names that environment.

6. **GitHub environments.** In Settings → Environments, create `dev`. Under Deployment branches, allow only `main`. Add these variables to `dev`, most of them from `terraform output`:

   | Variable                         | Value                                                  |
   | -------------------------------- | ------------------------------------------------------ |
   | `GCP_PROJECT_ID`                 | dev project ID                                         |
   | `GCP_REGION`                     | region used in tfvars                                  |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | output `workload_identity_provider`                    |
   | `GCP_DEPLOYER_SERVICE_ACCOUNT`   | output `deployer_service_account`                      |
   | `GCP_PLANNER_SERVICE_ACCOUNT`    | output `planner_service_account`                       |
   | `TF_STATE_BUCKET`                | dev state bucket                                       |
   | `TF_BUDGET` (optional)           | the dev `budget` object as JSON, if you configured one |

   None of these values is a secret, and no GitHub secret is needed.

   `prod` already exists: it allows only `main`, requires Geovet's approval, has no administrator bypass and holds no variables or secrets. Create `staging` the same way before staging is applied.

7. **First deployment.** Run `CD (dev)` from the Actions tab (Run workflow on `main`), or merge to `main`.

## What CI and CD do

- **CI** (`ci.yml`, every pull request and push to `main`) runs:
  - format, lint, typecheck, unit tests and build;
  - Terraform `fmt`, `validate` for the three environments, and the mocked module tests;
  - the gitleaks secret scan.

  It has no cloud credentials.

- **CD (dev)** (`cd-dev.yml`, push to `main` or manual) has three jobs:
  - **validate**: lint, typecheck, tests and build.
  - **terraform-plan**: a read-only drift check for dev.
  - **deploy**, which:
    1. builds the three images tagged with the commit SHA and pushes them to Artifact Registry;
    2. rolls out each service;
    3. checks `GET /health` on web and api, and checks that api reports the deployed commit;
    4. checks the worker's health with a short-lived ID token, and that it refuses unauthenticated calls;
    5. runs a browser smoke test: the page renders, switches between English and Spanish, and logs no errors.

  Any failed step fails the workflow.

There is no staging or production deployment workflow.

## Rollback

Every deploy creates a new Cloud Run revision. To roll back dev, route traffic to an earlier revision, or re-run `CD (dev)` on an earlier commit:

```sh
gcloud run services update-traffic <service> --to-revisions=<revision>=100 --region=<region> --project=<project id>
```
