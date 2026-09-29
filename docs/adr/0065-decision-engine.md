# ADR-0065: Decision Engine (MelonMotor)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0019 (RBAC), ADR-0020 (audit), ADR-0026 (tools, approvals, guardrails);
  - ADR-0027 (AI Gateway) and ADR-0037 (assisted AI requests);
  - ADR-0051 (Company Brain), ADR-0052 (GIA's chat);
  - ADR-0057 (C4 commercial insights), ADR-0058 (C5 follow-ups);
  - ADR-0059 (Forecasting Engine), ADR-0062 to ADR-0064 (Agent Engine).
- Does not change:
  - any write path: no action, tool, message, payment or record is run or changed by a decision;
  - the C4 insight rules, the Forecasting Engine, Company Brain or the AI Gateway's checks;
  - who may approve (a person, directly, ADR-0026).
- Reference: `docs/architecture/decision-engine.md`.

## Context

Before this ADR, MelonMotor decided in several places, each with its own rules:

- GIA checked permissions and ports itself before preparing a fact, a follow-up or an agent task.
- C4 found what needed attention but gave no priority or next step.
- The Forecasting Engine predicted, but nothing said what a prediction called for.
- Company policies lived in Company Brain, but no rule read them.

Geovet chose option A of the audit ("Catálogo de acciones", 2026-09-29): one engine, on the existing services, with no second architecture.

## Decision

### 1. One package, `@melonoffice/decisions`, that decides and never executes

- `createDecisionEngine({ authorization, configured?, catalogue?, deciders?, ports?, audit?, now? })`.
- **Actions.** `evaluateAction`, `listActions` and `offers` answer which catalogue actions may be prepared for this person, and on what condition.
- **Decisions.** `evaluateDecision(tenant, { type, input?, preload?, requestId? })` returns a `DecisionResult`. `listDecisionTypes(tenant)` lists the decision types and whether this person may ask each one here.
- DECISION is separate from EXECUTION:
  - A result may recommend an action and say that it needs approval.
  - Carrying it out stays with the engine that owns it (follow-ups, agent tasks, the tool gate) and the person's confirmation.
  - The engine has no write port.

### 2. The action catalogue

`ACTION_CATALOGUE` is data. Each action has an id, a version, the permission it needs, a `confirmation` (`person_confirms` or `approval`), who may propose it (`gia`, `agent`) and a credit ceiling.

- **Today's actions:**
  - `knowledge.propose_fact`
  - `follow_up.schedule`
  - `agent_task.assign`
  - `opportunity.offer_discount` (decided on only: nothing carries it out yet, so the API marks it `not_configured`)
- **Why an action is unavailable.** The reason is a closed code:
  - `unresolved_tenant`
  - `requires_user` (GIA prepares for a person; an agent prepares as the runtime or for the person; GIA's own actor prepares nothing)
  - `permission_denied`
  - `proposer_not_allowed`
  - `not_configured`
  - `unknown_action`
- **GIA** now asks `offers` instead of checking permissions itself, so the chat and the screens get one answer.

### 3. Decision types (deciders)

A decider is data plus a pure `decide`. It declares:

- its `type`, `version` and `category`;
- the `permissions` the person must hold (all of them);
- the ports it `requires`;
- whether it `usesAI`.

The categories are `recommendation`, `routing`, `priority`, `approval_required`, `next_action`, `eligibility`, `policy_check`, `workflow_decision` and `agent_decision`. More deciders join a category without code assuming how many exist.

Four deciders ship today:

- **`commercial.priorities` (priority).** What to attend to first.
  - It reuses the C4 insights as the person reads them and the C5 follow-ups.
  - An overdue follow-up about an open sale is `follow_up_required`, priority high. Without an open sale it is medium; a follow-up due today is medium.
  - Each C4 attention reason maps to an outcome, a priority and a next step (`ATTENTION_DECISIONS`).
  - Items are sorted by priority, then by how many days late, then in C4 order.
  - Withheld parts are named, and partial lists become a constraint.
- **`action.policy_check` (policy_check).** Whether an action may go ahead and whether it needs approval.
  - It combines the catalogue with company policy from Company Brain. It reads only the `policies` domain and only keys a rule knows (`discount_approval_above_percent`).
  - A discount above the limit is `approval_required`.
  - A policy that is not confirmed, or has an open conflict, is not trusted: the result is approval, with the reason.
  - With no policy, the result says so and guesses no limit.
- **`forecast.signal` (recommendation).** What a finished forecast calls for.
  - It compares the mean of the predicted periods with the mean of as many recent periods.
  - A change of ±20% or more gives `demand_increase` (review capacity) or `demand_decrease` (plan commercial actions). Anything smaller is `stable`.
  - Warnings flag the fallback model, and a band that still includes no change.
  - No baseline, or an unfinished forecast, gives `insufficient_context`.
- **`agent.routing` (routing).** Which active agent should take a request.
  - Rules come first: the department filter, then an agent the request names, then the only candidate.
  - When several candidates remain, it asks a model through the AI Gateway as a closed choice among them (`r_a`…, or `none`).
  - When the model cannot choose, the person chooses. Routing assigns nothing.

### 4. `DecisionResult`

It carries:

- `id` (`dec_` + 32 hex), `type`, `version` and `category`;
- `outcome` (a closed code) and `priority`;
- `reasons` (code, `rule@version`, compared values) and `evidence` (source, record ref, fact, value);
- `items` for decisions over several records;
- `requiredApproval`, `recommendedAction` (code, catalogue action or null, link), `constraints` and `warnings`;
- `rules` applied, `sourceContext` (what was read and what was withheld), `model` (null unless a model was used) and `createdAt`.

It has **no confidence field**: no decider has a real measure of one, and a made-up figure would mislead ("NO inventar probabilidades"). A forecast's quantile band is reported as a warning, not as a probability. Results are frozen.

### 5. Context, least privilege and tenant isolation

- Deciders read only through ports over the existing services: commercial insights, Company Brain `list`, the Forecasting Engine's `get`, active agents and the AI Gateway's `assist`.
- Every port runs as the person, so each service checks the tenant and permissions again. A decision can never rest on data the person may not read.
- A decider reads only what it needs. The policy check lists one domain; it never reads the whole Company Brain.
- `preload` lets a trusted server caller (GIA) pass insights it already read as the same person. No HTTP route accepts it.

### 6. AI only through the AI Gateway

- A decider that needs interpretation calls `gateway.assist` with subject type `decision`.
- The gateway maps that subject to permission `decision.evaluate` and model policy `decision_assist@1`. Credits, rate limits, the person-actor rule and the gateway's own audit apply unchanged.
- Rules run first, then structured reads, then the model. The model gets closed references, never ids, and its answer is checked against the enum.

### 7. Permissions and audit

- There is a new permission, `decision.evaluate` (owner). Each decider adds the permissions for what it reads (`forecast.read`, `specialist.read`).
- There is a new audit action, `decision.evaluated` (category `decision`), on the existing trail:
  - target `{type:'decision', id}`;
  - reason = the outcome (or `permission_denied`, `not_configured`, `decider_failed`);
  - an `AuditDecision {type, version, rules≤12}` field, stored by the Firestore audit store as `decisionType`, `decisionVersion` and `decisionRules`.
- Nothing of the content (names, amounts, requests) is audited.

### 8. Where it is used

- **API.**
  - `GET /v1/organizations/:org/decisions/actions` (gia.ask)
  - `GET …/decisions/types` (decision.evaluate)
  - `POST …/decisions {type, input?}` (decision.evaluate): 400 for bad input, 403, 404 for an unknown type, 503 when not configured, and the forecast errors as on the forecasting routes.
- **GIA.**
  - With commercial insights, she asks the engine for `commercial.priorities` (limit 5) with the insights preloaded, under the same request id.
  - The ranking goes to the model as `<priorities>`, by the references she already knows, with rules that forbid reordering it.
  - When her answer is about it (`priorities: true`), the answer carries `priorities {decisionId, items}`.
  - The web chat shows each item as a card: the decision, the priority, the reasons with their data, the next step, the record's link, and "Requiere aprobación" when it applies. Nothing is run.
- **Workflows.** `workflowStepOf(condition, result)` is the contract for a condition node: continue, `await_approval` or stop. Approval is never skipped. The workflow runtime keeps refusing condition nodes (ADR-0031) until it adopts this.
- **Tool Engine.** `toolRequestOf(recommendedAction)` is the one mapping from a recommended action to a catalogue tool (Decision → Tool Request → Permission → Approval → Execution → Audit through the tool gate). It is empty today: every recommended action is done or confirmed by a person.
- **Agents.** An agent asks the same engine as the runtime tenant, for example a policy check with `proposer: 'agent'`. The worker's agent turn does not call it yet.

## Consequences

- MelonMotor has one place that decides, explains and audits; GIA no longer carries its own permission checks for proposals.
- A new decision is a new decider, and a new actionable step is a catalogue entry. Neither needs a new service.
- No Terraform, collection, index or secret is added.
- Pending:
  - wire the engine into the worker's agent turn;
  - adopt `workflowStepOf` in the workflow runtime;
  - fill `RECOMMENDED_ACTION_TOOLS` when AE-4 adds tools;
  - add more company policy keys when Geovet names them;
  - carry out `opportunity.offer_discount`, which needs a product decision.
