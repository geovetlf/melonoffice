# ADR-0170: the API resolves agent_task@2

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (the Harness's routing), [ADR-0168](0168-one-truth-for-drafts-before-gia-writes-workflows.md) (the Harness plans), [ADR-0169](0169-planner-evals.md) (the planner's evals)
- Product decision: Geovet, 2026-10-05 09:14Z, authorizes registering `agent_task@2` in the API's policy catalogue, for DEV, after checking that it adds no provider, model, permission, security, autonomy, limit, cost, secret, Guardian or approval change.
- Terraform: none. Firestore: none. Prompts: none. Models and providers: none.

## Context

Template agents name the model policy `agent_task@2` (ADR-0100). The worker registers it, so their tasks run. The API did not. The Harness's planning call runs in the API and resolves the agent's own policy, so in DEV the AI Gateway refused it with `policy_not_found`, and every multi-step request was handed to a person.

## Decision

1. **One route, three places.** `harnessRoute(preferredProviders)` in `packages/harness` is the DEV route of agent work:
   - NVIDIA tried first where the data policy allows it;
   - DEV only;
   - at most one credit per call;
   - at most three provider calls per request.

   The worker, the API and the evals all build `agent_task@2` from it. The worker's policy is unchanged; it is now built from the shared route instead of its own copy.

2. **The API registers `agent_task@2`**, built exactly as the worker builds it. A test checks that it equals the worker's.

## What it is, and what it is not

The policy is the worker's, compared field by field:

- **Providers and models:** it pins no provider and no model. Candidates are only the providers the server already registers (Vertex AI, and NVIDIA or DeepSeek where configured). No provider or model is added.
- **Data:** up to `confidential`. The data policy still runs first: NVIDIA's trial terms take public data only. A planning call carries internal data, so it goes to Gemini 2.5 Flash-Lite on Vertex AI, as a test shows.
- **Environment:** DEV only. In staging or production no model fits.
- **Cost:** at most one credit per call (US$0.01), the same cap as every other API policy.
- **Calls:** two attempts per model, compatible fallback, and at most three provider calls.
- **Not touched:**
  - permissions, roles and the actor checks;
  - secrets and credentials;
  - Guardian;
  - approvals and the Harness's risk policy (every plan waits for a person);
  - autonomy, limits, prompts and evals;
  - the other API policies.

Only the planner reaches it: the agent turns the API runs use their own gateway, with no catalogue.

## Consequences

- In DEV, a multi-step request to the Harness now reaches Gemini for a plan. The plan still waits for a person, and nothing runs until they approve it.
- Each planning call is charged in credits like any agent call, at most one credit.

## Evals

No prompt, model or agent behaviour changed. The routing of the planner's call now matches the route its evals already measure (`evalTaskPolicy`, ADR-0169).
