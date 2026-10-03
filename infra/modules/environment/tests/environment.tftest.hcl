# Offline tests: the Google provider is mocked, so they need no credentials and create nothing.
# Run from infra/modules/environment with `terraform init && terraform test`.

mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/test-project/serviceAccounts/mock-account@test-project.iam.gserviceaccount.com"
      email = "mock-account@test-project.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_apikeys_key" {
    defaults = {
      key_string = "mock-browser-key-not-a-real-one"
    }
  }

  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/github-actions"
    }
  }
}

variables {
  project_id         = "test-project"
  region             = "test-region"
  github_repository  = "example/repo"
  github_environment = "dev"
}

run "dev_deploys_three_apps" {
  command = plan

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
  }

  assert {
    condition     = length(module.app) == 3
    error_message = "dev must create the web, api and worker services."
  }

  assert {
    condition     = contains(module.app["web"].invoker_members, "allUsers") && contains(module.app["api"].invoker_members, "allUsers")
    error_message = "web and api must be public."
  }

  assert {
    condition     = !contains(module.app["worker"].invoker_members, "allUsers") && length(module.app["worker"].invoker_members) == 1
    error_message = "worker must not be public; only the deployer may call it."
  }

  assert {
    condition     = length(module.budget) == 0
    error_message = "No budget is created unless one is configured."
  }

  assert {
    condition     = alltrue([for app in module.app : !contains(keys(app.env), "IDENTITY_PLATFORM_PROJECT_ID")])
    error_message = "Without Firestore and Identity Platform, no service may turn auth on."
  }

  assert {
    condition     = !contains(keys(google_project_iam_member.planner), "roles/serviceusage.serviceUsageConsumer")
    error_message = "Without a budget, the planner must not get serviceusage.services.use."
  }
}

run "staging_and_prod_deploy_nothing" {
  command = plan

  variables {
    environment = "staging"
  }

  assert {
    condition     = length(module.app) == 0
    error_message = "Without deploy_apps no Cloud Run service may be created."
  }
}

# Apply runs against the mocked provider only; nothing real is created.
run "deployer_is_bound_to_the_github_environment" {
  command = apply

  variables {
    environment = "prod"
  }

  assert {
    condition     = endswith(google_service_account_iam_member.deployer_federation.member, "/attribute.environment/dev")
    error_message = "The deployer must only trust jobs in the configured GitHub environment."
  }

  assert {
    condition     = endswith(google_service_account_iam_member.planner_federation.member, "/attribute.ref/refs/heads/main")
    error_message = "The planner must only trust the main branch."
  }
}

# Staging and prod get their own identities, bound to their own GitHub environment, with the
# same minimal permissions as dev and no Cloud Run services.
run "staging_is_isolated_and_minimal" {
  command = apply

  variables {
    environment         = "staging"
    github_environment  = "staging"
    deletion_protection = true
  }

  assert {
    condition     = endswith(google_service_account_iam_member.deployer_federation.member, "/attribute.environment/staging")
    error_message = "The staging deployer must only trust jobs in the staging GitHub environment."
  }

  assert {
    condition     = length(google_project_iam_member.planner) == 0 && google_project_iam_member.planner_role.role == google_project_iam_custom_role.planner.id
    error_message = "Without a budget the planner holds only its custom read-only role."
  }

  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if startswith(p, "run.") || startswith(p, "datastore.") || startswith(p, "firebaseauth.")]) == 0
    error_message = "Without Cloud Run, Firestore or Identity Platform the planner gets no permission on them."
  }

  assert {
    condition     = google_artifact_registry_repository_iam_member.deployer_writer.role == "roles/artifactregistry.writer"
    error_message = "The deployer may only push images to this environment's repository."
  }

  assert {
    condition     = length(module.app) == 0 && length(module.budget) == 0
    error_message = "Staging creates no Cloud Run service and no budget unless one is configured."
  }

  assert {
    condition     = length(google_firestore_database.default) == 0 && length(google_firestore_index.audit_activity) == 0 && length(google_firestore_index.commercial) == 0 && length(google_firestore_index.agent_tasks) == 0 && length(google_firestore_index.ai_usage_events) == 0 && length(google_firestore_index.documents) == 0 && length(google_firestore_index.executions_sweep) == 0 && length(google_storage_bucket.documents) == 0 && length(google_identity_platform_config.default) == 0 && length(google_project_iam_member.api_firestore) == 0
    error_message = "Firestore and Identity Platform are dev only."
  }

  assert {
    condition     = !contains(module.services.services, "firestore.googleapis.com") && !contains(module.services.services, "identitytoolkit.googleapis.com")
    error_message = "Firestore and Identity Platform APIs are dev only."
  }

  assert {
    condition     = output.service_urls == {}
    error_message = "Staging must not expose any service URL."
  }
}

run "prod_is_isolated_and_minimal" {
  command = apply

  variables {
    environment         = "prod"
    github_environment  = "prod"
    deletion_protection = true
  }

  assert {
    condition     = endswith(google_service_account_iam_member.deployer_federation.member, "/attribute.environment/prod")
    error_message = "The prod deployer must only trust jobs in the prod GitHub environment."
  }

  assert {
    condition     = length(google_project_iam_member.planner) == 0 && google_project_iam_member.planner_role.role == google_project_iam_custom_role.planner.id
    error_message = "Without a budget the planner holds only its custom read-only role."
  }

  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if startswith(p, "run.") || startswith(p, "datastore.") || startswith(p, "firebaseauth.")]) == 0
    error_message = "Without Cloud Run, Firestore or Identity Platform the planner gets no permission on them."
  }

  assert {
    condition     = length(module.app) == 0
    error_message = "Production creates no Cloud Run service in Phase 1B."
  }

  assert {
    condition     = length(google_firestore_database.default) == 0 && length(google_firestore_index.audit_activity) == 0 && length(google_firestore_index.commercial) == 0 && length(google_firestore_index.agent_tasks) == 0 && length(google_firestore_index.ai_usage_events) == 0 && length(google_firestore_index.documents) == 0 && length(google_firestore_index.executions_sweep) == 0 && length(google_storage_bucket.documents) == 0 && length(google_identity_platform_config.default) == 0 && length(google_project_iam_member.api_firestore) == 0
    error_message = "Firestore and Identity Platform are dev only."
  }

  assert {
    condition     = !contains(module.services.services, "firestore.googleapis.com") && !contains(module.services.services, "identitytoolkit.googleapis.com")
    error_message = "Firestore and Identity Platform APIs are dev only."
  }
}

