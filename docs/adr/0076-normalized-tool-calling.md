# ADR-0076: Normalized tool calling in the AI Gateway (R3)

- Status: Proposed (Geovet's continuous execution mode, 2026-09-29; LLM Router phase R3, named open in ADR-0072)
- Date: 2026-09-29
- Builds on:
  - [ADR-0026](0026-tools-approvals-and-guardrails.md) (the Tool Gate, the only place a tool runs);
  - [ADR-0027](0027-ai-gateway-and-provider-registry.md) (the AI Gateway);
  - [ADR-0038](0038-vertex-ai-activation.md) (Vertex AI);
  - [ADR-0072](0072-llm-router.md) (the LLM Router, DeepSeek).
- Terraform: none.

## Context

Models from both official providers can propose calls to functions. MelonMotor had a `toolUse` routing flag but no way to offer tools, read the calls, or carry them through a conversation. Every model was marked `toolUse: false`.

## Decision

### 1. One shape for every provider

- **Offering tools.** A request offers tools with `tools`, which must come with `requirements.toolUse: true`. The two go together. Each tool has a name, a description, and the input schema of the tool version the caller offers (`ToolSchema`). This is the same schema the Tool Gate validates against. `aiToolOf(toolVersion, description)` builds one from the catalogue.
- **Reading calls.** A model may answer with `output.toolCalls`, a list of `{ id, name, arguments }`, and finish with `tool_use`.
- **Carrying a conversation.** A conversation carries earlier calls as `tool_call` parts on `assistant` messages, and their results as `tool_result` parts on `user` messages.
- **Adapters translate.** Vertex AI uses `functionDeclarations`, `functionCall` and `functionResponse`. DeepSeek uses `tools`, `tool_calls` and `tool` messages. When Vertex gives a call no id, the adapter numbers it.

### 2. The gateway checks calls; it never runs them

**What the request must pass:**

- Tools must have unique names, bounded descriptions, and valid closed object schemas. There are at most 32 tools.
- An authority field in a schema is refused as `authority_in_input`. A credential in a description is refused as `secret_in_input`.
- Earlier calls and results must be plain JSON of bounded size, without credentials, and on the right side of the conversation.

**What the answer must pass:**

- Each call names a tool the request offered.
- Each call has a unique id.
- Its arguments pass that tool's schema: closed objects, no authority field, no credential value.
- There are at most 16 calls, and `tool_use` comes only with calls.
- An answer that fails any of this is an `invalid_response`. It is retried or falls back like any other invalid answer, and it is never passed on.

**What the gateway does not do:** it runs nothing. A call is a proposal. The caller hands it to the Tool Gate (`gate.execute`), which checks it again and applies the tool's permissions, risk level, approval, idempotency and audit.

### 3. Models

- Gemini 2.5 Flash-Lite (Vertex AI) and `deepseek-chat` are now marked `toolUse: true`. `deepseek-reasoner` stays `false`.
- Routing already filters on `toolUse`, so a request with tools reaches only these models.
- No policy changes. DeepSeek is still refused by price until its official price is confirmed.

### 4. Usage and cost

A call with tools is a normal LLM call: the same usage event, cost engine and credits. Tool definitions and parts count toward the input estimate.

## Consequences

- MelonMotor can offer an agent tools and read what it wants to do, the same way on every provider, with nothing run outside the Tool Gate.
- No agent offers tools yet, so behaviour in DEV is unchanged.

## Open

- The agent loop: offering an agent its allowed tools, handing each call to the Tool Gate, and feeding the results back until it answers. Built for agent tasks by [ADR-0103](0103-harness-tool-use-mid-task.md).
- Streaming: done in [ADR-0077](0077-streaming.md), text only.
- What is still to validate in DEV: a real function call on Vertex AI. The tests cover both adapters against the providers' documented formats.
