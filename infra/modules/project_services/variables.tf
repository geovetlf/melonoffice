variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "services" {
  description = "API service names to enable, for example run.googleapis.com."
  type        = list(string)
}