# A full mocked apply of dev with a budget exercises every resource's argument validation.
run "dev_with_budget_applies" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    budget = {
      billing_account_id = "000000-000000-000000"
      monthly_amount     = 10
      currency_code      = "USD"
      alert_emails       = ["alerts@example.com"]
    }
  }

  assert {
    condition     = length(module.budget) == 1
    error_message = "A configured budget must be created."
  }

  assert {
    condition     = contains(keys(google_project_iam_member.planner), "roles/serviceusage.serviceUsageConsumer")
    error_message = "With a budget, the planner needs serviceusage.services.use for the quota project."
  }
}

# Dev gets the Firestore database and Identity Platform (D-6), and only the api may use Firestore.
run "dev_gets_firestore_and_auth" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
  }

  assert {
    condition     = contains(module.services.services, "firestore.googleapis.com") && contains(module.services.services, "identitytoolkit.googleapis.com")
    error_message = "Dev must enable the Firestore and Identity Platform APIs."
  }

  assert {
    condition     = google_firestore_database.default[0].name == "(default)" && google_firestore_database.default[0].type == "FIRESTORE_NATIVE" && google_firestore_database.default[0].location_id == "test-region"
    error_message = "Dev must have the default Firestore database in Native mode, in the environment's region."
  }

  assert {
    condition     = google_firestore_database.default[0].deletion_policy == "ABANDON"
    error_message = "Terraform must never delete the Firestore database."
  }

  assert {
    condition     = google_firestore_index.audit_activity[0].collection == "auditLogs" && [for f in google_firestore_index.audit_activity[0].fields : "${f.field_path}:${f.order}"] == ["organizationId:ASCENDING", "action:ASCENDING", "occurredAt:DESCENDING"]
    error_message = "Dev must have the activity index on auditLogs (organizationId, action, occurredAt desc)."
  }

  assert {
    condition     = length(google_firestore_index.commercial) == 13 && alltrue([for i in google_firestore_index.commercial : contains(["contacts", "opportunities", "followUps"], i.collection) && i.fields[0].field_path == "organizationId"])
    error_message = "Dev must have Comercial's page indexes (ADR-0061), every one led by organizationId."
  }

  assert {
    condition     = google_firestore_index.agent_tasks[0].collection == "agentTasks" && [for f in google_firestore_index.agent_tasks[0].fields : "${f.field_path}:${f.order}"] == ["organizationId:ASCENDING", "specialistId:ASCENDING", "createdAt:DESCENDING"]
    error_message = "Dev must have the agent tasks index (ADR-0063): per organization and agent, newest first."
  }

  assert {
    condition     = google_firestore_index.ai_usage_events[0].collection == "aiUsageEvents" && [for f in google_firestore_index.ai_usage_events[0].fields : "${f.field_path}:${f.order}"] == ["organizationId:ASCENDING", "occurredAt:DESCENDING"]
    error_message = "Dev must have the AI usage events index (ADR-0074): per organization, newest first."
  }

  assert {
    condition     = google_firestore_index.documents[0].collection == "documents" && [for f in google_firestore_index.documents[0].fields : "${f.field_path}:${f.order}"] == ["organizationId:ASCENDING", "createdAt:DESCENDING"]
    error_message = "Dev must have the documents index (ADR-0078): per organization, newest first."
  }

  assert {
    condition     = google_firestore_index.executions_sweep[0].collection == "executions" && [for f in google_firestore_index.executions_sweep[0].fields : "${f.field_path}:${f.order}"] == ["status:ASCENDING", "updatedAt:ASCENDING"]
    error_message = "Dev must have the sweep index (ADR-0121): one status, oldest first."
  }

  assert {
    condition     = length(google_storage_bucket.documents) == 0 && length(google_storage_bucket_iam_member.api_documents_creator) == 0 && !contains(keys(module.app["api"].env), "DOCUMENTS_BUCKET") && !contains(module.services.services, "storage.googleapis.com")
    error_message = "Without document_storage there is no documents bucket, grant or setting."
  }

  assert {
    condition     = [for f in google_firestore_index.commercial["contacts_page"].fields : "${f.field_path}:${f.order}"] == ["organizationId:ASCENDING", "status:ASCENDING", "commercial.stage:ASCENDING", "updatedAt:DESCENDING"]
    error_message = "Contacts are paged newest change first, per organization, status and stage."
  }

  assert {
    condition     = google_identity_platform_config.default[0].sign_in[0].email[0].enabled && google_identity_platform_config.default[0].sign_in[0].email[0].password_required && !google_identity_platform_config.default[0].sign_in[0].allow_duplicate_emails
    error_message = "Identity Platform must allow email and password sign-in only, with unique emails."
  }

  assert {
    condition     = length(module.app["api"].env) == 4 && module.app["api"].env["IDENTITY_PLATFORM_PROJECT_ID"] == "test-project" && contains(keys(module.app["api"].env), "LOG_LEVEL") && contains(keys(module.app["api"].env), "WEB_ORIGINS") && module.app["api"].env["DEPLOYMENT_ENVIRONMENT"] == "dev"
    error_message = "The api must get this environment's project for auth and Firestore, the web origin, its environment, and nothing else new."
  }

  assert {
    condition     = length(google_project_iam_custom_role.vertex_ai_invoker) == 0 && length(google_project_iam_member.api_vertex_ai) == 0 && !contains(module.services.services, "aiplatform.googleapis.com") && !contains(keys(module.app["api"].env), "VERTEX_AI_PROJECT_ID")
    error_message = "Without ai_assist nothing may reach Vertex AI."
  }

  assert {
    condition     = !contains(keys(module.app["web"].env), "IDENTITY_PLATFORM_PROJECT_ID") && !contains(keys(module.app["worker"].env), "IDENTITY_PLATFORM_PROJECT_ID")
    error_message = "Only the api turns auth on; web and worker do not."
  }

  assert {
    condition     = google_project_iam_member.api_firestore[0].role == "roles/datastore.user" && google_project_iam_member.api_firestore[0].member == "serviceAccount:${module.app["api"].runtime_service_account}"
    error_message = "The api runtime identity reads and writes Firestore with datastore.user."
  }

  assert {
    condition     = length(google_project_iam_member.planner) == 0 && google_project_iam_member.planner_role.role == google_project_iam_custom_role.planner.id
    error_message = "Firestore and Identity Platform must not give the planner another role."
  }

  assert {
    condition = alltrue([for p in ["datastore.databases.get", "datastore.databases.getMetadata", "firebaseauth.configs.get", "run.services.get", "run.services.getIamPolicy"] :
    contains(google_project_iam_custom_role.planner.permissions, p)])
    error_message = "The planner must be able to read the Firestore database, Identity Platform config and Cloud Run metadata."
  }
}

