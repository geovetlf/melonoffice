variable "environment" {
  description = "Environment name."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "project_id" {
  description = "Google Cloud project ID of this environment. Each environment has its own project."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry."
  type        = string
}

variable "github_repository" {
  description = "Repository whose workflows may authenticate, as owner/name."
  type        = string
}

variable "github_environment" {
  description = "GitHub Actions environment whose jobs may use the deployer identity."
  type        = string
}

variable "deploy_apps" {
  description = "Create the web, api and worker Cloud Run services. Only dev is deployed in Phase 1B."
  type        = bool
  default     = false
}

variable "firestore_and_auth" {
  description = "Create the Firestore database and enable Identity Platform (D-6). Only dev in Phase 2."
  type        = bool
  default     = false
}

variable "ai_assist" {
  description = "Let the api call Vertex AI for assisted AI (ADR-0038). Needs the apps and Firestore. Only dev."
  type        = bool
  default     = false
}

variable "conversation_agents" {
  description = "Let conversation agents run (ADR-0043): the worker calls Vertex AI and the api hands agent turns to the execution jobs queue. Needs ai_assist. Only dev."
  type        = bool
  default     = false
}

variable "whatsapp_channel" {
  description = "Turn on the WhatsApp channel (ADR-0033, ADR-0034): the api and worker read channel secrets from this project's Secret Manager. Needs the runtime. Only dev."
  type        = bool
  default     = false
}

variable "whatsapp_graph_api_version" {
  description = "Meta Graph API version used to send WhatsApp messages, e.g. v23.0. Null leaves sending off (fails closed)."
  type        = string
  default     = null

  validation {
    condition     = var.whatsapp_graph_api_version == null || can(regex("^v[0-9]{1,3}\\.[0-9]$", var.whatsapp_graph_api_version))
    error_message = "whatsapp_graph_api_version must look like v23.0."
  }
}

variable "max_instances" {
  description = "Maximum instances per service."
  type        = number
  default     = 2
}

variable "deletion_protection" {
  description = "Prevent Terraform from deleting Cloud Run services."
  type        = bool
  default     = true
}

variable "log_level" {
  description = "LOG_LEVEL passed to the api and worker."
  type        = string
  default     = "info"
}

variable "job_lease_seconds" {
  description = "How long a job lease lasts (ADR-0032, provisional option A). It must exceed the longest tool (10 min) or model call; Cloud Tasks allows at most 30 min."
  type        = number
  default     = 900

  validation {
    condition     = var.job_lease_seconds >= 60 && var.job_lease_seconds <= 1800
    error_message = "job_lease_seconds must be between 60 and 1800."
  }
}

variable "terraform_state_bucket" {
  description = "Bucket holding this environment's Terraform state. When set, the planner can read it."
  type        = string
  default     = null
}

variable "budget" {
  description = "Monthly spend alert. Null means no budget is created."
  type = object({
    billing_account_id = string
    monthly_amount     = number
    currency_code      = string
    alert_emails       = optional(list(string), [])
  })
  default = null
}
