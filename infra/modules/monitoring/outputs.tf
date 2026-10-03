output "log_metrics" {
  description = "Names of the log-based metrics."
  value = [
    google_logging_metric.app_errors.name,
    google_logging_metric.agent_tasks_failed.name,
    google_logging_metric.guardian_warnings.name,
    google_logging_metric.stale_executions.name,
    google_logging_metric.ai_cost.name,
  ]
}

output "uptime_checks" {
  description = "Uptime check ids, by service."
  value       = { for k, c in google_monitoring_uptime_check_config.health : k => c.uptime_check_id }
}

output "uptime_hosts" {
  description = "The hosts the uptime checks call, by service."
  value       = var.uptime_hosts
}
