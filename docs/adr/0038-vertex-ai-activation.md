# ADR-0038: Activating assisted AI: Vertex AI, Gemini 2.5 Flash-Lite and the credit rate (CV-5)

- Status: Proposed (Phase CV-5, pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0023](0023-credits-foundation.md) (credits)
  - [ADR-0027](0027-ai-gateway-and-provider-registry.md) (the AI Gateway and provider registry)
  - [ADR-0037](0037-assisted-conversation-intelligence.md) (assisted AI on conversations)
- Decisions it applies (Geovet, 2026-09-27):
  - **D-7**: Google Cloud Vertex AI, official API only, with Gemini 2.5 Flash-Lite;
  - **D-12**: 1 credit = US$0.01, the real cost charged and rounded up;
  - 500 DEV test credits to MOpruebas only, as an audited `credits.grant`;
  - conversations are `confidential`, and a policy must allow that data to this model explicitly.
- Does not change:
  - the gateway's pipeline, router, retries or credits accounting (ADR-0027);
  - the assisted path's actor and permission checks (ADR-0037);
  - X6a to X6d, CV-1 to CV-3, the tool gate and how a message is sent.

## Context

CV-4 built assisted AI on conversations, but no call could reach a model anywhere:

- the provider registry was empty (D-7 open);
- there was no credit rate (D-12 open);
- the API service had no `DEPLOYMENT_ENVIRONMENT`;
- no policy let `confidential` data reach any model.

This ADR closes those four, and nothing else.

## Decision

### 1. One adapter, in its own package

`@melonoffice/ai-vertex` holds the Vertex AI provider, its one model and its adapter. The chain is:

> MelonMotor → AI Gateway → provider registry → Vertex AI adapter → Gemini 2.5 Flash-Lite.

There is no second gateway. Nothing outside the package knows Vertex's endpoint, request or response format.

The adapter works as follows:

- **Endpoint.** It calls `generateContent` on the regional endpoint `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent` over REST, with no SDK.
- **Authentication.** It authenticates as the service's own identity, with a token from the metadata server, as Secret Manager does (ADR-0033). There is no key, and the token never leaves the adapter.
- **What it sends:**
  - system messages go in `systemInstruction`, apart from the data;
  - user messages go in the `user` turn, and assistant messages in the `model` turn;
  - text only: media is refused as `invalid_request`;
  - no tools, no function declarations and no grounding.
- **Generation settings:**
  - temperature 0.2;
  - reasoning off (`thinkingBudget: 0`);
  - `maxOutputTokens` from the call.
- **Structured output.** With structured output, `responseMimeType` is `application/json` and `responseSchema` carries the call's schema (see 3).
- **Usage.** Input is `promptTokenCount`. Output is `candidatesTokenCount` plus `thoughtsTokenCount`, since reasoning is billed as output, so a call is never under-charged. An answer without usage is refused, because it could not be charged.
- **Errors.** The adapter never throws: every failure is a classified error, without the provider's message.

  | Answer from Vertex                  | Error kind         |
  | ----------------------------------- | ------------------ |
  | 408                                 | `timeout`          |
  | 429                                 | `rate_limited`     |
  | 401 or 403                          | `authentication`   |
  | 503                                 | `unavailable`      |
  | Other 5xx                           | `server_error`     |
  | Other 4xx                           | `invalid_request`  |
  | Aborted at the deadline             | `timeout`          |
  | Fetch failure                       | `network`          |
  | A blocked prompt or a safety finish | `content_policy`   |
  | Anything malformed or over 1 MB     | `invalid_response` |

The provider and the model each declare:

- capabilities: text generation and structured output;
- modality: text;
- the price, from Google's published list: US$0.10 per million input tokens and US$0.40 per million output tokens, as of 2026-09-27;
- environments: `dev` only;
- `maxSensitivity`: `confidential`.

The provider's credential is a reference to the `cloud-platform` scope, never a value.

### 2. A named policy per assisted subject, never the default

The gateway now resolves an assisted call's policy from `ASSIST_MODEL_POLICIES`, fixed in code like its permission: a conversation uses `conversation_assist@1`. A missing policy denies the call (`policy_not_found`), and the default policy is never used for an assisted call. The default policy is unchanged and still stops at `internal`.

`CONVERSATION_ASSIST_POLICY` (in `apps/api/src/ai.ts`) allows:

- exactly one provider and one model: `google-vertex-ai/gemini-2.5-flash-lite`;
- capability `text_generation` and modality `text`;
- environment `dev` only;
- data up to `confidential`;
- at most US$0.01 per call (1 credit);
- no fallback: if the model cannot answer, the call fails and nothing is sent elsewhere;
- 2 attempts on transient errors.

Confidential data is therefore not a universal permission. A new provider or model registered later reaches no conversation until this policy names it.

### 3. Structured output through the gateway

`AIRequest` gains an optional `outputSchema`, only with `requirements.structuredOutput`.

It is a closed subset of JSON Schema:

- the types `string`, `number`, `integer`, `boolean`, `array` and `object`;
- `enum`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `required` and `nullable`;
- no descriptions or free text, so it cannot carry instructions;
- enum values are codes;
- property names are plain keys, and authority names are refused;
- bounded in depth (6), size (200 nodes) and properties (30);
- the top level is an object.

