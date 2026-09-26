# Spend alert for one project. It only notifies: it never stops services or disables billing.
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_emails)

  project      = var.project_id
  display_name = "Budget alerts (${each.value})"
  type         = "email"
  labels = {
    email_address = each.value
  }
}

resource "google_billing_budget" "this" {
  billing_account = var.billing_account_id
  display_name    = var.display_name

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.monthly_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.thresholds
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
    # Billing account administrators keep receiving the default emails.
    disable_default_iam_recipients = false
  }
}
