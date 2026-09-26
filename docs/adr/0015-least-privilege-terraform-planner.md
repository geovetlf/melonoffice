# ADR-0015: Least-privilege Terraform planner

- Status: Accepted (approved by Geovet on 2026-09-26). Not applied yet: each environment is applied separately by the owner.
- Date: 2026-09-26
- Builds on: [ADR-0011](0011-cloud-environments.md), [ADR-0012](0012-dev-deployment-on-cloud-run.md), [ADR-0014](0014-firestore-and-identity-platform-in-dev.md)

## Context

`github-planner` runs the read-only `terraform plan` in CD. Phase 1B gave it two broad project roles:

- `roles/viewer`, for convenience;
- `roles/iam.securityReviewer`, because `roles/viewer` cannot read IAM policies.

A security review on 2026-09-26 confirmed in Cloud Shell that `roles/viewer` (6,157 permissions) includes:

- `datastore.entities.get` and `datastore.entities.list`: every Firestore document;
- `firebaseauth.users.get`: Identity Platform user accounts;
- `logging.logEntries.list` and `logging.logEntries.download`: project logs;
- `artifactregistry.repositories.downloadArtifacts`: container images.

`roles/iam.securityReviewer` (2,560 permissions) reads the IAM policy of every resource in the project. Plan needs none of the data, and only the IAM policies of the resources Terraform manages. Any workflow on `main` can use the planner, so this access would reach real user and tenant data once it exists.

## Decision

- **The planner loses `roles/viewer` and `roles/iam.securityReviewer`** in every environment.
- **It gets one custom project role, `melonofficeTerraformPlanner`.** The role holds only `get`, `list`, `getMetadata` and `getIamPolicy` permissions on the resource types this module manages.
  - Each environment gets only the groups it needs.
  - Dev gets 18 permissions.
  - Staging and prod, with no Cloud Run, Firestore or Identity Platform, get 13.

| Permission                                                               | Why plan needs it                                              | Group                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------ |
| `resourcemanager.projects.get`                                           | Read the project                                               | all                            |
| `resourcemanager.projects.getIamPolicy`                                  | Refresh project-level IAM bindings                             | all                            |
| `serviceusage.services.get`, `serviceusage.services.list`                | Refresh the enabled APIs                                       | all                            |
| `artifactregistry.repositories.get`                                      | Refresh the image repository                                   | all                            |
| `artifactregistry.repositories.getIamPolicy`                             | Refresh the deployer's writer binding                          | all                            |
| `iam.workloadIdentityPools.get`, `iam.workloadIdentityPoolProviders.get` | Refresh the GitHub federation                                  | all                            |
| `iam.serviceAccounts.get`                                                | Refresh the deployer, planner and runtime identities           | all                            |
| `iam.serviceAccounts.getIamPolicy`                                       | Refresh their federation and act-as bindings                   | all                            |
| `iam.roles.get`                                                          | Refresh this custom role                                       | all                            |
| `storage.buckets.get`                                                    | Let the state backend read the bucket's metadata               | all                            |
| `storage.buckets.getIamPolicy`                                           | Refresh the planner's state bucket binding                     | all                            |
| `run.services.get`, `run.services.getIamPolicy`                          | Refresh the Cloud Run services and their IAM                   | only with `deploy_apps`        |
| `datastore.databases.get`, `datastore.databases.getMetadata`             | Refresh the Firestore database's metadata, never its documents | only with `firestore_and_auth` |
| `firebaseauth.configs.get`                                               | Refresh the Identity Platform configuration, never users       | only with `firestore_and_auth` |
| `monitoring.notificationChannels.get`                                    | Refresh the budget alert channels                              | only with a budget             |

- **Unchanged:**
  - `roles/storage.objectViewer` on the state bucket only, to read the state; the planner can never write or lock it;
  - with a budget, `roles/billing.viewer` on the billing account and `roles/serviceusage.serviceUsageConsumer`.
- **What the planner can no longer do:**
  - read or list Firestore documents;
  - read Identity Platform users or tenants;
  - read or download logs;
  - download images;
  - read metadata or IAM policies of services this module does not manage.

  It never had write access or access to secret values.

- **Offline tests enforce it.** The module tests fail if:
  - the planner holds `roles/viewer`, `roles/iam.securityReviewer` or any basic role;
  - a permission is not a read of metadata or an IAM policy;
  - the role holds any `datastore.entities`, `firebaseauth.users`, `identitytoolkit`, `logging`, `secretmanager` or `downloadArtifacts` permission;
  - the role grows past 25 permissions.

## Consequences

- Applying this does not affect `terraform apply`: the owner applies with their own credentials, never with the planner.
- **A resource type added later needs its read permission added here in the same change.** Otherwise CD's plan fails with a 403 naming the missing permission. It never affects deploys or the running app.
- A deleted custom role ID stays reserved for 7 days, so the role is kept, not recreated.
- Each environment picks this up only when the owner applies it:
  - dev first;
  - production with its own approval;
  - staging when it is first applied.

  Until then, that environment's plan shows the pending change: 2 to add and 2 to destroy.