The gateway checks it with the rest of the request and passes it to the adapter in `ProviderCall`. Each adapter translates it; Vertex's `responseSchema` uses upper-case types and `propertyOrdering`.

Each operation's schema is in `ASSIST_OUTPUT_SCHEMAS` (conversations). It has the same bounds `parseAssistOutput` checks, and the parser still decides what is shown: an answer that does not fit is `ai_invalid_output`.

### 4. The credit rate (D-12)

`CREDIT_RATE = { microUsdPerCredit: 10_000 }`, in the gateway next to `creditsFor`. The flow is:

1. The adapter reports tokens.
2. The gateway prices them from the model's known price.
3. `creditsFor` converts the price to whole credits, rounded up.
4. The Credits engine consumes them once per request id (`ai:<requestId>`).

There is no new engine or ledger, and no price in the UI or in conversations. A call that completes at zero cost is `free`. Nothing is charged for denied or failed calls.

A typical assisted call is about 3,500 input and 1,200 output tokens. That costs about US$0.00083, which is 1 credit.

### 5. Clearer errors for the person

The assistant now maps:

- policy refusals to `ai_policy_denied` (403);
- a provider timeout to `ai_timeout` (504);
- a provider 429 to `rate_limited` (429).

The existing codes still cover the rest:

- `ai_not_available` (503): not configured, meaning no environment, policy, provider, model, price or rate;
- `ai_credits_insufficient` (409);
- `ai_unavailable` (502);
- `ai_invalid_output` (502).

The web shows each in English and Spanish. No stack trace, prompt, provider message, key or token is ever shown.

### 6. Configuration and infrastructure (DEV only)

The API reads two new settings, `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_LOCATION`, which must be set together. The server registers Vertex AI with the policy and the rate only when these and `DEPLOYMENT_ENVIRONMENT` are all set. Otherwise nothing is registered and every call is denied, as before.

Terraform, behind the new variable `ai_assist` (default false, `true` in `envs/dev` only), makes these changes:

- **API settings.** The api service gets `DEPLOYMENT_ENVIRONMENT`, with the same pattern and condition as the worker, plus `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_LOCATION`. `DEPLOYMENT_ENVIRONMENT` does not turn on a person's sends: those also need channel secrets, which are still unset.
- **Vertex AI API.** It enables `aiplatform.googleapis.com`.
- **Custom role.** `melonofficeVertexAIInvoker` holds only `aiplatform.endpoints.predict`, which is what `generateContent` needs. `roles/aiplatform.user` is not used, because it would also let the api manage datasets, endpoints, jobs and models.
- **Binding.** The custom role is bound to the api's runtime identity only.

The planner needs nothing new: its role already reads custom roles, project IAM and enabled services. Staging and production are unchanged, since they have no apps or Firestore.

### 7. The DEV test grant

`grantDevTestCredits` (in `apps/api/src/dev-credits.ts`) grants MOpruebas its 500 DEV test credits. Everything about it is fixed in code: the organization name, the amount, the reference `dev-test-grant:cv5:1` and the reason `dev_test_grant`.

Its behaviour:

- **Refusals.** It refuses:
  - any environment but `dev`;
  - no organization, or more than one, named exactly `MOpruebas`;
  - an inactive organization;
  - a creator who is no longer its active owner.
- **Acting as the owner.** It acts as the organization's creator, resolved like any tenant. It goes through the Credits engine's own `grant`, so the ledger entry and the `credits.grant` audit event are one write.
- **Idempotency.** Running it again replays the entry and moves nothing.
- **Scope.** It has no route. It is not a plan's credits, which are still pending.

It is run once, from Cloud Shell, by the DEV project's owner, with their own credentials:

```sh
DEPLOYMENT_ENVIRONMENT=dev IDENTITY_PLATFORM_PROJECT_ID=<dev project> node apps/api/dist/grant-dev-credits.js
```

Staging and production have no Firestore, so there is nothing it could reach there.

## Security

- **Tenancy and actors.** Tenant isolation, the user-only actor and the `conversation.assist` permission are ADR-0037's, unchanged. The tests cover all three end to end on the real adapter.
- **What the model receives.** It receives the system policy and the redacted, bounded conversation data (ADR-0037). The tests check that no phone number, id or token is in the request. Customer text stays data in the user turn, and a prompt injection cannot reach the system instruction.
- **No tools.** No tool is declared to the model, so this path cannot invoke any tool.
- **Suggested replies.** A suggested reply is never sent. The tests check that no Graph API call is made and no message is stored.
- **Secrets.** The metadata token is cached in memory only, never logged, audited or returned. Provider messages are dropped.
- **Where data is processed.** Vertex AI processes the data in the configured region (`us-central1` in DEV). This is Google's official service under the project's own terms; no intermediary is involved.

## Consequences

- Assisted AI works in DEV once Terraform is applied and the image is deployed. It stays off in staging and production.
- Retries after a timeout can make Vertex bill a call twice, because Vertex has no idempotency key. The person is still charged once, since the ledger keys on the request id. This is bounded by the policy's 2 attempts and the 1-credit cap.
- A cut answer (`MAX_TOKENS`) that does not parse is charged, because the model did the work, and is shown as `ai_invalid_output`.
- The price is data with a date. When Google changes it, the catalogue changes, with its date.
- If `aiplatform.endpoints.predict` turns out not to be enough on apply, the fallback is `roles/aiplatform.user`. That is a wider role and needs Geovet's approval first.
