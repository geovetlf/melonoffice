output "budget_name" {
  description = "Resource name of the budget."
  value       = google_billing_budget.this.name
}

output "notification_channel_ids" {
  description = "The email notification channels, for other alerts to reuse."
  value       = [for c in google_monitoring_notification_channel.email : c.id]
}