# The execution runtime (ADR-0032): Cloud Tasks delivers jobs to the private worker, which alone
# of the new identities reads and writes Firestore. Only where the apps and Firestore exist.
run "dev_runs_the_execution_runtime" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
  }

  assert {
    condition     = contains(module.services.services, "cloudtasks.googleapis.com")
    error_message = "Dev must enable the Cloud Tasks API."
  }

  assert {
    condition     = google_cloud_tasks_queue.execution_jobs[0].name == "execution-jobs" && google_cloud_tasks_queue.execution_jobs[0].location == "test-region"
    error_message = "Dev must have one execution jobs queue in the environment's region."
  }

  assert {
    condition     = google_cloud_tasks_queue.execution_jobs[0].retry_config[0].max_attempts == 10 && google_cloud_tasks_queue.execution_jobs[0].rate_limits[0].max_concurrent_dispatches == 10
    error_message = "Queue retries and concurrency must stay bounded."
  }

  assert {
    condition     = length(module.app["worker"].invoker_members) == 2 && contains(module.app["worker"].invoker_members, "serviceAccount:${google_service_account.job_dispatch[0].email}") && !contains(module.app["worker"].invoker_members, "allUsers")
    error_message = "The worker must stay private: only the deployer and the job dispatch identity may call it."
  }

  assert {
    condition     = google_cloud_tasks_queue_iam_member.worker_enqueuer[0].role == "roles/cloudtasks.enqueuer" && google_cloud_tasks_queue_iam_member.worker_enqueuer[0].name == "execution-jobs"
    error_message = "The worker may only enqueue, and only on the execution jobs queue."
  }

  assert {
    condition     = google_service_account_iam_member.worker_acts_as_job_dispatch[0].role == "roles/iam.serviceAccountUser" && google_service_account_iam_member.worker_acts_as_job_dispatch[0].service_account_id == google_service_account.job_dispatch[0].name
    error_message = "The worker may act only as the job dispatch identity, to sign tasks' tokens."
  }

  assert {
    condition     = google_project_iam_member.worker_firestore[0].role == "roles/datastore.user" && google_project_iam_member.worker_firestore[0].member == "serviceAccount:${module.app["worker"].runtime_service_account}"
    error_message = "The worker reads and writes Firestore with datastore.user only."
  }

  assert {
    condition = alltrue([for k in ["FIRESTORE_PROJECT_ID", "DEPLOYMENT_ENVIRONMENT", "JOB_LEASE_MS", "JOB_QUEUE", "WORKER_URL", "JOB_INVOKER_EMAIL", "LOG_LEVEL"] :
    contains(keys(module.app["worker"].env), k)]) && length(module.app["worker"].env) == 7
    error_message = "The worker must get exactly its runtime settings."
  }

  assert {
    condition     = module.app["worker"].env["JOB_LEASE_MS"] == "900000" && module.app["worker"].env["DEPLOYMENT_ENVIRONMENT"] == "dev" && module.app["worker"].env["JOB_QUEUE"] == "projects/test-project/locations/test-region/queues/execution-jobs"
    error_message = "The worker's lease, environment and queue must come from this environment."
  }

  assert {
    condition     = module.app["worker"].env["WORKER_URL"] == "https://worker-123456789012.test-region.run.app"
    error_message = "The worker's URL must be its deterministic run.app URL."
  }

  assert {
    condition     = module.app["worker"].timeout == "900s" && module.app["api"].timeout == "30s" && module.app["web"].timeout == "30s"
    error_message = "Only the worker's requests may last as long as a lease."
  }

  assert {
    condition     = !anytrue([for m in [google_project_iam_member.worker_firestore[0].role, google_cloud_tasks_queue_iam_member.worker_enqueuer[0].role, google_service_account_iam_member.worker_acts_as_job_dispatch[0].role] : contains(["roles/owner", "roles/editor", "roles/datastore.owner", "roles/cloudtasks.admin", "roles/iam.serviceAccountAdmin"], m)])
    error_message = "No broad role for the runtime identities."
  }

  assert {
    condition     = contains(google_project_iam_custom_role.planner.permissions, "cloudtasks.queues.get") && contains(google_project_iam_custom_role.planner.permissions, "cloudtasks.queues.getIamPolicy")
    error_message = "The planner must be able to read the queue's metadata and IAM policy."
  }
}

