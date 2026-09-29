# Phase 1B deploys dev: the web, api and worker services are created here.
# Phase 2 adds Firestore and Identity Platform to dev only (D-6).
# CV-5 lets the dev api call Vertex AI for assisted AI (D-7, ADR-0038).
# CV-6C lets conversation agents run in dev (ADR-0043) and turns on the WhatsApp channel's secrets.
# The Forecasting Engine (ADR-0059) adds the private forecaster (TimesFM 2.5). One model run costs
# 1 credit (Geovet, 2026-09-28); cache hits, refusals and the fallback cost nothing.
# DOC-1 adds a private bucket for uploaded documents, which only the api reads and writes (ADR-0078).
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
  forecasting         = true
  document_storage    = true
  # Whole credits per forecast run (ADR-0059), set by Geovet on 2026-09-28.
  forecast_credits_per_run = 1
  # Meta Graph API version for sending, as Meta shows it for the DEV app (App settings → Advanced).
  whatsapp_graph_api_version = "v26.0"
  deletion_protection        = false
  terraform_state_bucket     = var.terraform_state_bucket
  budget                     = var.budget
  # NVIDIA's API key secret (ADR-0080), once the owner has created it. Null: NVIDIA is off.
  nvidia_api_key_secret = var.nvidia_api_key_secret

  # Who may open the platform AI view (ADR-0082). Empty: nobody.
  platform_admin_user_ids = var.platform_admin_user_ids
}
