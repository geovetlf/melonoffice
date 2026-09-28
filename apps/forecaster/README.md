# Forecaster

The model runtime of MelonOffice's Forecasting Engine (ADR-0059): Google's TimesFM 2.5
(`timesfm==2.0.2`, checkpoint `google/timesfm-2.5-200m-pytorch` at a pinned revision) on CPU,
behind a private HTTP endpoint that only the worker may call.

- `GET /health`: the pinned model id and version.
- `POST /v1/forecast`: exactly `{values, horizon, frequency}`; answers the median and the
  0.1–0.9 quantiles per period. It keeps nothing and logs no values.

The engine (`packages/forecasting`) decides everything else: permissions, data, cache, credits,
audit, fallback. This service only runs the model.

Tests: `python3 -m unittest discover -s tests -t .` (the model test runs only where `timesfm`
is installed; the image has it).