# Web sign-in (ADR-0036): the browser signs in with Identity Platform using a restricted browser
# key, and the API answers CORS for the web's origin only.
run "dev_signs_in_on_the_web" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
  }

  assert {
    condition     = contains(module.services.services, "apikeys.googleapis.com") && contains(module.services.services, "securetoken.googleapis.com")
    error_message = "Dev must enable the API Keys and token refresh APIs."
  }

  assert {
    condition     = toset([for t in google_apikeys_key.web_sign_in[0].restrictions[0].api_targets : t.service]) == toset(["identitytoolkit.googleapis.com", "securetoken.googleapis.com"])
    error_message = "The browser key may call Identity Platform sign-in and token refresh only."
  }

  assert {
    condition     = length(google_apikeys_key.web_sign_in[0].restrictions[0].browser_key_restrictions[0].allowed_referrers) == 1 && google_apikeys_key.web_sign_in[0].restrictions[0].browser_key_restrictions[0].allowed_referrers[0] == "https://web-123456789012.test-region.run.app/*"
    error_message = "The browser key must only work from this environment's web app."
  }

  assert {
    condition     = length(module.app["web"].env) == 2 && module.app["web"].env["MELONOFFICE_API_URL"] == "https://api-123456789012.test-region.run.app" && module.app["web"].env["MELONOFFICE_IDENTITY_API_KEY"] == "mock-browser-key-not-a-real-one"
    error_message = "The web must get the API URL and the browser key, and nothing else."
  }

  assert {
    condition     = module.app["api"].env["WEB_ORIGINS"] == "https://web-123456789012.test-region.run.app" && !contains(keys(module.app["worker"].env), "WEB_ORIGINS")
    error_message = "Only the api allows the web's exact origin."
  }

  assert {
    condition     = contains(google_project_iam_custom_role.planner.permissions, "apikeys.keys.get") && contains(google_project_iam_custom_role.planner.permissions, "apikeys.keys.getKeyString")
    error_message = "The planner must be able to read the browser key it plans."
  }
}

run "no_web_sign_in_without_firestore_or_apps" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = length(google_apikeys_key.web_sign_in) == 0 && !contains(module.services.services, "apikeys.googleapis.com") && length([for p in google_project_iam_custom_role.planner.permissions : p if startswith(p, "apikeys.")]) == 0
    error_message = "Staging and prod get no browser key, API or planner permission."
  }
}

run "no_runtime_without_firestore_or_apps" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = length(google_cloud_tasks_queue.execution_jobs) == 0 && length(google_service_account.job_dispatch) == 0 && length(google_project_iam_member.worker_firestore) == 0
    error_message = "Staging and prod get no queue, dispatch identity or worker Firestore access."
  }

  assert {
    condition     = !contains(module.services.services, "cloudtasks.googleapis.com") && length([for p in google_project_iam_custom_role.planner.permissions : p if startswith(p, "cloudtasks.")]) == 0
    error_message = "Without the runtime, no Cloud Tasks API or planner permission."
  }
}

# The planner's custom role (ADR-0015) reads metadata and IAM policies only, never data, and
# replaces roles/viewer and roles/iam.securityReviewer.
run "planner_is_least_privilege" {
  command = apply

  variables {
    environment            = "dev"
    deploy_apps            = true
    deletion_protection    = false
    firestore_and_auth     = true
    terraform_state_bucket = "test-state-bucket"
  }

  assert {
    condition = !anytrue([for r in concat(keys(google_project_iam_member.planner), [google_project_iam_member.planner_role.role]) :
    contains(["roles/viewer", "roles/iam.securityReviewer", "roles/editor", "roles/owner"], r)])
    error_message = "The planner must not hold roles/viewer, roles/iam.securityReviewer or any basic role."
  }

  assert {
    condition     = google_project_iam_member.planner_role.member == "serviceAccount:${google_service_account.planner.email}" && google_project_iam_member.planner_role.role == google_project_iam_custom_role.planner.id
    error_message = "The planner must hold its custom role."
  }

  assert {
    condition     = alltrue([for p in google_project_iam_custom_role.planner.permissions : can(regex("\\.(get|list|getIamPolicy|getMetadata|getAttestationRules|getKeyString)$", p))])
    error_message = "Every planner permission must be a read of metadata or IAM policy: no create, update, delete, setIamPolicy, use or download."
  }

  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if can(regex("^datastore\\.(entities|statistics)\\.", p))]) == 0
    error_message = "The planner must not read or list Firestore documents."
  }

  # ADR-0049: index definitions are metadata (fields and order), not documents. The planner reads
  # them only to refresh the activity index, and never anything else under datastore.indexes.
  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if can(regex("^datastore\\.indexes\\.", p)) && !contains(["datastore.indexes.get", "datastore.indexes.list"], p)]) == 0
    error_message = "The planner may only get and list Firestore index definitions."
  }

  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if can(regex("^(firebaseauth\\.users|identitytoolkit\\.)", p))]) == 0
    error_message = "The planner must not read Identity Platform users or tenants."
  }

  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if can(regex("^(logging|secretmanager)\\.|downloadArtifacts$", p))]) == 0
    error_message = "The planner must not read logs, secrets or container images."
  }

  assert {
    condition     = length(google_project_iam_custom_role.planner.permissions) <= 25
    error_message = "The planner role must stay small; review ADR-0015 before widening it."
  }

  assert {
    condition     = google_storage_bucket_iam_member.planner_state[0].role == "roles/storage.objectViewer"
    error_message = "The planner reads the state bucket only; it can never write or lock the state."
  }
}

