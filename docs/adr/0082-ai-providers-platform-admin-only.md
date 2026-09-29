# ADR-0082: AI providers visible to the platform administrator only

- Status: Accepted (Geovet, 2026-09-29 19:49Z: "La vista de proveedores de IA debe ser exclusiva del administrador de la plataforma MelonOffice")
- Date: 2026-09-29
- Builds on: [ADR-0027](0027-ai-gateway-and-provider-registry.md) (AI Gateway), [ADR-0072](0072-llm-router.md) (router and health), [ADR-0074](0074-ai-usage-ledger.md) (usage ledger), [ADR-0081](0081-customer-credit-pricing.md) (provider cost vs customer credits).
- Terraform: optional. The variable `platform_admin_user_ids` (default empty) sets `PLATFORM_ADMIN_USER_IDS` on the API service; empty means nobody is a platform administrator.

## Context

MelonMotor chooses which AI provider and model serves each call. Before this ADR, a company owner could see that detail and MelonOffice's internal cost in three places:

- the AI usage page and API (`by.provider`, `by.model`, `costMicroUsd`, each event's provider and model);
- a plan's source (`source.model`) and its estimate (`costMicroUsd`);
- a forecast's `model` id.

GIA's forecast context also named the forecasting model.

Geovet decided the audiences.

- **The platform administrator** sees providers, models, capabilities, status, health, internal costs, limits, routing, fallback and technical configuration.
- **A company administrator** sees AI consumption, credits and its own charges, broken down by department, agent, workflow and capability. They "do not need to know or configure which provider or model MelonMotor used".
- **An end user** does not see providers or models, unless there is an explicit product reason.

## Decision

1. **Company-facing answers carry no provider, model or internal cost.**
   - `GET /v1/organizations/:id/ai-usage` returns operations and credits by capability, actor, user, agent, department, workflow and task type. `…/ai-usage/events` returns each operation's capability, outcome, credits and attribution.
   - A plan's source is only `planner` or `workflow`. Its estimates are in credits.
   - A forecast says only whether the forecasting model or the simple fallback made it.
   - GIA is told never to name an AI provider or model. It answers that it is GIA, powered by MelonMotor.
   - The ledger, audit and logs keep the full detail, unchanged.
2. **A platform administrator is configuration, not a company role.** `PLATFORM_ADMIN_USER_IDS` lists exact MelonOffice user ids (UUIDs), comma-separated. Empty means nobody. No company role, owner included, can grant it. GIA acting for a person never gets it.
3. **The platform AI view is read-only, under `/v1/platform/*`.**
   - `GET /v1/platform/access` returns `{ platformAdmin }` for the signed-in person, so the web knows whether to show the entry.
   - `GET /v1/platform/ai` returns:
     - providers, without credential references;
     - health, as the gateway's tracker has seen it on this instance;
     - models with price and terms;
     - every model policy (allowed models, fallback, attempts, per-call cost cap, environments).
   - `GET /v1/platform/ai-usage?from&to` returns the platform summary (internal cost and credits by provider, model and every other dimension) and each organization's totals with its name.
   - Anyone else gets `403 platform_forbidden`. Every read and every refusal is audited as `platform.ai_read`, with the view in `reference`.
4. **Nothing is duplicated.** The view reads the same registry, policy catalogue, health tracker and usage ledger that the one AI Gateway uses. The API now builds the tracker and passes it to the gateway, and the policy catalogue gains `list()`. `ledger.organizationTotals` replaces the operator CLI's own loop, so the CLI and the view share one computation.
5. **The web shows `/platform` only to a platform administrator**, as "Platform" in the sidebar. For everyone else there is no entry, not even "coming".

## Consequences

- A company sees what it pays and where it went, and nothing of how MelonMotor serves it.
- Provider and model changes never show to customers.
- Geovet makes himself a platform administrator by setting `platform_admin_user_ids` in DEV and applying (one environment variable changes on the API service). His MelonOffice user id is the document id in the `users` collection.
- The admin domain (D-4, `melonoffice.com/admi`) is still open. The view lives inside the app today, behind the allowlist. Moving it to the admin domain later changes only where the page is served.
- Budgets and spending alerts for companies need D-12 plan allotments. They are not built here.
