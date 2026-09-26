output "budget_name" {
  description = "Resource name of the budget."
  value       = google_billing_budget.this.name
}