# Assisted AI (ADR-0038): the api alone may call Vertex AI models, with a custom role holding only
# the predict permission, and learns where the model runs from two plain settings.
run "dev_calls_vertex_ai" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    ai_assist           = true
  }

  assert {
    condition     = contains(module.services.services, "aiplatform.googleapis.com")
    error_message = "Assisted AI needs the Vertex AI API."
  }

  assert {
    condition     = google_project_iam_custom_role.vertex_ai_invoker[0].permissions == toset(["aiplatform.endpoints.predict"])
    error_message = "The Vertex AI role must hold the predict permission only."
  }

  assert {
    condition     = google_project_iam_member.api_vertex_ai[0].role == google_project_iam_custom_role.vertex_ai_invoker[0].id && google_project_iam_member.api_vertex_ai[0].member == "serviceAccount:${module.app["api"].runtime_service_account}"
    error_message = "Only the api runtime identity may call Vertex AI, through the custom role."
  }

  assert {
    condition     = module.app["api"].env["VERTEX_AI_PROJECT_ID"] == "test-project" && module.app["api"].env["VERTEX_AI_LOCATION"] == "test-region" && module.app["api"].env["DEPLOYMENT_ENVIRONMENT"] == "dev"
    error_message = "The api must know the environment and where Vertex AI runs the model."
  }

  assert {
    condition     = !contains(keys(module.app["worker"].env), "VERTEX_AI_PROJECT_ID") && !contains(keys(module.app["web"].env), "VERTEX_AI_PROJECT_ID")
    error_message = "Only the api calls Vertex AI."
  }

  assert {
    condition     = length([for m in google_project_iam_member.planner : m if can(regex("aiplatform", m.role))]) == 0 && length([for p in google_project_iam_custom_role.planner.permissions : p if startswith(p, "aiplatform.")]) == 0
    error_message = "Assisted AI must not widen the planner."
  }
}

run "no_vertex_ai_without_apps_and_firestore" {
  command = plan

  variables {
    environment = "staging"
    ai_assist   = true
  }

  assert {
    condition     = length(google_project_iam_custom_role.vertex_ai_invoker) == 0 && length(google_project_iam_member.api_vertex_ai) == 0 && !contains(module.services.services, "aiplatform.googleapis.com")
    error_message = "Without the apps and Firestore, ai_assist creates nothing."
  }
}

# Conversation agents (ADR-0043): the worker calls the same model with the same smallest role, and
# the api may hand turns to the same execution jobs queue. Nothing new is created.
run "dev_runs_conversation_agents" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    ai_assist           = true
    conversation_agents = true
  }

  assert {
    condition     = google_project_iam_member.worker_vertex_ai[0].role == google_project_iam_custom_role.vertex_ai_invoker[0].id && google_project_iam_member.worker_vertex_ai[0].member == "serviceAccount:${module.app["worker"].runtime_service_account}"
    error_message = "The worker may call Vertex AI only through the predict-only custom role."
  }

  assert {
    condition     = module.app["worker"].env["VERTEX_AI_PROJECT_ID"] == "test-project" && module.app["worker"].env["VERTEX_AI_LOCATION"] == "test-region"
    error_message = "The worker must know where Vertex AI runs the model."
  }

  assert {
    condition     = google_cloud_tasks_queue_iam_member.api_enqueuer[0].role == "roles/cloudtasks.enqueuer" && google_cloud_tasks_queue_iam_member.api_enqueuer[0].name == google_cloud_tasks_queue.execution_jobs[0].name && google_cloud_tasks_queue_iam_member.api_enqueuer[0].member == "serviceAccount:${module.app["api"].runtime_service_account}"
    error_message = "The api may enqueue on the execution jobs queue only."
  }

  assert {
    condition     = google_service_account_iam_member.api_acts_as_job_dispatch[0].service_account_id == google_service_account.job_dispatch[0].name && google_service_account_iam_member.api_acts_as_job_dispatch[0].role == "roles/iam.serviceAccountUser"
    error_message = "The api may act as the job dispatch identity only."
  }

  assert {
    condition     = module.app["api"].env["JOB_QUEUE"] == module.app["worker"].env["JOB_QUEUE"] && module.app["api"].env["WORKER_URL"] == module.app["worker"].env["WORKER_URL"] && module.app["api"].env["JOB_INVOKER_EMAIL"] == module.app["worker"].env["JOB_INVOKER_EMAIL"] && module.app["api"].env["JOB_LEASE_MS"] == module.app["worker"].env["JOB_LEASE_MS"]
    error_message = "The api must hand jobs over exactly as the worker does: same queue, target, identity and lease."
  }

  assert {
    condition     = length(google_cloud_tasks_queue.execution_jobs) == 1 && length(google_service_account.job_dispatch) == 1
    error_message = "Agents reuse the one queue and dispatch identity; nothing parallel is created."
  }

  assert {
    condition     = length(module.app["worker"].invoker_members) == 2 && contains(module.app["worker"].invoker_members, "serviceAccount:${google_service_account.job_dispatch[0].email}") && !contains(module.app["worker"].invoker_members, "allUsers")
    error_message = "The worker stays private: only the deployer and the dispatch identity invoke it."
  }

  assert {
    condition     = length(google_project_iam_member.api_channel_secrets) == 0 && !contains(keys(module.app["api"].env), "CHANNEL_SECRETS_PROJECT_ID")
    error_message = "Agents alone do not turn the WhatsApp channel on."
  }
}

run "no_conversation_agents_without_assisted_ai" {
  command = plan

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    conversation_agents = true
  }

  assert {
    condition     = length(google_project_iam_member.worker_vertex_ai) == 0 && length(google_cloud_tasks_queue_iam_member.api_enqueuer) == 0 && length(google_service_account_iam_member.api_acts_as_job_dispatch) == 0 && !contains(keys(module.app["api"].env), "JOB_QUEUE") && !contains(keys(module.app["worker"].env), "VERTEX_AI_PROJECT_ID")
    error_message = "Without assisted AI, conversation_agents creates nothing."
  }
}

