variable "project_id" {
  description = "Google Cloud project ID of this environment."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry."
  type        = string
}

variable "github_repository" {
  description = "Repository whose workflows may authenticate, as owner/name."
  type        = string
  default     = "geovetlf/melonoffice"
}

variable "terraform_state_bucket" {
  description = "Bucket holding the Terraform state, so the read-only planner can read it."
  type        = string
  default     = null
}

variable "budget" {
  description = "Monthly spend alert for this project. Leave null to skip it."
  type = object({
    billing_account_id = string
    monthly_amount     = number
    currency_code      = string
    alert_emails       = optional(list(string), [])
  })
  default = null
}
