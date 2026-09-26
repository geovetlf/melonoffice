output "pool_name" {
  description = "Full resource name of the pool, used to build principalSet members."
  value       = google_iam_workload_identity_pool.this.name
}

output "provider_name" {
  description = "Full resource name of the provider, used as workload_identity_provider in GitHub Actions."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "environment_principal_set" {
  description = "Prefix for a principalSet member that matches one GitHub environment. Append the environment name."
  value       = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.this.name}/attribute.environment/"
}

output "ref_principal_set" {
  description = "Prefix for a principalSet member that matches one Git ref. Append the ref, for example refs/heads/main."
  value       = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.this.name}/attribute.ref/"
}
