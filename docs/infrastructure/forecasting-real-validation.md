# Forecasting Engine: real validation in dev (level 3)

This is the check that closes level 3 of the Forecasting Engine ([ADR-0059](../adr/0059-forecasting-engine.md)). It needs **real business records**. Synthetic series only prove that TimesFM runs (level 1). They never close this level.

Status: **BLOCKED BY REAL BUSINESS DATA**. The organization under test needs at least 28 days of recorded history for the metric, with sales on at least 5 of those days.

## Before you start

1. Check that the history is real and long enough. Ask GIA, in the dev web app (`https://web-<project number>.us-central1.run.app`), "Proyecta nuestras ventas de los próximos 30 días".
   - If she answers with the recorded and needed days (for example "12 de 28 días"), the level is still blocked.
   - Stop there. That answer ran nothing and charged nothing.
2. Write down the organization's credit balance from `GET /v1/organizations/:id/credits`, or from the credits screen.

## The run

1. Ask the same question once. Expect:
   - GIA's answer has HISTORY and PROJECTION apart, and is labelled as a projection by the forecasting model;
   - the balance is 1 credit lower for the run (`FORECAST_CREDITS_PER_RUN = 1`), plus GIA's usual 1 credit per message.
2. Ask it again with the same words. Expect:
   - the same forecast id, from the cache;
   - no second run charge (only GIA's message credit).
3. Check the logs in Cloud Logging, filtered by `jsonPayload.message`:

   | Service  | What to look for                                                                                                                                     |
   | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `api`    | `forecast.cache_miss` on the first ask, `forecast.cache_hit` on the second                                                                           |
   | `worker` | `forecast.completed` for that forecast, with `model` `timesfm-2.5-200m`, `fallback: false`, `credits: 1`, and `inferenceMs` and `memoryMb` filled in |

   If the worker logs `forecast.model_failed` and GIA says the result is "a simple estimate", the fallback ran. Record that; it does not close level 3.

4. Check the audit log. For the organization, `auditLogs` should hold:
   - `forecast.requested` with reason `cache_miss`;
   - then `forecast.completed` with reason `model` (`fallback` if the simple estimate ran);
   - codes only, never values.
5. Check isolation: every `organizationId` in those logs is the organization under test.

## What closes level 3

All of the following, on real records:

- a completed forecast by the model;
- a 10–90 band present;
- the run charge made once;
- the cache hit;
- the audit trail.

Keep the evidence (screenshots, log lines and the forecast id) in the activation report.
