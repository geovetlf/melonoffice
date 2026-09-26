variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Region of the repository. It should match the Cloud Run region."
  type        = string
}

variable "repository_id" {
  description = "Repository name."
  type        = string
}

variable "labels" {
  description = "Labels applied to the repository."
  type        = map(string)
  default     = {}
}

variable "keep_recent_versions" {
  description = "Image versions per package that are never cleaned up."
  type        = number
  default     = 10
}

variable "delete_older_than_days" {
  description = "Image versions older than this are deleted unless kept by keep_recent_versions."
  type        = number
  default     = 30
}
