output "service_urls" {
  description = "Default run.app URL of each deployed service."
  value       = module.environment.service_urls
}

output "artifact_registry_url" {
  description = "Docker path images are pushed to."
  value       = module.environment.artifact_registry_url
}

output "workload_identity_provider" {
  description = "GitHub variable GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = module.environment.workload_identity_provider
}

output "deployer_service_account" {
  description = "GitHub variable GCP_DEPLOYER_SERVICE_ACCOUNT."
  value       = module.environment.deployer_service_account
}

output "planner_service_account" {
  description = "GitHub variable GCP_PLANNER_SERVICE_ACCOUNT."
  value       = module.environment.planner_service_account
}