# The Forecasting Engine (ADR-0059): one private forecaster, only the worker may call it, and the
# api and worker know its URL. No price is invented: without one, runs stay refused.
run "dev_runs_the_forecaster" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    ai_assist           = true
    conversation_agents = true
    forecasting         = true
  }

  assert {
    condition     = length(module.app) == 4 && !contains(module.app["forecaster"].invoker_members, "allUsers") && length(module.app["forecaster"].invoker_members) == 1
    error_message = "The forecaster must be a fourth, private service that only the deployer invokes through the module."
  }

  assert {
    condition     = google_cloud_run_v2_service_iam_member.worker_invokes_forecaster[0].role == "roles/run.invoker" && google_cloud_run_v2_service_iam_member.worker_invokes_forecaster[0].member == "serviceAccount:${module.app["worker"].runtime_service_account}" && google_cloud_run_v2_service_iam_member.worker_invokes_forecaster[0].name == module.app["forecaster"].name
    error_message = "Only the worker's identity may call the forecaster (besides the deployer)."
  }

  assert {
    condition     = module.app["forecaster"].resources == { cpu = "2", memory = "4Gi", concurrency = 1, max_instances = 1 }
    error_message = "The forecaster runs one forecast at a time, on 2 vCPU and 4 GiB, at most one instance."
  }

  assert {
    condition     = module.app["api"].env["FORECASTER_URL"] == "https://forecaster-123456789012.test-region.run.app" && module.app["worker"].env["FORECASTER_URL"] == module.app["api"].env["FORECASTER_URL"]
    error_message = "The api and worker must name the same forecaster URL."
  }

  assert {
    condition     = !contains(keys(module.app["api"].env), "FORECAST_CREDITS_PER_RUN") && !contains(keys(module.app["worker"].env), "FORECAST_CREDITS_PER_RUN")
    error_message = "Without a price set, no price is passed and runs stay refused."
  }

  assert {
    condition     = length(google_cloud_tasks_queue.execution_jobs) == 1 && length(google_service_account.job_dispatch) == 1
    error_message = "Forecasts reuse the one queue and dispatch identity; nothing parallel is created."
  }

  assert {
    condition     = module.app["web"].resources.cpu == "1" && module.app["api"].resources.concurrency == 80 && module.app["worker"].resources.max_instances == 2
    error_message = "The other services keep their resources."
  }
}

run "forecast_price_is_passed_when_set" {
  command = plan

  variables {
    environment              = "dev"
    deploy_apps              = true
    deletion_protection      = false
    firestore_and_auth       = true
    ai_assist                = true
    conversation_agents      = true
    forecasting              = true
    forecast_credits_per_run = 1
  }

  assert {
    condition     = module.app["api"].env["FORECAST_CREDITS_PER_RUN"] == "1" && module.app["worker"].env["FORECAST_CREDITS_PER_RUN"] == "1"
    error_message = "A price set is passed to the api and worker alike."
  }
}

run "no_forecaster_without_agents" {
  command = plan

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    forecasting         = true
  }

  assert {
    condition     = length(module.app) == 3 && length(google_cloud_run_v2_service_iam_member.worker_invokes_forecaster) == 0 && !contains(keys(module.app["api"].env), "FORECASTER_URL")
    error_message = "Without the api's queue access (conversation agents), forecasting creates nothing."
  }
}

run "rejects_a_fractional_forecast_price" {
  command = plan

  variables {
    environment              = "dev"
    forecast_credits_per_run = 0.5
  }

  expect_failures = [var.forecast_credits_per_run]
}

# The WhatsApp channel (ADR-0033): the api and worker read channel secrets only, by name, and
# Terraform never holds a secret value.
run "dev_turns_the_whatsapp_channel_on" {
  command = apply

  variables {
    environment                = "dev"
    deploy_apps                = true
    deletion_protection        = false
    firestore_and_auth         = true
    whatsapp_channel           = true
    whatsapp_graph_api_version = "v23.0"
  }

  assert {
    condition     = contains(module.services.services, "secretmanager.googleapis.com")
    error_message = "The channel needs the Secret Manager API."
  }

  assert {
    condition = alltrue([for m in [google_project_iam_member.api_channel_secrets[0], google_project_iam_member.worker_channel_secrets[0]] :
      m.role == "roles/secretmanager.secretAccessor" && m.condition[0].expression == "resource.name.startsWith(\"projects/123456789012/secrets/channel-\")"
    ])
    error_message = "The api and worker may read channel secrets only."
  }

  assert {
    condition     = google_project_iam_member.api_channel_secrets[0].member == "serviceAccount:${module.app["api"].runtime_service_account}" && google_project_iam_member.worker_channel_secrets[0].member == "serviceAccount:${module.app["worker"].runtime_service_account}"
    error_message = "Only the api and worker runtime identities read channel secrets."
  }

  assert {
    condition     = alltrue([for app in ["api", "worker"] : module.app[app].env["CHANNEL_SECRETS_PROJECT_ID"] == "test-project" && module.app[app].env["WHATSAPP_GRAPH_API_VERSION"] == "v23.0"])
    error_message = "The api and worker must know where channel secrets live and the Graph API version."
  }

  assert {
    condition     = !contains(keys(module.app["web"].env), "CHANNEL_SECRETS_PROJECT_ID")
    error_message = "The web never learns about channel secrets."
  }

  assert {
    condition     = length([for m in google_project_iam_member.planner : m if can(regex("secretmanager", m.role))]) == 0
    error_message = "The channel must not widen the planner."
  }
}

