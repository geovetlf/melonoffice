# ADR-0136: production monitoring, DEV first (G-6)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0015](0015-least-privilege-terraform-planner.md) (read-only planner), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) (stale sweep), [ADR-0132](0132-agent-guardian.md) (Guardian)
- Decision: Geovet, 2026-10-03 18:52Z, "Autorización: continuar auditoría MelonOffice", block G-6 Monitoring: Terraform and `terraform plan` only, no apply; stop on unexpected resources, destructive changes, replacements or changes outside DEV.
- Terraform: a new module `infra/modules/monitoring`, on in DEV only (`monitoring = true`). Staging and prod: no change. Firestore: none.

## Context

The apps write structured JSON logs (`@melonoffice/observability`): one object per line, with `severity` and a stable `message`. CD checks `/health` once per deploy. The budget alert is the only monitoring in Terraform. Nothing watched errors, latency, failing agent tasks, stuck work, Guardian warnings or AI spend between deploys.

## Decision

1. **Extend, not a second system.** One module of standard Cloud Monitoring and Cloud Logging resources reads the logs and metrics the services already produce. Its alerts notify the budget's email channels; the budget module now outputs their ids. There is no new notification system, agent or dashboard app.

2. **Log-based metrics.** They count stable messages and codes, never content:

   | Metric                           | Counts                                                  | Labels             |
   | -------------------------------- | ------------------------------------------------------- | ------------------ |
   | `melonoffice_app_errors`         | entries at ERROR or above                               | `service`          |
   | `melonoffice_agent_tasks_failed` | `agent_task.finished` with outcome `failed`             | `code`             |
   | `melonoffice_guardian_warnings`  | `agent_guardian.warning`                                | `severity`, `code` |
   | `melonoffice_stale_executions`   | `execution abandoned` (the stale sweep)                 |                    |
   | `melonoffice_ai_cost_micro_usd`  | `costMicroUsd` of `ai request completed` (distribution) |                    |

   The worker gains two log lines for this:
   - `agent_task.finished`, with the outcome and the failure code;
   - `agent_guardian.warning`, with the code and `guardianSeverity`.

   The logger keeps the key `severity` for the entry's level, so the Guardian's severity uses its own key.

3. **Uptime checks** of the web and the api on `/health`, every 5 minutes, at the Cloud Run URLs the module already derives.

4. **Alert policies.** They only notify, and each carries a short note on where to look:

   | Alert              | Fires when (technical default)                             |
   | ------------------ | ---------------------------------------------------------- |
   | web or api down    | `/health` fails from more than one location for 10 minutes |
   | error rate         | more than 10 errors in 5 minutes                           |
   | api latency        | p95 above 3,000 ms for 10 minutes                          |
   | failed agent tasks | more than 5 in 1 hour                                      |
   | stuck work         | the stale sweep closed any execution in 1 hour             |
   | AI spend           | provider cost above US$2 in one day                        |

   The thresholds are technical defaults, not product decisions. A person changes them with `monitoring_thresholds`.

5. **The planner reads what monitoring creates.** Its custom role gets three get permissions, and only where monitoring is on:
   - `logging.logMetrics.get`;
   - `monitoring.alertPolicies.get`;
   - `monitoring.uptimeCheckConfigs.get`.

   It still reads no log entries and writes nothing.

6. **Plan, not apply.** CD's read-only `terraform plan (dev)` shows the change. Geovet applies it in Cloud Shell when he decides.

## Not in this block

- **CD failures.** They happen in GitHub Actions, outside Google Cloud, and GitHub already emails the person who pushed. A Cloud Monitoring alert cannot see them.
- **Staging and production.** Once DEV has run for a while, they are turned on with the same variable, each with its own plan and approval.
- **Dashboards.** Metrics Explorer shows the metrics now. A dashboard can come later from the same metrics.

## Expected DEV plan

The DEV plan should show these, on top of what was already pending (DOC-2's one resource):

- **Add (14):** 5 log-based metrics, 2 uptime checks and 7 alert policies.
- **Change in place (1):** the planner's custom role, which gets the 3 read permissions.
- **Destroy (0), replace (0).**

`monitoring.googleapis.com` is already enabled when DEV has a budget; otherwise it is one more addition.

Staging and prod should show no changes.

## Cost

Uptime checks, log-based metrics and alert policies are billed by Cloud Monitoring above its free allotments. At this volume (2 checks every 5 minutes, 7 conditions, low log volume) the cost is expected to be well under US$1 a month, but this is an estimate from Google's public pricing, not a measured figure. The budget alert keeps watching total spend.
