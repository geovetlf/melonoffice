# Everything one MelonOffice environment needs in its own Google Cloud project.
# dev, staging and prod call this module with different inputs, so infrastructure changes
# are made once here and never copied between environments.

locals {
  labels = {
    app         = "melonoffice"
    environment = var.environment
    managed_by  = "terraform"
  }

  budget_enabled = var.budget != null

  base_services = [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "run.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ]
  budget_services = [
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
  ]

  deployer_member = "serviceAccount:${google_service_account.deployer.email}"

  # The deployable applications of the repository. Only the web and API are public; the worker
  # accepts requests from the deployer alone, which it needs for health checks.
  apps = {
    web = {
      public = true
      memory = "256Mi"
      env    = {}
    }
    api = {
      public = true
      memory = "512Mi"
      env    = { LOG_LEVEL = var.log_level }
    }
    worker = {
      public = false
      memory = "512Mi"
      env    = { LOG_LEVEL = var.log_level }
    }
  }
}

module "services" {
  source = "../project_services"

  project_id = var.project_id
  services   = concat(local.base_services, local.budget_enabled ? local.budget_services : [])
}

module "registry" {
  source = "../artifact_registry"

  project_id    = var.project_id
  region        = var.region
  repository_id = "melonoffice"
  labels        = local.labels

  depends_on = [module.services]
}

module "github_oidc" {
  source = "../github_oidc"

  project_id        = var.project_id
  github_repository = var.github_repository

  depends_on = [module.services]
}

# Deploys images to this environment. It can push to the registry and roll out new revisions
# of the app services, and nothing else. Only jobs running in the matching GitHub environment
# can use it.
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "github-deployer"
  display_name = "GitHub Actions deployer (${var.environment})"

  depends_on = [module.services]
}

resource "google_service_account_iam_member" "deployer_federation" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${module.github_oidc.environment_principal_set}${var.github_environment}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  project    = var.project_id
  location   = var.region
  repository = module.registry.repository_id
  role       = "roles/artifactregistry.writer"
  member     = local.deployer_member
}

# Runs read-only `terraform plan` from the main branch to detect drift. It never applies.
resource "google_service_account" "planner" {
  project      = var.project_id
  account_id   = "github-planner"
  display_name = "GitHub Actions Terraform planner (${var.environment})"

  depends_on = [module.services]
}

resource "google_service_account_iam_member" "planner_federation" {
  service_account_id = google_service_account.planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${module.github_oidc.ref_principal_set}refs/heads/main"
}

resource "google_project_iam_member" "planner" {
  # With a budget, the provider bills API quota to the project, which needs serviceusage.services.use.
  for_each = toset(concat(
    ["roles/viewer", "roles/iam.securityReviewer"],
    local.budget_enabled ? ["roles/serviceusage.serviceUsageConsumer"] : [],
  ))

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_storage_bucket_iam_member" "planner_state" {
  count = var.terraform_state_bucket == null ? 0 : 1

  bucket = var.terraform_state_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_billing_account_iam_member" "planner_budget" {
  count = local.budget_enabled ? 1 : 0

  billing_account_id = var.budget.billing_account_id
  role               = "roles/billing.viewer"
  member             = "serviceAccount:${google_service_account.planner.email}"
}

module "app" {
  source   = "../cloud_run_service"
  for_each = var.deploy_apps ? local.apps : {}

  project_id          = var.project_id
  region              = var.region
  name                = each.key
  public              = each.value.public
  memory              = each.value.memory
  env                 = each.value.env
  max_instances       = var.max_instances
  deletion_protection = var.deletion_protection
  labels              = local.labels
  developer_members   = { deployer = local.deployer_member }
  invoker_members     = each.value.public ? {} : { deployer = local.deployer_member }

  depends_on = [module.services]
}

module "budget" {
  source = "../budget"
  count  = local.budget_enabled ? 1 : 0

  project_id         = var.project_id
  billing_account_id = var.budget.billing_account_id
  display_name       = "melonoffice-${var.environment}"
  monthly_amount     = var.budget.monthly_amount
  currency_code      = var.budget.currency_code
  alert_emails       = var.budget.alert_emails

  depends_on = [module.services]
}
