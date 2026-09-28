# ADR-0060: Business metrics and reports

- Status: Proposed
- Date: 2026-09-28
- Builds on:
  - ADR-0059 (Forecasting Engine): its metric catalogue, sources, periods and series preparation;
  - ADR-0048 (business profile) and ADR-0051 (Company Brain), for the time zone and the currency;
  - ADR-0053 and ADR-0054 (contacts, opportunities) and ADR-0033 (conversations), the records;
  - ADR-0019 (RBAC) and ADR-0040 (the office and its tools);
  - Geovet's brief of 2026-09-28 23:02Z: keep MelonOffice advancing while the Forecasting Engine waits for real data, with capabilities that serve several departments at once.
- Does not change:
  - Terraform, Cloud Run, queues, IAM or Firestore indexes;
  - TimesFM 2.5, the forecaster, the forecast queue, cache, credits or audit;
  - the AI Gateway and GIA.

## Context

The Forecasting Engine's catalogue already lists which departments each metric serves:

- sales won: Comercial, Dirección, Finanzas and Investigación;
- new leads: Comercial, Marketing, Dirección and Investigación;
- new conversations: Operaciones, Comercial, Marketing, Dirección and Investigación.

Its sources already add up each organization's records per day, week or month in the business's time zone. But the only way to see those figures was inside a forecast. The sidebar's Reports tool and every department's office were empty.

While level 3 of the Forecasting Engine waits for 28 days of real sales, a business needs to see what it has recorded and how close it is to a projection. Geovet's rules apply:

- no parallel architecture;
- no model where a rule is enough;
- no invented data;
- real data kept apart from predictions.

## Decision

### 1. One catalogue and one set of sources, read without the model

`createMetricHistory` (`packages/forecasting/src/history.ts`) reads the same `FORECAST_METRICS`, through the same `createRecordSources` and the same business context as the engine. It has no model, scheduler, credits or audit dependency, so it cannot run or charge anything.

A report and a projection of the same metric always agree on which records count and on period boundaries.

### 2. What a read returns

A read covers the last N complete periods, 30 days, 12 weeks or 12 months by default, up to 366 days, 104 weeks or 36 months. It returns:

- each period's value, with absent periods as zero because the metric declares `absentPeriod: zero`;
- the total and average;
- the total of the same number of periods just before, or null when nothing was recorded before;
- the period under way, "so far", kept out of every total and comparison;
- the first period with a record;
- **readiness**: the engine's own `prepareSeries` over the complete periods. This gives the exact counts a forecast request would get, such as 12 of 28 days, or 3 of 5 days with activity.

### 3. Permissions and isolation

- A new permission, `report.read`, for owners, plus the metric's own record permission (`opportunity.read`, `contact.read` or `conversation.read`).
- GIA keeps the person's permissions; the runtime actor has none.
- The tenant comes from the token. Sources only ever read `organizationId`'s records.
- Reads are not audited, like the other list reads. Nothing is written.

### 4. HTTP

- `GET /v1/organizations/:id/metrics` lists the metrics, each with `readable`.
- `GET /v1/organizations/:id/metrics/:metricId?frequency=&periods=&entity=` returns the history.
- Errors use the engine's codes. A missing business profile or currency is `invalid_request` with `field` `business_context` or `entity`.
- The routes work wherever the conversation records exist. They do not need the forecasting configuration.

### 5. Web

- The sidebar's Reports tool becomes real for `report.read`.
- Every department office shows the metrics that serve its catalogue type. No code names a department: the list is data.
- Figures are labelled as recorded, never projections. A missing profile or currency links to Company memory.

## Consequences

- Dirección, Comercial, Marketing, Operaciones, Finanzas and Investigación get real reports at once. A new metric appears everywhere once it is in the catalogue with a source.
- GIA can next answer past figures ("¿cuánto vendimos este mes?") from here, keeping recorded figures apart from the engine's projections.
- Sources still load an organization's whole collections, as the engine does. Paging or aggregates are needed before large organizations.
- Level 3 of the Forecasting Engine is unchanged and still blocked by real business data. Readiness only shows how far each metric is from it.

## Alternatives rejected

- **A separate reports package with its own aggregation**: it would duplicate the engine's sources and could disagree with them.
- **Reports through the forecast endpoint**: they would need `forecast.run` and a price, for no model run.
- **Stored daily aggregates**: a new collection, writer and index, which the current volumes do not need.
