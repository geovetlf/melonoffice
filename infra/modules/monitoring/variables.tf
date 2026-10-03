variable "project_id" {
  description = "Google Cloud project ID whose services are watched."
  type        = string
}

variable "environment" {
  description = "dev, staging or prod: named in the alerts."
  type        = string
}

variable "uptime_hosts" {
  description = "Public hosts checked on /health, by name (e.g. web, api), without https://."
  type        = map(string)
  default     = {}
}

variable "api_service" {
  description = "Cloud Run service name of the api, for its latency alert. Null: no latency alert."
  type        = string
  default     = null
}

variable "notification_channel_ids" {
  description = "Channels the alerts notify (the budget's email channels). Empty: incidents only show in the console."
  type        = list(string)
  default     = []
}

variable "thresholds" {
  description = "When each alert fires. Technical defaults (ADR-0136); a person may change them."
  type = object({
    # Log entries at ERROR or above across the services, in 5 minutes.
    errors_per_5m = optional(number, 10)
    # The api's 95th percentile request latency, in milliseconds, for 10 minutes.
    api_latency_p95_ms = optional(number, 3000)
    # Agent tasks that end failed, in 1 hour.
    failed_agent_tasks_per_1h = optional(number, 5)
    # AI provider cost recorded by the AI Gateway in one day, in US dollars.
    ai_cost_usd_per_day = optional(number, 2)
  })
  default = {}

  validation {
    condition = alltrue([
      var.thresholds.errors_per_5m > 0,
      var.thresholds.api_latency_p95_ms > 0,
      var.thresholds.failed_agent_tasks_per_1h > 0,
      var.thresholds.ai_cost_usd_per_day > 0,
    ])
    error_message = "Every threshold must be more than 0."
  }
}
