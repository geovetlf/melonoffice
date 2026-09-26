# Offline tests: the Google provider is mocked, so they need no credentials and create nothing.
# Run from infra/modules/github_oidc with `terraform init && terraform test`.

mock_provider "google" {}

variables {
  project_id        = "test-project"
  github_repository = "example/repo"
}

run "only_this_repository_is_trusted" {
  command = plan

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository == \"example/repo\""
    error_message = "Tokens from any other repository must be rejected."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    error_message = "Only GitHub Actions may issue the tokens."
  }

  assert {
    condition = alltrue([
      for key in ["google.subject", "attribute.repository", "attribute.ref", "attribute.environment"] :
      contains(keys(google_iam_workload_identity_pool_provider.github.attribute_mapping), key)
    ])
    error_message = "The ref and environment attributes are needed to restrict the planner and deployer."
  }
}

run "rejects_a_malformed_repository" {
  command = plan

  variables {
    github_repository = "not a repository"
  }

  expect_failures = [var.github_repository]
}
