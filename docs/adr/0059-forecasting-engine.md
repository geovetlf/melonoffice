# ADR-0059: Forecasting Engine (TimesFM 2.5)

- Status: Proposed
- Date: 2026-09-28
- Builds on:
  - ADR-0019 (RBAC), ADR-0020 (audit), ADR-0023 (credits) and ADR-0029 (runtime actor);
  - ADR-0032 (worker and Cloud Tasks transport), reused by ADR-0043 and ADR-0058;
  - ADR-0048 and ADR-0051 (business profile and Company Brain);
  - ADR-0052 and ADR-0057 (GIA's chat and commercial intelligence);
  - ADR-0053 and ADR-0054 (contacts and opportunities), ADR-0033 (conversations);
  - the TimesFM 2.5 audit (`MelonOffice-TimesFM-2.5-Audit.md`) and Geovet's brief of 2026-09-28.
- Does not change:
  - the AI Gateway, its policy, providers or credit rate;
  - the job queue, its dispatch identity or the job runtime;
  - Company Brain's schema: it stores no series;
  - staging and prod: forecasting is off there.

## Context

MelonOffice had no time series, analytics or forecasting. Departments and GIA could say what happened, never what is likely next. Geovet asked for one reusable Forecasting Engine for MelonMotor, with Google's TimesFM 2.5 as its first model, explicitly not 3.x.

The audit found no legal or technical block: code and weights are Apache-2.0, not gated, and TimesFM 2.5 runs on CPU in about half a second per forecast with about 1.4 GB of memory. There was no Python service yet.

## Decision

### 1. Why a Forecasting Engine

A forecast is not a model call. It is a chain: check the person may read the data, read and aggregate the organization's own records, clean them without inventing values, key a cache, check and charge credits, queue a run, run the model, validate its output, keep history apart from projection, and audit all of it. Doing that once, in `packages/forecasting`, gives every consumer the same rules. A department screen, a report or GIA asks the engine for a metric and a horizon; none of them knows where the values come from or which model runs.

### 2. Why TimesFM 2.5

- It is a pretrained foundation model for time series: it forecasts a new series without training per business, which fits small businesses with short histories.
- It is Apache-2.0 for code and weights, and not gated, so it can be baked into a private image.
- It runs on CPU at small-business volume; no GPU is needed.
- It gives quantiles, so a projection comes with a band, not a false confidence figure.
- Everything is pinned: `timesfm==2.0.2` and the checkpoint `google/timesfm-2.5-200m-pytorch` at revision `d418f3e8a8fa79d655b391c158f0ee8d68fe68c9`. The forecaster refuses to start with another package version or checkpoint revision. 3.x is not used; moving to it would be a new decision.

### 3. Why a provider abstraction

The engine talks to a `ForecastModelProvider` (`{ model, forecast(input, signal) }`). TimesFM is one provider (`createTimesFMProvider`, HTTP to the private forecaster with a metadata ID token); the deterministic fallback (`seasonal_mean_v1`) is another. The model's id and version are part of the cache key and of every stored result, so changing or adding a model never mixes results. Tests use a fake provider.

TimesFM is not added to the AI Gateway. The gateway is built for generative models: text in and out, tokens, price per token, sensitivity and policy per request. A numeric forecast fits none of that, and forcing it in would bend the gateway's contract. The engine reuses what matters (credits, audit, permissions, the queue) without a second gateway.

### 4. Where it runs

- A Python service, `apps/forecaster`, is only the model runtime: `GET /health` and `POST /v1/forecast` with exactly `{values, horizon, frequency}`. It keeps nothing and logs no values. The weights are downloaded at image build time at the pinned revision; the service runs offline.
- Cloud Run, private: 2 vCPU, 4 GiB, one request per instance, at most one instance. Only the worker's identity (and the deployer, for health) may invoke it.
- The api validates, reads the data, checks the cache, credits and limits, stores a `queued` forecast with its audit event in one write, and puts `{organizationId, forecastId, run}` on the existing `execution-jobs` queue for the worker at `/internal/forecasts/run`. The worker calls the model, charges once and stores the result. A caller may wait a bounded time (`wait: true`) or read the forecast later.
- A failed delivery answers 503 and the queue retries. On the queue's last delivery the labelled fallback answers (free, `kind: 'fallback'`, with a warning), or the forecast is kept as failed; it never stays queued silently.

### 5. Data: authorized sources, no invented values

- Metrics are data (`FORECAST_METRICS`): `sales.won_value` (per currency), `sales.won_count`, `opportunities.new`, `leads.new` and `conversations.new`. Each names the permission that reads its records and the departments it serves. There are no orders, stock or campaign records yet, so there are no such metrics. GIA says so instead of answering with another metric.
- Sources read one organization's records through the existing repositories and aggregate them into days, weeks or months in the business's time zone. The current, incomplete period is left out.
- Preparation checks timestamps, duplicates, regularity and values. An absent period is zero, because every metric counts or sums events; this is declared per metric and recorded. Nulls are interpolated only in short gaps (at most 10% and 3 in a row); beyond that the answer is `missing_values`. Outliers are flagged, never removed. Too little history answers `insufficient_data` with how much there is and how much is needed, and no model runs.

### 6. Why Company Brain does not store series

Company Brain holds what the business is: facts a person confirms. A series is derived data that changes every day and already lives in its source records. Copying it would create a second truth to keep in sync and a large store of figures in a place built for a few confirmed facts. The engine reads only context from it: the time zone from the business profile, and the currency from Company Brain (`finance.currency`) or the profile.

### 7. Why TimesFM is not wired directly into GIA

- GIA keeps the person's permissions. The engine checks `forecast.run` and the metric's own read permission, so GIA cannot reach data the person cannot.
- A run costs credits and is a figure people act on. Only the person's current message, read by fixed rules (`forecastIntentOf`), asks for one; the chat model never decides to run a forecast, which metric or how far.
- GIA receives a `<forecast>` block computed in code: history and projection apart and labelled, totals, the approximate range and the trend. Her rules say to word it as an estimate, never as certain, with no confidence percentage; to say when it is the fallback; to say "no data" or "not supported" instead of a number.
- The same question gets the same forecast from the cache, so asking again or rephrasing does not run or charge twice.

### 8. Why there is no engine per department

Departments are catalogue data (D-11) and no code may assume how many there are. A metric lists the department types it serves; a request may name its department, which is checked and recorded for audit and observability. One engine, one cache, one set of limits and one audit trail serve all of them.

### 9. Permissions, credits, audit and limits

- New permissions `forecast.read` and `forecast.run`, owner only, plus the metric's source permission. The runtime actor may never request a forecast.
- Credits: the balance is checked before queuing and one charge is made when the model runs, with reference `forecast:{id}`, so a retry never charges twice. Cache hits, refusals, too little data and the fallback cost nothing. The price per run (`FORECAST_CREDITS_PER_RUN`) is not set: until the owner sets it, runs are refused with `forecast_price_not_set`.
- Audit: `forecast.requested`, `forecast.completed` and `forecast.failed`, with codes only (cache hit or miss, the problem, the model, the reason), never values.
- The cache key covers the organization, metric, entity, frequency, horizon, the exact input series, covariates and model version. A finished forecast answers for 24 hours.
- Limits are configuration: context 1024 periods, horizon 90 days, 26 weeks or 12 months (never past 128, where TimesFM 2.5 would switch to its autoregressive path), minimum history, 2 active runs per organization, a 120-second model timeout and a 20-second wait.
- Covariates are part of the contract and the cache key, but the runtime supports none (TimesFM's covariate path needs a GPU JAX stack). A request with covariates is refused, never silently ignored.

## Consequences

- A forecast is available to every department, report and GIA through one API: `GET /v1/organizations/:id/forecasts/metrics`, `POST .../forecasts` and `GET .../forecasts/:forecastId`.
- MelonOffice now runs one Python service. It is isolated: it has no data access and no Firestore, and it never calls out at run time (the weights are in the image, Hugging Face is offline).
- The image is large (torch and the weights). Its cold start is slow, which is why runs go through the queue and callers wait a bounded time.
- Nothing is operational until the owner applies the Terraform in dev, CD deploys the forecaster, and the price per run is set.

## Amendments

- 2026-09-28, GIA forecasting answers:
  - GIA words each refusal as the engine gave it. Recorded history that cannot be read as a series (`invalid_data`) is never called too little history.
  - A horizon beyond the longest allowed carries that limit (`ForecastError.limit`), so GIA names how far was asked and the longest allowed.
  - "Next year" and "N years" are read as months, and the engine refuses more than its limit.
  - The real validation that closes level 3 is in [forecasting-real-validation.md](../infrastructure/forecasting-real-validation.md).

## Alternatives rejected

- **TimesFM 3.x**: excluded by the brief.
- **TimesFM through the AI Gateway**: it would bend the gateway's generative contract (see 3).
- **Calling the model from the api request**: a cold start of the model would hold the request; the queue already exists.
- **Running the model inside the Node worker**: there is no maintained TypeScript runtime for TimesFM; Python is the supported one.
- **A GPU**: not needed at this volume; it would add fixed cost and quota.
- **Series in Company Brain**: see 6.
- **A forecaster per department**: see 8.
- **Zero-filling nulls**: that would invent data; bounded interpolation or `missing_values` instead.
