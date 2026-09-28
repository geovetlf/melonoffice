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

output "env" {
  description = "Environment variables set on the container."
  value       = var.env
}

output "resources" {
  description = "CPU, memory, requests per instance and instances: what the service may use."
  value = {
    cpu           = var.cpu
    memory        = var.memory
    concurrency   = var.concurrency
    max_instances = var.max_instances
  }
}

output "timeout" {
  description = "Longest time one request may take."
  value       = google_cloud_run_v2_service.this.template[0].timeout
}
