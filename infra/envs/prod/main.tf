# Phase 1B prepares production but deploys nothing: no Cloud Run services are created.
module "environment" {
  source = "../../modules/environment"

  environment            = "prod"
  project_id             = var.project_id
  region                 = var.region
  github_repository      = var.github_repository
  github_environment     = "prod"
  deploy_apps            = false
  deletion_protection    = true
  terraform_state_bucket = var.terraform_state_bucket
  budget                 = var.budget
}
