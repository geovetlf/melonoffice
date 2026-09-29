# ADR-0077: Streaming through the AI Gateway (R4)

- Status: Proposed (Geovet's continuous execution mode, 2026-09-29; LLM Router phase R4, named open in ADR-0072 and ADR-0076)
- Date: 2026-09-29
- Builds on:
  - [ADR-0027](0027-ai-gateway-and-provider-registry.md) (the AI Gateway);
  - [ADR-0037](0037-assisted-conversation-intelligence.md) (assisted calls);
  - [ADR-0038](0038-vertex-ai-activation.md) (Vertex AI);
  - [ADR-0072](0072-llm-router.md) (the LLM Router, DeepSeek);
  - [ADR-0073](0073-ai-usage-layer.md) (the AI Usage Layer).
- Terraform: none. No new route, permission, collection, audit action or secret.

## Context

The gateway's adapter contract had an optional `stream` with no caller. A person talking to GIA or an agent waits for the whole answer before seeing any of it. Streaming must not become a second path around the gateway's checks, credits or audit.

## Decision

### 1. The same call, read as it comes

- `AIGateway.stream(tenant, request)` is `generate`, and `assistStream(tenant, request)` is `assist`. Each goes through the same checks, authorization, policy, routing, credits, retries, fallback, cost, usage events and audit. The code is shared, not copied: both kinds of call go through one `prepare` (credits, route, affordable models), one loop over the candidates and one `settle` (charge, usage, log, response).
- The caller reads `{ type: 'text', text }` pieces, then exactly one `{ type: 'done', response }`. The response is the one `generate` would have given: `completed`, `failed` or `denied`.
- A refusal before any provider (`denied`) is a single `done`.
- Text read before a `done` that is not `completed` is not an answer, and the caller must drop it.

### 2. Text only

- A streamed call may not offer tools, ask for a structured answer or ask for anything but text. Otherwise it is refused as `invalid_request`.
- Tool calls and structured answers are checked whole before anything uses them, so they are never read piece by piece. Those calls use `generate`.
- Routing adds the `streaming` requirement, and only models whose adapter has `stream` are kept. When none fits, the call is denied (`requirements_unmet`, or `no_compatible_model` when no adapter streams).

### 3. Nothing unchecked leaves the gateway

- Text goes out only in whole words, up to the last whitespace. It goes out only once everything up to there has passed the same credential check as a whole answer (`looksLikeSecretText`).
  - A credential is one unbroken word, or a word after `bearer`, so the whole of it is seen before any of it leaves.
  - When one appears, nothing more goes out and the call fails as `invalid_response`.
- When the provider ends, the whole answer is checked as for `generate` (`checkProviderSuccess`). The pieces joined must be exactly the answer's text. A stream that differs, has no end, or sends anything unknown is an `invalid_response`.
- The last words held back go out only after that check and the charge. An answer that cannot be charged ends `failed` with `credits_charge_failed`, and its last words never leave.

### 4. Retries, fallback and time

- While no text has gone out, a failed attempt is retried and falls back exactly as in `generate`.
- Once text has gone out, a failure ends the call. It is audited as `ai.request_failed` and never tried again, since the caller has already seen part of an answer.
- Each attempt has the same time limit as a `generate` attempt, for the whole stream. A stream that stops sending is a `timeout`.

### 5. Charged by real usage, always

- Credits are charged after the end, by the usage the provider reports, as for `generate`.
- A caller that stops reading does not stop the call. The gateway reads the answer to its end, checks it and charges it, so stopping early never makes an answer free.
- A failed stream is not charged, as for `generate`.

### 6. Adapters

- `ProviderAdapter.stream(call)` yields `{ type: 'text' }` pieces and exactly one `{ type: 'end', outcome }`, the same outcome `generate` returns. It never throws, and never passes on the provider's own words about an error.
- `readServerSentEvents` (in the gateway package) reads the event-stream format. Each adapter reads its own chunks from it.
- **Vertex AI** (adapter version 3): `streamGenerateContent?alt=sse`. Chunks are read into one answer and checked by the same `outcomeOfVertexResponse`. A stream cut for its content (`SAFETY` and the like) is `content_policy`.
- **DeepSeek** (adapter version 3): `stream: true` with `stream_options.include_usage`. It reads `delta.content`, never `reasoning_content`. The usage arrives on its own last chunk. The answer is checked by the same `outcomeOfDeepSeekResponse`.
- Both are capped at the same 1 MB as a whole answer. A call in a stream is an `invalid_response`.
- Catalogue changes:
  - Gemini 2.5 Flash-Lite and `deepseek-chat` are now `streaming: true`;
  - `deepseek-reasoner` stays `false`.
  - No policy changes. DeepSeek is still refused by price.

## Security and tenancy

- The organization, user, execution and specialist come from the tenant and storage, as for `generate`.
- Streaming adds no route. Nothing outside the server can reach the gateway.
- No text reaches the caller before the request passed every check and the organization's credits could cover the call.

## Consequences

- Server code can show an answer as it is written, on both providers, with the same accounting.
- Nothing calls `stream` yet, so behaviour in DEV is unchanged.

## Open

- A streaming route for GIA's chat and the web client (server-sent events), with its own review.
- Streaming for calls with tools, once a caller needs it: text pieces first, calls only whole at the end.
- What is still to validate in DEV: a real streamed call on Vertex AI. The tests cover both adapters against the providers' documented stream formats.
