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

  # The execution runtime (ADR-0032): the worker runs jobs Cloud Tasks delivers (D-X6-JOB). Only
  # where the apps and Firestore exist (dev today).
  runtime_enabled = var.deploy_apps && var.firestore_and_auth
  job_queue_name  = "execution-jobs"
  job_queue_path  = "projects/${var.project_id}/locations/${var.region}/queues/${local.job_queue_name}"
  # The worker's deterministic run.app URL: the audience of the tasks' OIDC tokens and the base of
  # their target. Known before the service exists, so the worker's own settings can name it.
  worker_url = local.runtime_enabled ? "https://worker-${data.google_project.this[0].number}.${var.region}.run.app" : null

  # Web sign-in (ADR-0036): the browser signs in with Identity Platform and calls the API, which
  # accepts calls from the web's origin only. Both URLs are the deterministic run.app ones, known
  # before the services exist, so neither service has to wait for the other.
  web_sign_in_enabled = var.deploy_apps && var.firestore_and_auth
  web_url             = local.web_sign_in_enabled ? "https://web-${data.google_project.this[0].number}.${var.region}.run.app" : null
  api_url             = local.web_sign_in_enabled ? "https://api-${data.google_project.this[0].number}.${var.region}.run.app" : null

  # Assisted AI (ADR-0038): the api calls Vertex AI's generateContent with its own identity.
  # Only where the apps, Firestore and the runtime exist, and only when turned on (dev today).
  ai_assist_enabled = var.ai_assist && local.runtime_enabled

  # Conversation agents (ADR-0043): the worker runs agent turns with the same approved model, and
  # the api hands each turn to the same execution jobs queue (X6d). Needs assisted AI.
  conversation_agents_enabled = var.conversation_agents && local.ai_assist_enabled

  # The WhatsApp channel (ADR-0033, ADR-0034): channel secrets live in this project's Secret
  # Manager, one secret per connection and kind, named `channel-{connectionId}-{kind}`. The api
  # reads them for webhooks and a person's replies; the worker for an agent's replies.
  whatsapp_channel_enabled = var.whatsapp_channel && local.runtime_enabled
  whatsapp_env = local.whatsapp_channel_enabled ? merge(
    { CHANNEL_SECRETS_PROJECT_ID = var.project_id },
    var.whatsapp_graph_api_version == null ? {} : { WHATSAPP_GRAPH_API_VERSION = var.whatsapp_graph_api_version },
  ) : {}

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
  web_sign_in_services = [
    "apikeys.googleapis.com",     # the web's browser key
    "securetoken.googleapis.com", # token refresh, which the key may call
  ]
  runtime_services = [
    "cloudtasks.googleapis.com",
  ]
  ai_assist_services = [
    "aiplatform.googleapis.com",
  ]
  whatsapp_channel_services = [
    "secretmanager.googleapis.com",
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
    runtime = [
      "cloudtasks.queues.get",          # the execution jobs queue
      "cloudtasks.queues.getIamPolicy", # its enqueuer binding
    ]
    web_sign_in = [
      "apikeys.keys.get",          # the web's browser key and its restrictions
      "apikeys.keys.getKeyString", # its value, which the web serves to browsers anyway
    ]
  }

  # The deployable applications of the repository. Only the web and API are public; the worker
  # accepts requests from the deployer alone, which it needs for health checks.
  apps = {
    web = {
      public = true
      memory = "256Mi"
      # What /config.json tells the browser (ADR-0036). Neither is a secret: the API's public URL
      # and a browser key restricted to the sign-in APIs and this site.
      env = local.web_sign_in_enabled ? {
        MELONOFFICE_API_URL          = local.api_url
        MELONOFFICE_IDENTITY_API_KEY = nonsensitive(google_apikeys_key.web_sign_in[0].key_string)
      } : {}
      timeout = null
    }
    api = {
      public = true
      memory = "512Mi"
      # Turns on auth: the project whose Identity Platform issues tokens and whose Firestore
      # holds users (ADR-0017). Not a secret. Only set where Firestore and auth exist.
      env = merge(
        { LOG_LEVEL = var.log_level },
        var.firestore_and_auth ? { IDENTITY_PLATFORM_PROJECT_ID = var.project_id } : {},
        # The one origin whose browser calls get CORS headers (ADR-0036). Authentication and
        # RBAC still decide every call.
        local.web_sign_in_enabled ? { WEB_ORIGINS = local.web_url } : {},
        # Where this server runs, like the worker: tools and AI models run only where allowed.
        local.runtime_enabled ? { DEPLOYMENT_ENVIRONMENT = var.environment } : {},
        # Where Vertex AI runs the approved model (ADR-0038). Not secrets: a project and a region.
        local.ai_assist_enabled ? {
          VERTEX_AI_PROJECT_ID = var.project_id
          VERTEX_AI_LOCATION   = var.region
        } : {},
        # Agent turns go to the worker through the execution jobs queue (ADR-0032, ADR-0043), with
        # the same settings the worker uses. None is a secret.
        local.conversation_agents_enabled ? {
          JOB_QUEUE         = local.job_queue_path
          WORKER_URL        = local.worker_url
          JOB_INVOKER_EMAIL = google_service_account.job_dispatch[0].email
          JOB_LEASE_MS      = tostring(var.job_lease_seconds * 1000)
        } : {},
        local.whatsapp_env,
      )
      timeout = null
    }
    worker = {
      public = false
      memory = "512Mi"
      # With the runtime on, everything the worker needs to run jobs (ADR-0032). None is a secret.
      env = merge(
        { LOG_LEVEL = var.log_level },
        local.runtime_enabled ? {
          FIRESTORE_PROJECT_ID   = var.project_id
          DEPLOYMENT_ENVIRONMENT = var.environment
          JOB_LEASE_MS           = tostring(var.job_lease_seconds * 1000)
          JOB_QUEUE              = local.job_queue_path
          WORKER_URL             = local.worker_url
          JOB_INVOKER_EMAIL      = google_service_account.job_dispatch[0].email
        } : {},
        # The approved model for agent turns (ADR-0043), in the same project and region as the
        # api's. Not secrets.
        local.conversation_agents_enabled ? {
          VERTEX_AI_PROJECT_ID = var.project_id
          VERTEX_AI_LOCATION   = var.region
        } : {},
        local.whatsapp_env,
      )
      # A delivery may run as long as its lease; other services keep the default.
      timeout = local.runtime_enabled ? "${var.job_lease_seconds}s" : null
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
    local.runtime_enabled ? local.runtime_services : [],
    local.web_sign_in_enabled ? local.web_sign_in_services : [],
    local.ai_assist_enabled ? local.ai_assist_services : [],
    local.whatsapp_channel_enabled ? local.whatsapp_channel_services : [],
  )
}

