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
    condition     = length(google_firestore_database.default) == 0 && length(google_identity_platform_config.default) == 0 && length(google_project_iam_member.api_firestore) == 0
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
    condition     = length(google_firestore_database.default) == 0 && length(google_identity_platform_config.default) == 0 && length(google_project_iam_member.api_firestore) == 0
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
    condition     = google_identity_platform_config.default[0].sign_in[0].email[0].enabled && google_identity_platform_config.default[0].sign_in[0].email[0].password_required && !google_identity_platform_config.default[0].sign_in[0].allow_duplicate_emails
    error_message = "Identity Platform must allow email and password sign-in only, with unique emails."
  }

  assert {
    condition     = length(module.app["api"].env) == 2 && module.app["api"].env["IDENTITY_PLATFORM_PROJECT_ID"] == "test-project" && contains(keys(module.app["api"].env), "LOG_LEVEL")
    error_message = "The api must get this environment's project for auth and Firestore, and nothing else new."
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
    condition     = alltrue([for p in google_project_iam_custom_role.planner.permissions : can(regex("\\.(get|list|getIamPolicy|getMetadata|getAttestationRules)$", p))])
    error_message = "Every planner permission must be a read of metadata or IAM policy: no create, update, delete, setIamPolicy, use or download."
  }

  assert {
    condition     = length([for p in google_project_iam_custom_role.planner.permissions : p if can(regex("^datastore\\.(entities|indexes|statistics)\\.", p))]) == 0
    error_message = "The planner must not read or list Firestore documents."
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

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}
