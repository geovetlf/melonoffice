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

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}