run "whatsapp_sending_stays_off_without_a_graph_version" {
  command = plan

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    whatsapp_channel    = true
  }

  assert {
    condition     = !contains(keys(module.app["worker"].env), "WHATSAPP_GRAPH_API_VERSION") && !contains(keys(module.app["api"].env), "WHATSAPP_GRAPH_API_VERSION")
    error_message = "Without a Graph API version, nothing may send."
  }
}

run "no_agents_or_channel_outside_dev_setups" {
  command = plan

  variables {
    environment         = "staging"
    ai_assist           = true
    conversation_agents = true
    whatsapp_channel    = true
  }

  assert {
    condition     = length(google_project_iam_member.worker_vertex_ai) == 0 && length(google_project_iam_member.api_channel_secrets) == 0 && length(google_project_iam_member.worker_channel_secrets) == 0 && !contains(module.services.services, "secretmanager.googleapis.com")
    error_message = "Without the apps and Firestore, agents and the channel create nothing."
  }
}

# Document uploads (ADR-0078): one private bucket in the environment's region, whose objects only
# the api's runtime identity may create and read, never replace or delete.
run "dev_stores_documents" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    document_storage    = true
  }

  assert {
    condition     = google_storage_bucket.documents[0].name == "test-project-documents" && google_storage_bucket.documents[0].location == "test-region"
    error_message = "The documents bucket is named after the project, in the environment's region."
  }

  assert {
    condition     = google_storage_bucket.documents[0].uniform_bucket_level_access && google_storage_bucket.documents[0].public_access_prevention == "enforced"
    error_message = "The documents bucket must use IAM only and can never be made public."
  }

  assert {
    condition     = !google_storage_bucket.documents[0].force_destroy && !google_storage_bucket.documents[0].versioning[0].enabled
    error_message = "Terraform must never empty the documents bucket, and objects are not versioned."
  }

  assert {
    condition     = google_storage_bucket_iam_member.api_documents_creator[0].role == "roles/storage.objectCreator" && google_storage_bucket_iam_member.api_documents_viewer[0].role == "roles/storage.objectViewer"
    error_message = "The api may create and read documents, never replace or delete them."
  }

  assert {
    condition = alltrue([for m in [google_storage_bucket_iam_member.api_documents_creator[0], google_storage_bucket_iam_member.api_documents_viewer[0]] :
      m.member == "serviceAccount:${module.app["api"].runtime_service_account}" && m.bucket == google_storage_bucket.documents[0].name
    ])
    error_message = "Only the api's runtime identity gets access, on the documents bucket only."
  }

  assert {
    condition     = module.app["api"].env["DOCUMENTS_BUCKET"] == "test-project-documents" && !contains(keys(module.app["worker"].env), "DOCUMENTS_BUCKET") && !contains(keys(module.app["web"].env), "DOCUMENTS_BUCKET")
    error_message = "Only the api learns where documents are kept."
  }

  assert {
    condition     = contains(module.services.services, "storage.googleapis.com")
    error_message = "Document uploads need the Cloud Storage API."
  }

  assert {
    condition     = contains(google_project_iam_custom_role.planner.permissions, "storage.buckets.get") && contains(google_project_iam_custom_role.planner.permissions, "storage.buckets.getIamPolicy") && length([for p in google_project_iam_custom_role.planner.permissions : p if startswith(p, "storage.objects.")]) == 0
    error_message = "The planner reads the bucket and its policy, never its objects."
  }

  assert {
    condition     = length(google_storage_bucket_iam_member.vertex_ai_documents_viewer) == 0
    error_message = "Without assisted AI, Vertex AI's service agent gets nothing on the documents bucket."
  }
}

# Reading scanned PDFs (ADR-0079): Vertex AI's own service agent reads the documents bucket's
# objects for a `gs://` reference, only where documents and assisted AI are both on.
run "dev_lets_vertex_ai_read_documents" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    document_storage    = true
    ai_assist           = true
  }

  assert {
    condition     = google_storage_bucket_iam_member.vertex_ai_documents_viewer[0].role == "roles/storage.objectViewer" && google_storage_bucket_iam_member.vertex_ai_documents_viewer[0].bucket == google_storage_bucket.documents[0].name
    error_message = "Vertex AI may only read objects of the documents bucket."
  }

  assert {
    condition     = google_storage_bucket_iam_member.vertex_ai_documents_viewer[0].member == "serviceAccount:service-123456789012@gcp-sa-aiplatform.iam.gserviceaccount.com"
    error_message = "The grant goes to the project's Vertex AI service agent, and no one else."
  }
}

run "no_vertex_ai_document_access_without_documents" {
  command = plan

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    ai_assist           = true
  }

  assert {
    condition     = length(google_storage_bucket_iam_member.vertex_ai_documents_viewer) == 0
    error_message = "Without document_storage, Vertex AI's service agent gets nothing."
  }
}

run "no_document_storage_without_apps_and_firestore" {
  command = plan

  variables {
    environment      = "staging"
    document_storage = true
  }

  assert {
    condition     = length(google_storage_bucket.documents) == 0 && length(google_storage_bucket_iam_member.api_documents_viewer) == 0 && !contains(module.services.services, "storage.googleapis.com")
    error_message = "Without the apps and Firestore, document_storage creates nothing."
  }
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}

