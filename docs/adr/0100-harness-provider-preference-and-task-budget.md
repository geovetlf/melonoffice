# ADR-0100: Harness block 2: data policy, routing per task, fallback, budget, limits and tool levels

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0099](0099-melon-agent-harness.md) (Harness block 1), [ADR-0072](0072-llm-router.md) (LLM Router), [ADR-0080](0080-nvidia-provider.md) (NVIDIA), [ADR-0081](0081-customer-credit-pricing.md) (customer credits), [ADR-0029](0029-runtime-guards.md) (attempts), [ADR-0026](0026-tools-approvals-and-guardrails.md) (Tool Gate), [ADR-0047](0047-six-initial-departments.md) (operator migrations)
- Decisions: Geovet, 2026-09-30:
  - 08:44Z, "Continuar Melon Agent Harness, bloque 2";
  - 09:03Z, "Decisiones definitivas";
  - 09:09Z, "Política de datos NVIDIA y migración de agentes".
- Terraform: none. Firestore: optional fields only (`maxCredits` on `agentTasks`, `ai` on `agentOutputs`), plus one operator migration of agents' model policy (below). Nothing is deleted.

## Context

The rule Geovet set: "MelonOffice decides what each task needs, and MelonMotor finds the most efficient, safe and economical way to do it." The order is:

1. the task;
2. the data it needs;
3. the capability it needs;
4. the data policy;
5. the authorized providers;
6. the right model;
7. cost;
8. latency;
9. execution.

NVIDIA may come first when the data policy and the capability allow it, never because it is NVIDIA, and never as if it were free.

What already existed and is reused:

