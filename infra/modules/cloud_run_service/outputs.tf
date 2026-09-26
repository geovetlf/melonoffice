output "name" {
  description = "Service name."
  value       = google_cloud_run_v2_service.this.name
}

output "uri" {
  description = "Default run.app URL of the service."
  value       = google_cloud_run_v2_service.this.uri
}

output "runtime_service_account" {
  description = "Email of the runtime identity."
  value       = google_service_account.runtime.email
}

output "invoker_members" {
  description = "Members allowed to call the service; allUsers when it is public."
  value       = concat(var.public ? ["allUsers"] : [], values(var.invoker_members))
}
