output "repository_id" {
  description = "Repository name."
  value       = google_artifact_registry_repository.this.repository_id
}

output "repository_url" {
  description = "Docker host and path used to tag images, for example europe-west1-docker.pkg.dev/project/repo."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.this.repository_id}"
}
