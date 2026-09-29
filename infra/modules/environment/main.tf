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

  # The Forecasting Engine (ADR-0059): the forecaster runs TimesFM 2.5 on CPU, private. A run is
  # queued by the api on the execution jobs queue, whose access the api already has for agents,
  # and the worker calls the forecaster. Its URL is the deterministic run.app one.
  forecasting_enabled = var.forecasting && local.conversation_agents_enabled
  forecaster_url      = local.forecasting_enabled ? "https://forecaster-${data.google_project.this[0].number}.${var.region}.run.app" : null
  # The same on the api (which only needs to know a model is deployed) and the worker (which calls
  # it). None is a secret; a missing price leaves runs refused.
  forecasting_env = local.forecasting_enabled ? merge(
    { FORECASTER_URL = local.forecaster_url },
    var.forecast_credits_per_run == null ? {} : { FORECAST_CREDITS_PER_RUN = tostring(var.forecast_credits_per_run) },
  ) : {}

  # The WhatsApp channel (ADR-0033, ADR-0034): channel secrets live in this project's Secret
  # Manager, one secret per connection and kind, named `channel-{connectionId}-{kind}`. The api
  # reads them for webhooks and a person's replies; the worker for an agent's replies.
  whatsapp_channel_enabled = var.whatsapp_channel && local.runtime_enabled
  whatsapp_env = local.whatsapp_channel_enabled ? merge(
    { CHANNEL_SECRETS_PROJECT_ID = var.project_id },
    var.whatsapp_graph_api_version == null ? {} : { WHATSAPP_GRAPH_API_VERSION = var.whatsapp_graph_api_version },
  ) : {}

  # NVIDIA's hosted API (ADR-0080): the key lives in one Secret Manager secret the owner creates.
  # The api (with assisted AI) and the worker (with conversation agents) may read that secret only,
  # and are told its reference. Registering NVIDIA allows nothing by itself: models and policies
  # decide which calls may reach it (public data only, DEV only).
  nvidia_api_enabled    = var.nvidia_api_key_secret != null && local.ai_assist_enabled
  nvidia_worker_enabled = var.nvidia_api_key_secret != null && local.conversation_agents_enabled
  nvidia_env = var.nvidia_api_key_secret == null ? {} : {
    NVIDIA_API_KEY_SECRET = "projects/${var.project_id}/secrets/${var.nvidia_api_key_secret}/versions/latest"
  }

  # Document uploads (ADR-0078): the api keeps uploaded files in a private bucket of this project,
  # with its own identity. Records are in Firestore and the api is the only reader and writer, so
  # the bucket exists only where the apps and Firestore do (the runtime's condition).
  document_storage_enabled = var.document_storage && local.runtime_enabled
  documents_bucket_name    = "${var.project_id}-documents"

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
  document_storage_services = [
    "storage.googleapis.com",
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
      "datastore.indexes.get",           # Firestore index definitions, never documents
      "datastore.indexes.list",          # Firestore index definitions, never documents
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
      public        = true
      cpu           = "1"
      memory        = "256Mi"
      concurrency   = 80
      max_instances = null
      startup       = 10
      # What /config.json tells the browser (ADR-0036). Neither is a secret: the API's public URL
      # and a browser key restricted to the sign-in APIs and this site.
      env = local.web_sign_in_enabled ? {
        MELONOFFICE_API_URL          = local.api_url
        MELONOFFICE_IDENTITY_API_KEY = nonsensitive(google_apikeys_key.web_sign_in[0].key_string)
      } : {}
      timeout = null
    }
    api = {
      public        = true
      cpu           = "1"
      memory        = "512Mi"
      concurrency   = 80
      max_instances = null
      startup       = 10
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
        local.forecasting_env,
        # Where uploaded documents are kept (ADR-0078). A bucket name, not a secret.
        local.document_storage_enabled ? { DOCUMENTS_BUCKET = local.documents_bucket_name } : {},
        # Where NVIDIA's key is kept (ADR-0080): a reference, never the key.
        local.nvidia_api_enabled ? local.nvidia_env : {},
        # Who may open the platform AI view (ADR-0082): MelonOffice user ids, not secrets.
        length(var.platform_admin_user_ids) > 0 ? { PLATFORM_ADMIN_USER_IDS = join(",", var.platform_admin_user_ids) } : {},
      )
      timeout = null
    }
    worker = {
      public        = false
      cpu           = "1"
      memory        = "512Mi"
      concurrency   = 80
      max_instances = null
      startup       = 10
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
        local.forecasting_env,
        local.nvidia_worker_enabled ? local.nvidia_env : {},
      )
      # A delivery may run as long as its lease; other services keep the default.
      timeout = local.runtime_enabled ? "${var.job_lease_seconds}s" : null
    }
  }

  # The forecaster (ADR-0059): TimesFM 2.5 on CPU, one forecast at a time per instance, at most
  # one instance. Measured: about 0.5 s and 1.4 GB per forecast; 2 vCPU and 4 GiB leave room for
  # loading the weights. Loading takes a while, so its startup probe waits up to 240 s.
  forecaster_app = local.forecasting_enabled ? {
    forecaster = {
      public        = false
      cpu           = "2"
      memory        = "4Gi"
      concurrency   = 1
      max_instances = 1
      startup       = 80
      env = {
        FORECASTER_MAX_CONTEXT = "1024"
        FORECASTER_THREADS     = "2"
      }
      timeout = "120s"
    }
  } : {}
  deployed_apps = merge(local.apps, local.forecaster_app)
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
    local.document_storage_enabled ? local.document_storage_services : [],
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
  for_each = var.deploy_apps ? local.deployed_apps : {}

  project_id                = var.project_id
  region                    = var.region
  name                      = each.key
  public                    = each.value.public
  cpu                       = each.value.cpu
  memory                    = each.value.memory
  concurrency               = each.value.concurrency
  startup_failure_threshold = each.value.startup
  env                       = each.value.env
  timeout                   = each.value.timeout
  max_instances             = coalesce(each.value.max_instances, var.max_instances)
  deletion_protection       = var.deletion_protection
  labels                    = local.labels
  developer_members         = { deployer = local.deployer_member }
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

