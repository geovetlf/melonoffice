# ADR-0112: Operator access from GitHub Actions (dev)

- Status: Accepted (Geovet, 2026-10-01: "Workflow Ops DEV", then "Autorizo crear la cuenta github-operator en DEV.")
- Date: 2026-10-01
- Builds on: [ADR-0015](0015-least-privilege-terraform-planner.md) (least privilege), [ADR-0047](0047-six-initial-departments.md) and [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (operator migrations)
- Terraform: one service account, its federation binding, five project roles, one private bucket and two bucket grants, behind `operator_access` (dev only). Applied by Geovet.

## Context

Operator tasks have run from Geovet's Cloud Shell, with Geovet pasting commands: the department migration (ADR-0047) and the agent policy migration (ADR-0100) are still pending in dev that way. Geovet asked Claude to run this work directly. Claude has no Google Cloud credentials. It can write and start GitHub Actions workflows, which already reach dev through Workload Identity Federation without keys.

## Decision

1. **An operator identity, dev only.** `github-operator`, used only by jobs in the `dev` GitHub environment (main only), through Workload Identity Federation. No key exists.
2. **Its roles, and nothing else:**
   - `roles/datastore.user`: reads and writes documents (the migrations);
   - `roles/datastore.importExportAdmin`: exports the database (the backup before a write);
   - `roles/run.viewer`, `roles/cloudtasks.viewer`, `roles/logging.viewer`: the read-only checks.
   - It cannot change IAM, deploy, delete the database, or read secrets.
3. **Backups.** A private bucket `{project}-operator-backups`: IAM only, public access prevented, never emptied by Terraform, objects deleted after 30 days. Firestore's own service agent writes the export into it. A restore is a person's decision (`gcloud firestore import`), never automatic.
4. **The `Ops (dev)` workflow** (`workflow_dispatch`), with three tasks:
   - `status` (read only): Cloud Run readiness and revisions, the jobs queue, error counts in the last hour, and a dry run of each operator migration.
   - `backup`: a Firestore export.
   - `migrate`: an export first, then each operator migration with `MIGRATION_APPLY=yes`, then a second dry run that must report every organization `unchanged`. A `skipped` organization fails the run for a person to look at.
5. **Public logs.** The repository is public, so the workflow prints counts, statuses and an 8-character hash of each organization id. The approver (the creator of the organization given as input) is read from Firestore and masked.

## Consequences

- Operator migrations and checks in dev no longer need a person in Cloud Shell, and every run is recorded in GitHub Actions.
- The migrations themselves are unchanged: additive (new versions, archived departments), audited, idempotent.
- The `approver_organization_id` input is visible in the run's metadata. It is an organization id, not a credential.
- Staging and production get no operator access.
