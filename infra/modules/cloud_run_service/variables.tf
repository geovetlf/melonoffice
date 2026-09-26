variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
}

variable "name" {
  description = "Service name. It also prefixes the runtime service account, so keep it short."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,20}[a-z0-9]$", var.name))
    error_message = "name must be 2-22 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "initial_image" {
  description = "Image used only when the service is first created. CD replaces it."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "health_path" {
  description = "HTTP path for the startup and liveness probes."
  type        = string
  default     = "/health"
}

variable "public" {
  description = "Allow unauthenticated requests."
  type        = bool
  default     = false
}

variable "invoker_members" {
  description = "IAM members allowed to call a private service, keyed by a static label."
  type        = map(string)
  default     = {}
}

variable "developer_members" {
  description = "IAM members allowed to deploy new revisions of this service only, keyed by a static label."
  type        = map(string)
  default     = {}
}

variable "env" {
  description = "Plain, non-secret environment variables."
  type        = map(string)
  default     = {}
}

variable "cpu" {
  description = "CPU limit per instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per instance."
  type        = string
  default     = "512Mi"
}

variable "min_instances" {
  description = "Minimum instances. Zero lets the service scale to zero."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum instances, which also caps cost."
  type        = number
  default     = 2
}

variable "concurrency" {
  description = "Maximum concurrent requests per instance."
  type        = number
  default     = 80
}

variable "deletion_protection" {
  description = "Prevent Terraform from deleting the service."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Labels applied to the service."
  type        = map(string)
  default     = {}
}
