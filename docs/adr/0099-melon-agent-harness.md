# ADR-0099: Melon Agent Harness, block 1

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0027](0027-ai-gateway-and-provider-registry.md) (AI Gateway), [ADR-0051](0051-company-brain.md) (Company Brain), [ADR-0063](0063-agent-tasks.md) (agent tasks), [ADR-0065](0065-decision-engine.md) (Decision Engine), [ADR-0072](0072-llm-router.md) (LLM Router), [ADR-0083](0083-skill-grants-enforced.md) (skill grants)
- Terraform: none. Firestore: none. No new permission.

## Context

Geovet asked (2026-09-30) for a Melon Agent Harness inside MelonMotor: one layer that decides, for each task, the context, agent, model, tools, budget and next step, over the engines that already exist, without a second architecture. The audit is in the project files (`melonoffice-plan/MelonOffice-Agent-Harness-Auditoria.md`). It found every piece the Harness coordinates already built (router, gateway, credits, usage, tool gate, planner, runtime, agent routing), but nothing that reads a task and chooses among them: every agent call used a fixed profile and read all the context its agent could.

The brief splits the work in four blocks. This ADR is block 1: task → context → planner → agent → model → tool → result.

## Decision

### 1. One package that decides, `@melonoffice/harness`

It has no store, no provider, no ledger and no tool runner. It reads a task and returns an `ExecutionStrategy`; the existing engines carry it out.

1. **Reading.** `classifyTask` reads intent (`question`, `classification`, `extraction`, `summary`, `generation`, `analysis`, `planning`, `action`), business domains (`crm`, `finance`, `marketing`, `operations`, `knowledge`), complexity and whether the person asks for a person. Fixed rules in English and Spanish, accents folded. No model, no cost, deterministic. A wrong reading can change only the order models are tried in and which context is read; never a permission, an agent or a tool.
2. **Context plan.** `contextPlanOf`: Company Brain unless the task only works on the text it gives, and the CRM when it is about customers. `createHarnessContextSource` reads only the planned sources, each as the person with the agent's configuration.
3. **Planner.** A complex planning or action task is marked `multi_step`. In block 1 it still runs as one agent task (reason `multi_step_runs_as_single_task`); the planning conductor takes it in block 3.
4. **Agent.** The agent the person named, if active in their organization; otherwise the Decision Engine's `agent.routing` (rules first, a model only among several), first within the department the task points at, then any. Several without a choice: `choose_agent`.
5. **Model profile.** A configurable `HarnessProfilePolicy` maps intent and complexity to a routing strategy: `cost_optimized` for simple work, `balanced` for generation, `quality_first` for analysis, planning and complex tasks. It names no model, no provider and no price. The AI Gateway's router still chooses under the agent's model policy. A policy may add a quality floor; the default has none, because with only Gemini 2.5 Flash-Lite (`basic`) approved a floor would refuse complex tasks.
6. **Tools.** The tools the agent's skills grant and whose every permission the person holds, each with an authorization class read from its declaration: `informative` (reads), `reversible`, `sensitive` (high risk or approval), `external`, `irreversible` (critical or denied). The Tool Gate still decides every call. No tool is offered to a model: the agent tool loop is still Geovet's open decision.
7. **Budget.** The Credits engine's balance is read before anything that may spend: none, or unreadable, and nothing starts (`refused`).
8. **Verdict.** `ready`, `choose_agent`, `no_agent`, `handoff_to_human` (the person asked for a person: nothing is routed, no model asked), `refused`. `needs_authorization` is reserved for the task budget of block 2.

`start` runs `prepare` and, when `ready`, asks the Agent Engine's task service to create and start the task, with the person's idempotency key. The task is then an ordinary agent task: same runtime, gateway, verification, audit and routes.

### 2. Who the task is for

Only the resolved tenant the backend built: organization, user, actor, role. Nothing in the task names them; a task field like `organizationId` is refused. Partners and agencies belong to the commercial platform (ADR-0085), not to a tenant, so a task runs in exactly one organization.

### 3. Where it plugs in

- **Worker.** Agent tasks read their context through the Harness's plan, and their model call carries the Harness's strategy and three labels (`harnessIntent`, `harnessComplexity`, `harnessPolicy`) that reach the gateway's tracing. What the work already set stays; `maxOutputTokens` and the prompt are unchanged.
- **API.** `POST /v1/organizations/:id/harness/tasks` with `{ request, specialistId?, department?, idempotencyKey?, dryRun? }`, under `specialist.task` (routing also needs `decision.evaluate` and `specialist.read`). It answers the strategy (without ids or a balance) and, when started, the task (`202`), then read through the agent task routes. No screen changes.

## Consequences

- One place now reads a task and chooses how the existing engines serve it, and the model router gets a reason to prefer a cheap or a strong model per task. In DEV nothing routes differently yet: every policy allows only Gemini 2.5 Flash-Lite.
- A classification or summary of given text no longer pays to read the company memory.
- Block 2 ([ADR-0100](0100-harness-provider-preference-and-task-budget.md)): model routing policy with `preferredProviders` (NVIDIA evaluated first when its terms and the data allow), fallback records, a task budget with the Credits engine. Block 3 ([ADR-0101](0101-harness-multi-step-limits-and-handoff.md)): multi-step through the planner, limits, loops, depth and hand-off. Block 4: CRM as a context source, `agent.execution.*` events in the existing catalogue, usage attribution.
