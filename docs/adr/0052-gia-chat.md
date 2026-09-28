# ADR-0052: GIA's chat

- Status: Proposed
- Date: 2026-09-28
- Builds on: ADR-0027/0037/0038 (AI Gateway and assisted calls), ADR-0049 (activity), ADR-0050 (GIA's Workplace), ADR-0051 (Company Brain) and Geovet's decisions of 2026-09-28 (a GIA message costs 1 credit, no daily cap; GIA phase 1 answers, reads and points to screens, and never acts)
- Does not change: the AI Gateway's engine, credits, the audit system, tenancy, conversations, the Integration Engine or the tool gate.

## Context

Fase 1c makes GIA talk. The chain Geovet set is GIA → MelonMotor → AI Gateway → the existing model and provider → Credits → Audit, with no new AI engine, agent engine, router or credits system. GIA answers, uses company context, reads what the person may read, explains the office's activity, helps them navigate and says which department a request belongs to. She does not execute commercial, financial or legal actions, publications or payments.

## Decision

### 1. Where it lives

- `packages/gia` holds the service (`createGia`), the prompt and the answer's shape. It has no HTTP of its own.
- `apps/api/src/gia.ts` holds the route: `POST /v1/organizations/:id/gia/messages` with exactly `{ message, requestKey, locale?, history? }`.
- The web chat lives in `apps/web/src/gia/GiaChat.tsx`. It is shared by the Home's command bar and GIA's Workplace.

### 2. The call

- **Who may ask:** a person acting directly, with the new permission `gia.ask` (owner only today). GIA herself (actor `gia`) and the runtime are refused (`requires_user`).
- **The gateway:** the one AI Gateway, in its assisted mode, with a new subject type `gia` (id: the organization). Its permission is fixed as `gia.ask`, and its policy is its own named policy, `gia_assist` v1:
  - a copy of the conversation policy: Gemini 2.5 Flash-Lite on Vertex AI, DEV only, `confidential`;
  - at most 1 credit per call (US$0.01), with no fallback and one retry.
- **What the gateway does:** it charges the credits and records its `ai.*` audit, as for every assisted call.
- **Repeats:** the request id is derived from the organization, the person and the caller's `requestKey`. The same click is answered once and charged once, and a repeat returns `replayed: true`.
- **Rate limits:** there is a limit per person and per organization, held in memory (20 and 60 a minute). Credits stay the real limit.

### 3. What GIA reads

Everything is read as the person, each part with its own permission. A part she may not read is left out, never guessed.

- **Company Brain** (`knowledge.read`), with two small reads and no model:
  - the business's core facts (identity, business model, brand; at most 10);
  - the facts that match the question (up to 25 in all).
- **What she still needs to learn** (`gaps()`, `knowledge.read`). She may end an answer with at most one of these questions, never one already answered.
- **Today's activity** (`activity.read`), in the business's time zone: at most 20 items.
- **The organization's active catalogue departments**: the only departments she may route to.

The person's words, the facts and the activity are escaped and marked as data. They are never instructions.

### 4. What she answers

A closed shape (`giaOutputSchema`):

- `answer` (at most 2,000 characters);
- `department`: one of the organization's departments, or `none`;
- `screen`: home, gia, conversations, connections, business_profile, department, or `none`;
- `proposedAction`: one line, nullable. It is a suggestion the person carries out themselves. **Nothing in an answer is ever run.** No message, publication, payment or data change leaves this service.
- `facts`: at most 5 facts the person stated in this message, in Company Brain's candidate shape.
  - They are kept only as **proposals** (`gia` source, confidence at least 0.6), never confirmed. `gaps()` then stops asking for them, and they wait in `toConfirm` for a person.
  - This is Company Brain's GIA capture, done in the same call, so it costs no extra credit.
- **Checking the answer:** an answer that does not fit the shape is not shown (`ai_invalid_output`). A department that is not one of the organization's is dropped.
- **The response:** it carries `generatedBy: 'ai'`, what she read (`context: {facts, activity, missing}`), and how many facts she proposed.

### 5. The chat is not stored

- The conversation lives only in the web session.
- The client sends back its last 6 turns (each at most 2,000 characters).
- Storing GIA's conversations is agent memory, which ADR-0051 keeps apart from Company Brain. It is not decided here.

### 6. Audit and activity

- **New audit action:** `gia.message_answered` (category `gia`), recorded as success, denied or failure.
  - It carries target `organization`, `reference` = the gateway's credit reference, the model, and the reason code.
  - It never holds the question or the answer.
- **In the Home's activity:** the action joins the activity allowlist (now 30, the maximum one query allows). The Home and GIA's history show "You asked GIA".
- **Logs:** `gia.message_answered`, `gia.message_denied`, `gia.message_failed`, `gia.message_invalid_output`, `gia.context_unavailable`, `gia.activity_unavailable` and `gia.proposal_failed`, with counts and latency only.

### 7. HTTP errors

| Code                                                     | Status |
| -------------------------------------------------------- | ------ |
| `invalid_request` (with `field`)                         | 400    |
| `permission_denied`, `requires_user`, `ai_policy_denied` | 403    |
| `ai_credits_insufficient`                                | 409    |
| `rate_limited`                                           | 429    |
| `ai_unavailable`, `ai_invalid_output`                    | 502    |
| `ai_not_available` (no model configured here)            | 503    |
| `ai_timeout`                                             | 504    |

### 8. Web

- **The Home's command bar** sends the message to GIA and opens her Workplace, where the chat continues. Without `gia.ask` it says so and calls nothing.
- **The Workplace** shows:
  - the state "Available";
  - the capabilities, no longer marked "Soon";
  - the chat, with each answer marked "generated by AI", the department it belongs to, the suggestion, the facts noted for confirmation, and a link to the screen;
  - the cost (1 credit per message) and that the chat is not saved.
- **The limits** stay listed, with one line added: what the person tells GIA is only a proposal until they confirm it.

## Consequences

- **Enabling GIA in DEV** needs only what CV-5 set up: Vertex AI configured and the organization holding credits. The `gia_assist` policy is registered with the others. There is no Terraform change and no new index.
- **Brain exports:** Company Brain now exports `FACT_CANDIDATE_SCHEMA` and `FACT_RULES`, shared by extraction and the chat.
- **Routing is prepared, not active:** GIA says which department a request belongs to and links to its office. Nothing is sent there. Agents taking work from GIA is a later phase.

## Not decided here (pending)

- Storing GIA's conversations, and their retention.
- Streaming answers, voice and attachments (the bar's buttons stay "coming").
- Any action by GIA: every action waits for its own phase, the tool gate and the person's approval.
- A daily cap on GIA messages (Geovet: none for now).
- A web screen to confirm Company Brain proposals. Today they are confirmed through the API.
