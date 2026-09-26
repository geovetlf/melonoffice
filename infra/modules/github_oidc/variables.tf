variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "pool_id" {
  description = "Workload identity pool ID."
  type        = string
  default     = "github-actions"
}

variable "github_repository" {
  description = "Repository allowed to authenticate, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/name."
  }
}
