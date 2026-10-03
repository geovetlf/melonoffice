# Production monitoring of one environment (G-6, ADR-0136): log-based metrics over the structured
# logs the apps already write, alert policies on them and on Cloud Run's own metrics, and uptime
# checks of the public services. It reads logs and metrics only: it never changes a service. The
# alerts notify the budget's email channels (an extension of what exists, not a second system).

locals {
  user_metric = "logging.googleapis.com/user"
  run_logs    = "resource.type=\"cloud_run_revision\""
}

# ---------------------------------------------------------------------------------------------
# Log-based metrics. Each counts entries by a stable message and stable codes, never content.

# Errors of the api, the worker and the web: any entry at ERROR or above, by service.
resource "google_logging_metric" "app_errors" {
  project     = var.project_id
  name        = "melonoffice_app_errors"
  description = "Log entries at ERROR or above, by Cloud Run service."
  filter      = "${local.run_logs} AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "service"
      value_type = "STRING"
    }
  }
  label_extractors = {
    service = "EXTRACT(resource.labels.service_name)"
  }
}

# Agent tasks that ended failed, by failure code (the worker's `agent_task.finished`).
resource "google_logging_metric" "agent_tasks_failed" {
  project     = var.project_id
  name        = "melonoffice_agent_tasks_failed"
  description = "Agent tasks that ended failed, by failure code."
  filter      = "${local.run_logs} AND jsonPayload.message=\"agent_task.finished\" AND jsonPayload.outcome=\"failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "code"
      value_type = "STRING"
    }
  }
  label_extractors = {
    code = "EXTRACT(jsonPayload.code)"
  }
}

# The Agent Guardian's warnings (ADR-0132), by severity and finding code.
resource "google_logging_metric" "guardian_warnings" {
  project     = var.project_id
  name        = "melonoffice_guardian_warnings"
  description = "Agent Guardian warnings on agent answers, by severity and finding code."
  filter      = "${local.run_logs} AND jsonPayload.message=\"agent_guardian.warning\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "severity"
      value_type = "STRING"
    }
    labels {
      key        = "code"
      value_type = "STRING"
    }
  }
  label_extractors = {
    severity = "EXTRACT(jsonPayload.guardianSeverity)"
    code     = "EXTRACT(jsonPayload.code)"
  }
}

# Executions the stale sweep closed (AE-8, ADR-0121): work that got stuck.
resource "google_logging_metric" "stale_executions" {
  project     = var.project_id
  name        = "melonoffice_stale_executions"
  description = "Executions closed as stale by the sweep: work that got stuck."
  filter      = "${local.run_logs} AND jsonPayload.message=\"execution abandoned\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# The provider cost of each AI call the AI Gateway completed, in micro-USD.
resource "google_logging_metric" "ai_cost" {
  project     = var.project_id
  name        = "melonoffice_ai_cost_micro_usd"
  description = "Provider cost of each completed AI call, in millionths of a US dollar."
  filter      = "${local.run_logs} AND jsonPayload.message=\"ai request completed\" AND jsonPayload.costMicroUsd>=0"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
  }
  value_extractor = "EXTRACT(jsonPayload.costMicroUsd)"
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 32
      growth_factor      = 2
      scale              = 1
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Uptime checks of the public services, on the /health endpoint CD already checks.

resource "google_monitoring_uptime_check_config" "health" {
  for_each = var.uptime_hosts

  project      = var.project_id
  display_name = "melonoffice-${var.environment} ${each.key} /health"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Alert policies. They only notify.

resource "google_monitoring_alert_policy" "uptime" {
  for_each = var.uptime_hosts

  project               = var.project_id
  display_name          = "melonoffice-${var.environment}: ${each.key} is down"
  combiner              = "OR"
  notification_channels = var.notification_channel_ids

  conditions {
    display_name = "${each.key} /health fails from more than one location"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.health[each.key].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
    }
  }

  documentation {
    content   = "The ${each.key} service of melonoffice-${var.environment} does not answer /health. Check Cloud Run and the last deploy."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "errors" {
  project               = var.project_id
  display_name          = "melonoffice-${var.environment}: error rate"
  combiner              = "OR"
  notification_channels = var.notification_channel_ids

  conditions {
    display_name = "More than ${var.thresholds.errors_per_5m} errors in 5 minutes"
    condition_threshold {
      filter          = "metric.type=\"${local.user_metric}/${google_logging_metric.app_errors.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.thresholds.errors_per_5m
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content   = "Errors in melonoffice-${var.environment} logs. Open Logs Explorer with severity>=ERROR."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "api_latency" {
  count = var.api_service == null ? 0 : 1

  project               = var.project_id
  display_name          = "melonoffice-${var.environment}: api latency"
  combiner              = "OR"
  notification_channels = var.notification_channel_ids

  conditions {
    display_name = "api p95 latency above ${var.thresholds.api_latency_p95_ms} ms for 10 minutes"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.api_service}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.thresholds.api_latency_p95_ms
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }

  documentation {
    content   = "The api of melonoffice-${var.environment} is slow. Check Cloud Run and Firestore."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "failed_agent_tasks" {
  project               = var.project_id
  display_name          = "melonoffice-${var.environment}: failed agent tasks"
  combiner              = "OR"
  notification_channels = var.notification_channel_ids

  conditions {
    display_name = "More than ${var.thresholds.failed_agent_tasks_per_1h} agent tasks failed in 1 hour"
    condition_threshold {
      filter          = "metric.type=\"${local.user_metric}/${google_logging_metric.agent_tasks_failed.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.thresholds.failed_agent_tasks_per_1h
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content   = "Agent tasks of melonoffice-${var.environment} are failing. The metric melonoffice_agent_tasks_failed shows which codes."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "stale_executions" {
  project               = var.project_id
  display_name          = "melonoffice-${var.environment}: stuck work"
  combiner              = "OR"
  notification_channels = var.notification_channel_ids

  conditions {
    display_name = "The stale sweep closed an execution"
    condition_threshold {
      filter          = "metric.type=\"${local.user_metric}/${google_logging_metric.stale_executions.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content   = "An execution of melonoffice-${var.environment} got stuck and was closed as failed (stale_execution). Check the worker and Cloud Tasks."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "ai_cost" {
  project               = var.project_id
  display_name          = "melonoffice-${var.environment}: AI spend"
  combiner              = "OR"
  notification_channels = var.notification_channel_ids

  conditions {
    display_name = "AI provider cost above US$${var.thresholds.ai_cost_usd_per_day} in one day"
    condition_prometheus_query_language {
      query               = "sum(increase(logging_googleapis_com:user_${google_logging_metric.ai_cost.name}_sum{monitored_resource=\"cloud_run_revision\"}[1d])) > ${var.thresholds.ai_cost_usd_per_day * 1000000}"
      duration            = "0s"
      evaluation_interval = "300s"
    }
  }

  documentation {
    content   = "AI calls of melonoffice-${var.environment} cost more than usual today. The AI usage panel shows by organization and model."
    mime_type = "text/markdown"
  }
}
