# ADR-0012: Phase 1B infrastructure and dev deployment

- Status: Accepted (Phase 1B decisions approved by Geovet on 2026-09-26)
- Date: 2026-09-26
- Builds on: [ADR-0011](0011-cloud-environments.md)

## Decision

- **Terraform layout.** Reusable modules live in `infra/modules`. `infra/envs/dev`, `infra/envs/staging` and `infra/envs/prod` each call the same `environment` module with their own inputs and state. A change is made once in the module, never copied between environments. Project IDs, region, billing account and state bucket are inputs; none is written in the code.
- **Hosting.** The web app, the API and the worker each run as a Cloud Run service with its own runtime service account. The web app is a static Vite build served by an unprivileged nginx container. It does not use Firebase Hosting or a load balancer.
- **URLs.** Dev uses the default `*.run.app` URLs. No custom domain in Phase 1B.
- **Access.**
  - The web app and the API are public.
  - The worker accepts only authenticated calls, from the deployer identity for health checks.
- **Authentication from GitHub.** GitHub Actions uses Workload Identity Federation. No service-account key is created or stored anywhere. Each environment's pool accepts only tokens from this repository. There are two service accounts:
  - `github-deployer` can be used only by jobs running in the matching GitHub environment. It can push images and roll out new revisions of the three services, nothing else.
  - `github-planner` can be used only from the `main` branch. It is read-only, for `terraform plan`.
- **Who changes what.**
  - Infrastructure is applied by the owner with short-lived local credentials (`gcloud auth application-default login`).
  - CD never applies Terraform. It only rolls out new images with `gcloud run services update`, which is why Terraform ignores image changes on existing services.
- **Scope of environments.**
  - Only dev creates Cloud Run services and is deployed.
  - Staging and production get the same foundation (APIs, registry, identities) when an owner applies them. Their `deploy_apps` input is `false`, so no service is created and nothing is deployed. Phase 1B runs only `terraform plan` for them.
- **Cost guard.** Services scale to zero with at most two instances. There is an optional monthly budget alert per project; it never stops services.

## Consequences

- No credential with write access to Google Cloud lives in GitHub. The deployer can only roll out images to dev.
- The first apply of each environment is a manual owner step, because the federation it creates cannot exist before it.
- Deploying staging or production later needs a new, explicit approval. It means setting `deploy_apps = true` and adding a separate workflow with its own GitHub environment and reviewers.
