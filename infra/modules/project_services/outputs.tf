output "services" {
  description = "Enabled API service names."
  value       = [for s in google_project_service.this : s.service]
}
