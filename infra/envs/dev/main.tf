# Phase 1B deploys dev: the web, api and worker services are created here.
# Phase 2 adds Firestore and Identity Platform to dev only (D-6).
# CV-5 lets the dev api call Vertex AI for assisted AI (D-7, ADR-0038).
# CV-6C lets conversation agents run in dev (ADR-0043) and turns on the WhatsApp channel's secrets.
module "environment" {
  source = "../../modules/environment"

  environment         = "dev"
  project_id          = var.project_id
  region              = var.region
  github_repository   = var.github_repository
  github_environment  = "dev"
  deploy_apps         = true
  firestore_and_auth  = true
  ai_assist           = true
  conversation_agents = true
  whatsapp_channel    = true
  # Meta Graph API version for sending; null keeps sending off until the owner sets it.
  whatsapp_graph_api_version = var.whatsapp_graph_api_version
  deletion_protection        = false
  terraform_state_bucket     = var.terraform_state_bucket
  budget                     = var.budget
}
