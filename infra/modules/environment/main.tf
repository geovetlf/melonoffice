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
  # Firestore holds tenant data and Identity Platform signs users in (D-6).
  firestore_and_auth_services = [
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
  ]
  budget_services = [
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
  ]

  deployer_member = "serviceAccount:${google_service_account.deployer.email}"

  # What `terraform plan` reads to refresh each managed resource type (ADR-0015). Only get, list and
  # getIamPolicy on metadata; never data. Grouped so each environment gets only what it manages.
  planner_permissions = {
    base = [
      "artifactregistry.repositories.get",             # Artifact Registry repository
      "artifactregistry.repositories.getIamPolicy",    # its deployer binding
      "iam.roles.get",                                 # this custom role
      "iam.serviceAccounts.get",                       # deployer, planner and runtime identities
      "iam.serviceAccounts.getIamPolicy",              # their federation and act-as bindings
      "iam.workloadIdentityPoolProviders.get",         # GitHub provider
      "iam.workloadIdentityPools.get",                 # Workload Identity pool
      "iam.workloadIdentityPools.getAttestationRules", # read by the provider when refreshing the pool
      "resourcemanager.projects.get",                  # the project itself
      "resourcemanager.projects.getIamPolicy",         # project-level bindings
      "serviceusage.services.get",                     # enabled APIs
      "serviceusage.services.list",                    # enabled APIs
      "storage.buckets.get",                           # state bucket, read by the backend
      "storage.buckets.getIamPolicy",                  # the planner's state bucket binding
    ]
    cloud_run = [
      "run.services.get",          # web, api and worker
      "run.services.getIamPolicy", # their invoker and developer bindings
    ]
    firestore_and_auth = [
      "datastore.databases.get",         # Firestore database metadata, never documents
      "datastore.databases.getMetadata", # Firestore database metadata, never documents
      "firebaseauth.configs.get",        # Identity Platform configuration, never users
    ]
    budget = [
      "monitoring.notificationChannels.get", # budget alert channels
    ]
  }

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
  services = concat(
    local.base_services,
    var.firestore_and_auth ? local.firestore_and_auth_services : [],
    local.budget_enabled ? local.budget_services : [],
  )
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

# The planner's only project role (ADR-0015). It can read the metadata and IAM policies of the
# resources this module manages, and nothing else: no Firestore documents, no Identity Platform
# users, no logs, no images, no secrets and no writes.
resource "google_project_iam_custom_role" "planner" {
  project     = var.project_id
  role_id     = "melonofficeTerraformPlanner"
  title       = "MelonOffice Terraform planner"
  description = "Read-only metadata and IAM policies of the resources Terraform manages, for terraform plan."
  permissions = sort(concat(
    local.planner_permissions.base,
    var.deploy_apps ? local.planner_permissions.cloud_run : [],
    var.firestore_and_auth ? local.planner_permissions.firestore_and_auth : [],
    local.budget_enabled ? local.planner_permissions.budget : [],
  ))

  depends_on = [module.services]
}

resource "google_project_iam_member" "planner_role" {
  project = var.project_id
  role    = google_project_iam_custom_role.planner.id
  member  = "serviceAccount:${google_service_account.planner.email}"
}

resource "google_project_iam_member" "planner" {
  # With a budget, the provider bills API quota to the project, which needs serviceusage.services.use.
  for_each = toset(local.budget_enabled ? ["roles/serviceusage.serviceUsageConsumer"] : [])

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

# The default Firestore database, in Native mode. Its location is permanent. Terraform never
# deletes it: a destroy only removes it from state.
resource "google_firestore_database" "default" {
  count = var.firestore_and_auth ? 1 : 0

  project                 = var.project_id
  name                    = "(default)"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = var.deletion_protection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy         = "ABANDON"

  depends_on = [module.services]
}

# Enables Identity Platform with email and password sign-in only. Other providers and MFA are
# added when the auth work needs them. Identity Platform cannot be disabled once enabled; a
# destroy only removes it from state.
resource "google_identity_platform_config" "default" {
  count = var.firestore_and_auth ? 1 : 0

  project = var.project_id

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }

    # Google returns this block even when phone sign-in is off. Declaring it keeps plans clean.
    phone_number {
      enabled            = false
      test_phone_numbers = {}
    }
  }

  depends_on = [module.services]
}

# The API reads and writes Firestore with its own runtime identity. No other service gets access.
resource "google_project_iam_member" "api_firestore" {
  count = var.firestore_and_auth && var.deploy_apps ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${module.app["api"].runtime_service_account}"
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
