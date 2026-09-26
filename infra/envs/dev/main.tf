# Phase 1B deploys dev: the web, api and worker services are created here.
module "environment" {
  source = "../../modules/environment"

  environment            = "dev"
  project_id             = var.project_id
  region                 = var.region
  github_repository      = var.github_repository
  github_environment     = "dev"
  deploy_apps            = true
  deletion_protection    = false
  terraform_state_bucket = var.terraform_state_bucket
  budget                 = var.budget
}
