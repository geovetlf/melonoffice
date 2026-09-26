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
    condition     = google_project_iam_member.api_firestore[0].role == "roles/datastore.user" && google_project_iam_member.api_firestore[0].member == "serviceAccount:${module.app["api"].runtime_service_account}"
    error_message = "Only the api runtime identity may read and write Firestore."
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