# The office's activity (ADR-0049) reads one organization's audit events of a few actions, newest
# first. Firestore needs this composite index for that query.
resource "google_firestore_index" "audit_activity" {
  count = var.firestore_and_auth ? 1 : 0

  project     = var.project_id
  database    = google_firestore_database.default[0].name
  collection  = "auditLogs"
  query_scope = "COLLECTION"

  fields {
    field_path = "organizationId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "action"
    order      = "ASCENDING"
  }
  fields {
    field_path = "occurredAt"
    order      = "DESCENDING"
  }
}

# Comercial's lists are read one page at a time (ADR-0061): the organization, the list's filters,
# then its order (newest change first, or soonest first for follow-ups). Firestore needs one
# composite index per combination; the document id that breaks ties is implicit. Until an index
# exists, the API reads that list the old way (the whole collection) and logs it, so applying
# these never has to come before the code. The last one serves the pipeline totals' sums.
locals {
  commercial_indexes = {
    contacts_page = {
      collection = "contacts"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["commercial.stage", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    contacts_owner_page = {
      collection = "contacts"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["commercial.ownerId", "ASCENDING"], ["commercial.stage", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    opportunities_page = {
      collection = "opportunities"
      fields     = [["organizationId", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    opportunities_status_page = {
      collection = "opportunities"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    opportunities_stage_page = {
      collection = "opportunities"
      fields     = [["organizationId", "ASCENDING"], ["stageId", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    opportunities_owner_page = {
      collection = "opportunities"
      fields     = [["organizationId", "ASCENDING"], ["ownerId", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    opportunities_contact_page = {
      collection = "opportunities"
      fields     = [["organizationId", "ASCENDING"], ["contactId", "ASCENDING"], ["updatedAt", "DESCENDING"]]
    }
    opportunities_stage_value = {
      collection = "opportunities"
      fields     = [["organizationId", "ASCENDING"], ["stageId", "ASCENDING"], ["value.currency", "ASCENDING"], ["value.amountMinor", "ASCENDING"]]
    }
    follow_ups_page = {
      collection = "followUps"
      fields     = [["organizationId", "ASCENDING"], ["scheduledAt", "ASCENDING"]]
    }
    follow_ups_status_page = {
      collection = "followUps"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["scheduledAt", "ASCENDING"]]
    }
    follow_ups_contact_page = {
      collection = "followUps"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["contactId", "ASCENDING"], ["scheduledAt", "ASCENDING"]]
    }
    follow_ups_opportunity_page = {
      collection = "followUps"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["opportunityId", "ASCENDING"], ["scheduledAt", "ASCENDING"]]
    }
    follow_ups_assignee_page = {
      collection = "followUps"
      fields     = [["organizationId", "ASCENDING"], ["status", "ASCENDING"], ["assignedTo", "ASCENDING"], ["scheduledAt", "ASCENDING"]]
    }
  }
}

resource "google_firestore_index" "commercial" {
  for_each = var.firestore_and_auth ? local.commercial_indexes : {}

  project     = var.project_id
  database    = google_firestore_database.default[0].name
  collection  = each.value.collection
  query_scope = "COLLECTION"

  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path = fields.value[0]
      order      = fields.value[1]
    }
  }
}

# An agent's tasks are listed one page at a time, newest first (ADR-0063). Until this index exists,
# the API reads the agent's tasks without it (at most 500) and logs it, like Comercial's lists.
resource "google_firestore_index" "agent_tasks" {
  count = var.firestore_and_auth ? 1 : 0

  project     = var.project_id
  database    = google_firestore_database.default[0].name
  collection  = "agentTasks"
  query_scope = "COLLECTION"

  fields {
    field_path = "organizationId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "specialistId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

# An organization's AI usage events are listed one page at a time, newest first (ADR-0074).
# Until this index exists, the API reads them without it (at most 500) and logs it.
resource "google_firestore_index" "ai_usage_events" {
  count = var.firestore_and_auth ? 1 : 0

  project     = var.project_id
  database    = google_firestore_database.default[0].name
  collection  = "aiUsageEvents"
  query_scope = "COLLECTION"

  fields {
    field_path = "organizationId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "occurredAt"
    order      = "DESCENDING"
  }
}

# An organization's documents are listed one page at a time, newest first (ADR-0078). Until this
# index exists, the API reads them without it (at most 500) and logs it.
resource "google_firestore_index" "documents" {
  count = var.firestore_and_auth ? 1 : 0

  project     = var.project_id
  database    = google_firestore_database.default[0].name
  collection  = "documents"
  query_scope = "COLLECTION"

  fields {
    field_path = "organizationId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
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

# ---------------------------------------------------------------------------------------------
# NVIDIA's API key (ADR-0080). Terraform never holds the value: the owner creates the secret. The
# api and worker may read that one secret only, never list, create or change any secret.

resource "google_secret_manager_secret_iam_member" "api_nvidia_key" {
  count = local.nvidia_api_enabled ? 1 : 0

  project   = var.project_id
  secret_id = var.nvidia_api_key_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${module.app["api"].runtime_service_account}"
}

resource "google_secret_manager_secret_iam_member" "worker_nvidia_key" {
  count = local.nvidia_worker_enabled ? 1 : 0

  project   = var.project_id
  secret_id = var.nvidia_api_key_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = local.worker_member
}

# ---------------------------------------------------------------------------------------------
# Forecasting Engine (ADR-0059). The forecaster is private: besides the deployer (health checks),
# only the worker's runtime identity may call it. The api never does; it queues runs.

resource "google_cloud_run_v2_service_iam_member" "worker_invokes_forecaster" {
  count = local.forecasting_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = module.app["forecaster"].name
  role     = "roles/run.invoker"
  member   = local.worker_member
}

# ---------------------------------------------------------------------------------------------
# Document uploads (ADR-0078). One private bucket; object names are built by the api only
# (`organizations/{organizationId}/documents/{documentId}`). Nothing is public, and no one but the
# api's runtime identity gets access to objects through Terraform.

resource "google_storage_bucket" "documents" {
  count = local.document_storage_enabled ? 1 : 0

  project                     = var.project_id
  name                        = local.documents_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Never emptied by Terraform: a destroy fails while documents are in it, whatever
  # deletion_protection says. Removing people's documents is a decision, not a side effect.
  force_destroy = false
  labels        = local.labels

  # The api never replaces an object (it creates each once), so there is nothing to version.
  versioning {
    enabled = false
  }

  depends_on = [module.services]
}

# The api uploads each document once: objectCreator creates objects and cannot overwrite or
# delete one (that needs storage.objects.delete).
resource "google_storage_bucket_iam_member" "api_documents_creator" {
  count = local.document_storage_enabled ? 1 : 0

  bucket = google_storage_bucket.documents[0].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${module.app["api"].runtime_service_account}"
}

# The api reads a document back to hand it to its organization's people.
resource "google_storage_bucket_iam_member" "api_documents_viewer" {
  count = local.document_storage_enabled ? 1 : 0

  bucket = google_storage_bucket.documents[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.app["api"].runtime_service_account}"
}

# Reading a scanned PDF (ADR-0079): the api gives Gemini a `gs://` reference into this bucket,
# and Vertex AI reads the object with its own service agent, not the api's identity. It may read
# objects of this bucket only, and only where both documents and assisted AI are on. Which
# object a call names is decided in code: only the calling organization's own document.
resource "google_storage_bucket_iam_member" "vertex_ai_documents_viewer" {
  count = local.document_storage_enabled && local.ai_assist_enabled ? 1 : 0

  bucket = google_storage_bucket.documents[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:service-${data.google_project.this[0].number}@gcp-sa-aiplatform.iam.gserviceaccount.com"

  depends_on = [module.services]
}