# NVIDIA's API key (ADR-0080): with the owner's secret named, the api and worker may read that one
# secret and learn its reference; the web learns nothing. Without it, nothing changes.
run "dev_lets_the_api_and_worker_read_the_nvidia_key" {
  command = apply

  variables {
    environment           = "dev"
    deploy_apps           = true
    deletion_protection   = false
    firestore_and_auth    = true
    ai_assist             = true
    conversation_agents   = true
    nvidia_api_key_secret = "ai-nvidia-api-key"
  }

  assert {
    condition = alltrue([for m in [google_secret_manager_secret_iam_member.api_nvidia_key[0], google_secret_manager_secret_iam_member.worker_nvidia_key[0]] :
      m.role == "roles/secretmanager.secretAccessor" && m.secret_id == "ai-nvidia-api-key"
    ])
    error_message = "The api and worker may only read the NVIDIA key's secret."
  }

  assert {
    condition     = google_secret_manager_secret_iam_member.api_nvidia_key[0].member == "serviceAccount:${module.app["api"].runtime_service_account}" && google_secret_manager_secret_iam_member.worker_nvidia_key[0].member == "serviceAccount:${module.app["worker"].runtime_service_account}"
    error_message = "Only the api's and the worker's runtime identities get access."
  }

  assert {
    condition     = module.app["api"].env["NVIDIA_API_KEY_SECRET"] == "projects/test-project/secrets/ai-nvidia-api-key/versions/latest" && module.app["worker"].env["NVIDIA_API_KEY_SECRET"] == module.app["api"].env["NVIDIA_API_KEY_SECRET"] && !contains(keys(module.app["web"].env), "NVIDIA_API_KEY_SECRET")
    error_message = "The api and worker learn the key's reference; the web never does."
  }
}

run "nvidia_is_off_without_its_secret" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    ai_assist           = true
    conversation_agents = true
  }

  assert {
    condition     = length(google_secret_manager_secret_iam_member.api_nvidia_key) == 0 && length(google_secret_manager_secret_iam_member.worker_nvidia_key) == 0 && !contains(keys(module.app["api"].env), "NVIDIA_API_KEY_SECRET")
    error_message = "Without the owner's secret, NVIDIA gets nothing."
  }
}

run "nvidia_is_refused_outside_dev" {
  command = plan

  variables {
    environment           = "prod"
    nvidia_api_key_secret = "ai-nvidia-api-key"
  }

  expect_failures = [var.nvidia_api_key_secret]
}

# Operator access (ADR-0112): GitHub Actions jobs of the environment's GitHub environment run
# migrations, Firestore exports and read-only checks with their own identity, and nothing more.
run "dev_gives_the_operator_its_access" {
  command = apply

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    firestore_and_auth  = true
    operator_access     = true
  }

  assert {
    condition     = google_service_account.operator[0].account_id == "github-operator"
    error_message = "The operator has its own identity."
  }

  assert {
    condition     = endswith(google_service_account_iam_member.operator_federation[0].member, "/attribute.environment/dev") && google_service_account_iam_member.operator_federation[0].role == "roles/iam.workloadIdentityUser"
    error_message = "Only jobs in the dev GitHub environment may act as the operator."
  }

  assert {
    condition = toset(keys(google_project_iam_member.operator_roles)) == toset([
      "roles/datastore.user",
      "roles/datastore.importExportAdmin",
      "roles/run.viewer",
      "roles/cloudtasks.viewer",
      "roles/logging.viewer",
    ])
    error_message = "The operator holds exactly its five roles."
  }

  assert {
    condition = !anytrue([for r in keys(google_project_iam_member.operator_roles) :
    can(regex("(owner|editor|admin$|Admin$|iam\\.|secretmanager|run\\.developer|run\\.admin|datastore\\.owner)", r)) && r != "roles/datastore.importExportAdmin"])
    error_message = "The operator must not administer IAM, secrets, Cloud Run or Firestore itself."
  }

  assert {
    condition     = google_storage_bucket.operator_backups[0].name == "test-project-operator-backups" && google_storage_bucket.operator_backups[0].uniform_bucket_level_access && google_storage_bucket.operator_backups[0].public_access_prevention == "enforced" && !google_storage_bucket.operator_backups[0].force_destroy
    error_message = "The backups bucket is private, IAM only, and never emptied by Terraform."
  }

  assert {
    condition     = one(google_storage_bucket.operator_backups[0].lifecycle_rule[0].condition).age == 30 && one(google_storage_bucket.operator_backups[0].lifecycle_rule[0].action).type == "Delete"
    error_message = "Backups are kept 30 days."
  }

  assert {
    condition     = google_storage_bucket_iam_member.firestore_backups_writer[0].member == "serviceAccount:service-123456789012@gcp-sa-firestore.iam.gserviceaccount.com" && google_storage_bucket_iam_member.firestore_backups_writer[0].bucket == google_storage_bucket.operator_backups[0].name
    error_message = "Firestore's service agent writes exports into the backups bucket only."
  }

  assert {
    condition     = google_storage_bucket_iam_member.operator_backups_admin[0].bucket == google_storage_bucket.operator_backups[0].name && contains(module.services.services, "storage.googleapis.com")
    error_message = "The operator's storage access is on the backups bucket only, with the Storage API on."
  }

  assert {
    condition     = output.operator_service_account == google_service_account.operator[0].email && output.operator_backups_bucket == "test-project-operator-backups"
    error_message = "The operator's identity and bucket are outputs."
  }
}

run "no_operator_access_by_default_or_without_firestore" {
  command = plan

  variables {
    environment         = "dev"
    deploy_apps         = true
    deletion_protection = false
    operator_access     = true
  }

  assert {
    condition     = length(google_service_account.operator) == 0 && length(google_project_iam_member.operator_roles) == 0 && length(google_storage_bucket.operator_backups) == 0 && output.operator_service_account == null
    error_message = "Without Firestore there is no operator."
  }
}

run "staging_has_no_operator" {
  command = plan

  variables {
    environment         = "staging"
    github_environment  = "staging"
    deletion_protection = true
  }

  assert {
    condition     = length(google_service_account.operator) == 0 && length(google_storage_bucket.operator_backups) == 0
    error_message = "Operator access is off unless turned on."
  }
}
