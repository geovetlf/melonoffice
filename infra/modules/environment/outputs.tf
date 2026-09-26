output "service_urls" {
  description = "Default run.app URL of each deployed service."
  value       = { for k, m in module.app : k => m.uri }
}

output "artifact_registry_url" {
  description = "Docker path images are pushed to."
  value       = module.registry.repository_url
}

output "workload_identity_provider" {
  description = "Value for the GCP_WORKLOAD_IDENTITY_PROVIDER GitHub variable."
  value       = module.github_oidc.provider_name
}

output "deployer_service_account" {
  description = "Value for the GCP_DEPLOYER_SERVICE_ACCOUNT GitHub variable."
  value       = google_service_account.deployer.email
}

output "planner_service_account" {
  description = "Value for the GCP_PLANNER_SERVICE_ACCOUNT GitHub variable."
  value       = google_service_account.planner.email
}