data "google_project" "this" {
  count = local.runtime_enabled || local.web_sign_in_enabled ? 1 : 0

  project_id = var.project_id
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
    local.runtime_enabled ? local.planner_permissions.runtime : [],
    local.web_sign_in_enabled ? local.planner_permissions.web_sign_in : [],
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
  timeout             = each.value.timeout
  max_instances       = var.max_instances
  deletion_protection = var.deletion_protection
  labels              = local.labels
  developer_members   = { deployer = local.deployer_member }
  # A private service answers the deployer (health checks). The worker also answers the job
  # dispatch identity, which Cloud Tasks signs its OIDC tokens as.
  invoker_members = each.value.public ? {} : merge(
    { deployer = local.deployer_member },
    each.key == "worker" && local.runtime_enabled ? { job_dispatch = local.job_dispatch_member } : {},
  )

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

# The browser key the web app signs in with (ADR-0036). A browser key is public by design: it
# only names the project. It is restricted to Identity Platform sign-in and token refresh, and
# to pages of this environment's web app.
resource "google_apikeys_key" "web_sign_in" {
  count = local.web_sign_in_enabled ? 1 : 0

  project      = var.project_id
  name         = "web-sign-in"
  display_name = "MelonOffice web sign-in"

  restrictions {
    browser_key_restrictions {
      allowed_referrers = ["${local.web_url}/*"]
    }
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
    api_targets {
      service = "securetoken.googleapis.com"
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

# ---------------------------------------------------------------------------------------------
# Execution runtime transport (ADR-0032, D-X6-JOB). Cloud Tasks delivers { jobId } to the private
# worker; it is never the source of truth (the job's lease and revision are).

# The identity Cloud Tasks signs its OIDC tokens as. It can only invoke the worker.
resource "google_service_account" "job_dispatch" {
  count = local.runtime_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "job-dispatch"
  display_name = "Cloud Tasks job delivery to the worker (${var.environment})"

  depends_on = [module.services]
}

locals {
  job_dispatch_member = local.runtime_enabled ? "serviceAccount:${google_service_account.job_dispatch[0].email}" : null
  worker_member       = local.runtime_enabled ? "serviceAccount:${module.app["worker"].runtime_service_account}" : null
}

# One queue for execution jobs. Retries are transport redeliveries only: a delivery that finds
# the lease held answers 409 and comes back later, until the lease ends (ADR-0032).
resource "google_cloud_tasks_queue" "execution_jobs" {
  count = local.runtime_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = local.job_queue_name

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts  = 10
    min_backoff   = "10s"
    max_backoff   = "600s"
    max_doublings = 6
  }

  depends_on = [module.services]
}

# The worker hands the next job to the queue: enqueue on this queue only.
resource "google_cloud_tasks_queue_iam_member" "worker_enqueuer" {
  count = local.runtime_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.execution_jobs[0].name
  role     = "roles/cloudtasks.enqueuer"
  member   = local.worker_member
}

# Creating a task with an OIDC token for the dispatch identity requires acting as it; the worker
# may act as that identity only.
resource "google_service_account_iam_member" "worker_acts_as_job_dispatch" {
  count = local.runtime_enabled ? 1 : 0

  service_account_id = google_service_account.job_dispatch[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = local.worker_member
}

# The worker reads and writes Firestore with its own runtime identity, like the api. Firestore
# IAM cannot be narrowed to collections for server identities; datastore.user is the smallest
# predefined role that reads and writes documents (no admin, index, import or export). Which
# collections the worker touches is enforced by its repositories.
resource "google_project_iam_member" "worker_firestore" {
  count = local.runtime_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/datastore.user"
  member  = local.worker_member
}

# ---------------------------------------------------------------------------------------------
# Assisted AI (ADR-0038, D-7): the api calls Gemini 2.5 Flash-Lite on Vertex AI with its own
# runtime identity, through the metadata server. No key.

# The smallest grant that can call a model: predict (which covers generateContent) and nothing
# else. roles/aiplatform.user would also let it create and manage datasets, endpoints, jobs and
# models. Which model it may call is decided in code by the model policy.
resource "google_project_iam_custom_role" "vertex_ai_invoker" {
  count = local.ai_assist_enabled ? 1 : 0

  project     = var.project_id
  role_id     = "melonofficeVertexAIInvoker"
  title       = "MelonOffice Vertex AI invoker"
  description = "Calls Vertex AI models (predict, generateContent) only. No datasets, endpoints, jobs, models or admin."
  permissions = ["aiplatform.endpoints.predict"]

  depends_on = [module.services]
}

resource "google_project_iam_member" "api_vertex_ai" {
  count = local.ai_assist_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.vertex_ai_invoker[0].id
  member  = "serviceAccount:${module.app["api"].runtime_service_account}"
}

# ---------------------------------------------------------------------------------------------
# Conversation agents (ADR-0043): the same approved model and the same jobs queue, for the worker
# and the api respectively. Nothing new is created: only who may use what already exists.

# The worker calls the model for agent turns with the same smallest role the api has.
resource "google_project_iam_member" "worker_vertex_ai" {
  count = local.conversation_agents_enabled ? 1 : 0

  project = var.project_id
  role    = google_project_iam_custom_role.vertex_ai_invoker[0].id
  member  = local.worker_member
}

# The api hands a new agent turn's first job to the queue: enqueue on this queue only.
resource "google_cloud_tasks_queue_iam_member" "api_enqueuer" {
  count = local.conversation_agents_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.execution_jobs[0].name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${module.app["api"].runtime_service_account}"
}

# Creating a task with an OIDC token for the dispatch identity requires acting as it; the api may
# act as that identity only, as the worker does.
resource "google_service_account_iam_member" "api_acts_as_job_dispatch" {
  count = local.conversation_agents_enabled ? 1 : 0

  service_account_id = google_service_account.job_dispatch[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${module.app["api"].runtime_service_account}"
}

# ---------------------------------------------------------------------------------------------
# WhatsApp channel secrets (ADR-0033). Terraform never holds a secret value: the project's owner
# creates each connection's secrets in Secret Manager. The api and worker may read the latest
# version of channel secrets only (`channel-*`), never list, create or change any secret.

resource "google_project_iam_member" "api_channel_secrets" {
  count = local.whatsapp_channel_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${module.app["api"].runtime_service_account}"

  condition {
    title       = "channel-secrets-only"
    description = "Channel connection secrets only (channel-{connectionId}-{kind})."
    expression  = "resource.name.startsWith(\"projects/${data.google_project.this[0].number}/secrets/channel-\")"
  }
}

resource "google_project_iam_member" "worker_channel_secrets" {
  count = local.whatsapp_channel_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = local.worker_member

  condition {
    title       = "channel-secrets-only"
    description = "Channel connection secrets only (channel-{connectionId}-{kind})."
    expression  = "resource.name.startsWith(\"projects/${data.google_project.this[0].number}/secrets/channel-\")"
  }
}
