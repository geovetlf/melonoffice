# Credentials come from the environment: gcloud Application Default Credentials locally, or
# Workload Identity Federation in GitHub Actions. Never a key file.
provider "google" {
  project = var.project_id
  region  = var.region

  # The Billing Budgets API bills quota to a project; use this environment's project.
  billing_project       = var.project_id
  user_project_override = true
}
