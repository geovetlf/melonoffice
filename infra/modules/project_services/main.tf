# Enables the Google Cloud APIs an environment needs. APIs stay enabled on destroy so that
# removing a module never breaks resources that other tooling still manages.
resource "google_project_service" "this" {
  for_each = toset(var.services)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