- the AI Gateway and its router, which already filters on capability, modality, requirements, allow-lists, status, environment, sensitivity (including each model's recorded terms), quality, latency, cost, budget and availability;
- the provider adapters: Vertex AI, DeepSeek and NVIDIA;
- compatible fallback, recorded as `fallbackFrom`;
- the Credits engine and its per-call `maxCredits`;
- the AI Usage Layer;
- the Tool Gate and person approvals;
- the runtime's rule that an agent node never runs twice;
- the Harness's per-task profile (block 1).

## Decision

### 1. The route

task → Harness → AI Gateway (data policy → router) → provider adapter.

- **The Harness** reads the task: intent, domains and complexity. It says what the task's data is and chooses the context and the agent. It then gives the call:
  - its data class;
  - a strategy;
  - the task's remaining budget;
  - labels.

  The agent never picks a model, a provider or a tool on its own.

- **The gateway** applies the **data policy first**: a provider the call's data may not reach is never a candidate. The router then keeps the models that fit and orders them:
  1. the policy's preferred providers;
  2. the strategy.

  The first one answers; the rest are the automatic fallback.

- **The adapter** is the only code that knows a provider.

There is no `if provider == nvidia` anywhere.

### 2. The data policy (Geovet 09:09Z)

- **Data classes.** The Harness classes a task's data as `public`, `synthetic`, `test` or `company_private`.
  - The first three are routed as `public`; private company data is `confidential`.
  - Every task a person or an agent gives today is `company_private`, whatever its words say. The Harness never lowers a call's sensitivity, so private data cannot be sent somewhere by calling it public.
- **The policy** (`AIDataPolicy`) says, per provider and environment, the most sensitive data the provider may receive. It is configuration of each server:
  - the worker and the API start from `NVIDIA_TRIAL_DATA_POLICY`: NVIDIA in DEV, `public` only;
  - `AI_DATA_POLICY` (`provider:sensitivity`, comma separated) replaces the entries for that environment;
  - a malformed value stops the server from starting.
- **Registry ceiling.** An entry can only narrow what a provider's recorded terms allow (the registry, ADR-0080). Letting NVIDIA receive company data later takes two changes:
  1. a registry entry whose terms allow it (a contract or a paid endpoint);
  2. a data policy entry that says so.

  Nothing in code changes. A test shows exactly this: with contract terms and `AI_DATA_POLICY=nvidia:confidential`, NVIDIA takes private data; with the trial terms it still cannot.

- **When no provider fits.** If no authorized provider remains, the call is refused with `data_policy_not_allowed` before any provider is asked.
- **Which calls it covers.** The data policy applies in the gateway, so it covers every AI call of every server: agents, GIA, assisted AI and documents. It cannot be bypassed.

In DEV today:

- NVIDIA may take public, synthetic or test data;
- company data goes to Gemini 2.5 Flash-Lite on Vertex AI;
- NVIDIA is registered only when its key secret is set, which it is not in DEV.

### 3. Every agent through the Harness (Geovet 09:09Z)

- **In code** (worker), every kind of agent work is wrapped by the Harness:
  - agent tasks;
  - conversation agents' turns;
  - plan steps.

  Each call gets the data class, the limits and the economic profile. Work with no request (a conversation turn, a plan step) is read as a simple task: the cheapest fitting model, never an escalation. There is no path around it.

- **Model policies.** Two Harness policies pin no provider or model, prefer NVIDIA only as an order, fall back automatically, and cap each call at 1 credit and 3 provider calls:
  - `agent_task@2`;
  - `conversation_agent@2`, text only.

  New agents from templates, and new conversation agents from the operator route, name version 2.

- **Existing agents** name version 1 in their stored configuration, which pins Gemini. The operator migration `apps/api/dist/migrate-agent-policies.js` moves every agent that is not archived to version 2:
  - a new configuration version per agent;
  - one `specialist.model_policy_changed` audit event each;
  - one transaction per organization;
  - dry run by default;
  - running it again changes nothing.

  Version 1 stays registered for executions that started under it. Nothing is deleted.

### 4. Economic first, and escalation

Every task gets the cheapest model that fits (`cost_optimized`). Only a complex task asks for the strongest model the policy allows (`quality_first`), and its call is labelled `complex_task`. Analysis and planning are always complex, and so is a long request.

A model that fails, is rate limited or is unavailable is replaced within the same call by the next compatible model. A task is never escalated by repeating a paid call.

### 5. Limits and budget

`HarnessLimits` (ADR-0101's steps, agents and depth, plus this ADR's calls, tools and time; configurable safety defaults of MelonOffice, not provider limits):

| Limit           | Default | Enforced where                                                                                                         |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `maxSteps`      | 8       | a plan made for one task (ADR-0101, `planLimitProblem`); an agent task is one step                                     |
| `maxAgents`     | 4       | distinct agents in one plan (ADR-0101); a repeated agent and step is a loop, refused                                   |
| `maxModelCalls` | 3       | the Harness policies' `maxCalls`: the gateway stops a request after 3 provider calls over all fallbacks                |
| `maxToolCalls`  | 5       | `authorizeToolUse` denies past it                                                                                      |
| `maxDurationMs` | 10 min  | the Harness stops the work before its model call (`task_time_limit_reached`)                                           |
| `maxDepth`      | 1       | only a person starts a task; a runtime tenant is refused (`depth_exceeded`, ADR-0101), as the Agent Engine already did |

**Credits** are limited three ways:

- the task's `maxCredits`, which caps each call at what is left of it;
- the policy's 1 credit per call;
- the balance.

**At a limit**, the task stops and says why:

- the execution fails with the limit's code;
- a budget refusal is `credit_limit_exceeded`;
- a person-approval or hand-off stays the existing paths.

Nothing loops:

- each agent node runs once;
- a request makes at most 3 provider calls;
- an agent cannot start tasks.

### 6. Tools: levels A, B and C (Geovet 09:03Z)

`toolLevelOf` maps each tool's own declaration (ADR-0026) to a level:

- **A:** reads;
- **B:** reversible, low-risk changes inside MelonOffice;
- **C:** sensitive, outside MelonOffice, high risk, or approval required.

The strategy lists each tool with its level. `authorizeToolUse` is the Harness's decision on an agent's request. In order:

1. not granted by the agent's skills and the person's permissions: deny;
2. past the task's tool budget: deny;
3. the tool's policy denies it, or its risk is critical: deny;
4. level C: a person approves;
5. the tool asks for approval: a person approves;
6. the level is automatic for the organization (A and B by default): allow; otherwise a person approves.

An allowed use still goes through the Tool Gate, and an approval is a person's, bound to the exact call. Today's catalogue:

- `conversation_handoff` is B: automatic.
- `follow_up_schedule@1` is B. `@2`, which agents use, is C: a person approves it (ADR-0084).
- `message_send` is C, because it leaves MelonOffice.

Conversation agents' replies keep their autonomy rules (ADR-0043), whose sends were already decided per level.

### 7. The trace

Each answered agent call keeps its trace with the answer (`agentOutputs.ai`), returned by the agent task view as `ai`:

- provider and model;
- capability;
- data sensitivity and data class;
- intent;
- strategy;
- `fallbackFrom`;
- estimated and actual cost;
- estimated and consumed credits;
- the credit limit;
- the escalation;
- attempts.

It holds codes and whole numbers only, and is checked when written and read.

The rest of the trace lives on the records that already hold it:

- the task and tenant on the execution;
- the agent on the task;
- the termination reason as the execution's failure code;
- approvals on their own records;
- every refusal in the gateway's audit and the usage event.

### 8. Kinds of AI work

`aiNeedOf(kind)` maps text, vision, audio, embedding, image, document and voice to the capability and modalities the router selects on. Video is marked unsupported, never approximated. A new kind of model is one adapter and registry entry.

### 9. Costs

- Provider cost stays the AI Usage Layer's; customer credits stay `CustomerCreditPolicy`'s.
- **NVIDIA is never assumed free.** Its $0 is the recorded price of the trial endpoint, with its source. A paid endpoint is a registry entry with its own price. The router excludes a model above the call's cost cap, or with no known price, and falls back.
- A minimum credit charge for $0 calls is Geovet's decision.

## Consequences

- Every agent's call goes through the Harness and the data policy, with no bypass. In DEV every call with company data is served by Gemini 2.5 Flash-Lite, by policy, not by code.
- **Production.** Using NVIDIA with company data, or in production, needs a contract or a paid endpoint from Geovet, recorded in its registry entry and the data policy.
- **Migration.** Existing DEV agents move to version 2 only after Geovet runs the migration. Until then they keep working on version 1 (Gemini only), and the Harness's data policy, limits and profile already apply to their calls.
- **Tool loop.** The in-task loop where an agent asks for tools mid-answer is [ADR-0103](0103-harness-tool-use-mid-task.md), which calls `authorizeToolUse` for every request.
