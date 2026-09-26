# ADR-0014: Firestore and Identity Platform in dev

- Status: Accepted (D-6, approved by Geovet on 2026-09-26). Planned for dev only; not applied yet.
- Date: 2026-09-26
- Builds on: [ADR-0011](0011-cloud-environments.md), [ADR-0012](0012-dev-deployment-on-cloud-run.md)

## Decision

- **Store:** Firestore in Native mode, as the project's `(default)` database in the environment's region. No Cloud SQL.
- **Identity:** Identity Platform, Google Cloud's managed sign-in. No third-party auth provider. It starts with email and password only, with unique emails. MFA and other sign-in providers are added when the auth work needs them.
- **Only in dev.** The `environment` module creates both only when `firestore_and_auth = true`, which only `infra/envs/dev` sets. `check-environments.sh` fails CI if staging or production set it.
- **Access.** Only the API's runtime identity gets `roles/datastore.user`. The worker, the web app and the deployer get no new role. The planner reads only the database's metadata and the Identity Platform configuration ([ADR-0015](0015-least-privilege-terraform-planner.md)).
- **No Firebase project and no client rules yet.** The database is reached only from the API with its own identity, so no client can read it directly.

## Consequences

- The Firestore location is permanent. Moving dev later means a new database.
- Identity Platform cannot be switched off once enabled. Both resources are kept by Terraform on destroy: it only forgets them.
- Cost: both have free tiers (Firestore daily free quota; Identity Platform's first 50,000 monthly active users for email sign-in). Dev usage stays within them.
