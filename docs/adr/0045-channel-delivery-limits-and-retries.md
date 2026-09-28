# ADR-0045: Channel delivery limits and retries

- Status: Proposed (CV-6D phase 1, pending Geovet's review)
- Date: 2026-09-28
- Amends: [ADR-0044](0044-integration-engine.md) (the engine's send path)
- Builds on:
  - ADR-0020 (audit)
  - ADR-0029 (attempts: `outcome_unknown` is never retried)
  - ADR-0034 (sending through the tool gate)
  - ADR-0043 (conversation agent, last check before send)
- Does not change: the tool gate, the AI Gateway, the runtime, credits, the CV-6B epoch and revision checks, plans, credentials or infrastructure.

## Context

Before this change, CV-6C sent each outbound message with exactly one provider call. Any failure settled the message, and nothing limited how often a connection called Meta. Several things could drive a burst on one number:

- autonomous agents;
- several agents sharing a connection;
- one busy conversation;
- several worker instances.

Geovet's CV-6D brief asks for four things:

- a per-connection limit inside the Integration Engine;
- retries only for transient errors;
- no duplicate on a retry, and no double credit charge;
- a takeover that is never overtaken, and an audit that tells every attempt apart.

## Decision

### 1. One place, one order

The limit and the retries live in the engine's send, after the connection, capability, window and credential checks. Before **each** provider call, the engine does these steps in order:

1. **Rate limit.** The engine takes a slot from the connection's limit.
2. **Last check.** It runs the caller's last check (CV-6B: the conversation is still the agent's, under the same epoch and revision).
3. **Provider call.** It calls the adapter once.

```
Agent/person → Runtime/API → Tool Gate → message_send executor
  → Integration Engine: connection, lifecycle, capability, window, credential
      loop: rate limit → last check → adapter.send → classify → (backoff → loop)
  → WhatsApp adapter → Meta Graph API
```

Adapters never retry. The runtime, the tool gate and the AI Gateway know nothing of it.

### 2. Per-connection rate limit

`ConnectionRateLimiter.acquire({organizationId, connectionId}, limit, now)` works on a fixed window.

- **Deployed services.** They use `FirestoreConnectionRateLimiter`: one transaction per slot on `connectionRateWindows/{organizationId}_{connectionId}`.
  - The document holds only `organizationId`, `connectionId`, `startedAt` and `count`.
  - API and worker instances share it, so concurrent senders never pass the limit together.
  - The key holds the organization, and a stored window naming another organization is ignored.
- **Clock skew.** A window started by a slightly faster clock still counts. A window more than one window "ahead" is ignored, so a clock jump never locks a connection out.
- **Slots.** Retries take slots too. The slot is spent even when the call then fails.
- **When the window is full:**
  - The engine waits if the window reopens within the time left.
  - Otherwise it refuses with `rate_limited` and sends nothing. It audits `channel.delivery_rate_limited` (`denied`).
- **Tests and local runs** use `InMemoryConnectionRateLimiter`.

### 3. What is retried

A call is retried only when the provider surely did not take the message:

| Adapter error                                   | Cause                                                                                                                        | Retried                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `provider_unavailable:rate_limited`             | HTTP 429; Meta codes 4, 80007, 130429, 131056                                                                                | yes                       |
| `provider_unavailable:temporary_provider_error` | Meta codes 2, 131016 (any status)                                                                                            | yes                       |
| `provider_unavailable:not_connected`            | connection never opened (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`) | yes                       |
| `provider_rejected:*`                           | 400/401/403, token, permissions, destination, payload, policy, 131000                                                        | no                        |
| `provider_unavailable:no_answer`                | timeout or reset once connected                                                                                              | **no, `outcome_unknown`** |
| `provider_unavailable:server_error`             | 5xx without one of Meta's temporary codes                                                                                    | **no, `outcome_unknown`** |
| `provider_unavailable:response`                 | 2xx without a message id                                                                                                     | **no, `outcome_unknown`** |

The brief lists timeouts and 5xx as transient, and it also says an uncertain outcome is never resent. The Cloud API takes no idempotency key, so a timeout or a bare 5xx may already have delivered the message. The engine therefore keeps them `outcome_unknown` (ADR-0029). It retries a 5xx only when Meta's body names a temporary error, which proves the message was refused.

Meta 131000 ("Something went wrong") is not documented as temporary. It is now `provider_error`: final, and never retried.

### 4. Backoff and budget

`DeliveryPolicy` (`delivery.ts`) holds every value in one place. `deliveryPolicyFromEnv` can change any of them, and a bad value fails at start.

| Value                           | Default   | Variable                           |
| ------------------------------- | --------- | ---------------------------------- |
| window                          | 60 000 ms | `CHANNEL_RATE_WINDOW_MS`           |
| sends per window per connection | 60        | `CHANNEL_RATE_MAX_SENDS`           |
| max attempts                    | 3         | `CHANNEL_RETRY_MAX_ATTEMPTS` (1–5) |
| base delay                      | 500 ms    | `CHANNEL_RETRY_BASE_DELAY_MS`      |
| max delay                       | 4 000 ms  | `CHANNEL_RETRY_MAX_DELAY_MS`       |
| total budget                    | 12 000 ms | `CHANNEL_RETRY_BUDGET_MS`          |
| min time for a retry            | 3 000 ms  | `CHANNEL_RETRY_MIN_ATTEMPT_MS`     |

- **Delay.** The delay is `random × min(max, base × 2^(attempt−1))` (full jitter). It is never less than Meta's `Retry-After`, which is capped at 60 s.
- **Deadline.** The executor passes the tool call's deadline. The engine stops 500 ms before it, and never later than the budget. Each call's timeout is the time left. The `message_send` tool's own timeout is 15 s, so a retry never outlives the tool call that asked for it.
- **No time left.** If no time is left before a first call, it is refused with `deadline_exceeded` and nothing is sent.
- **Defaults are not a decision.** They are MelonOffice's own protection and sit far below Meta's throughput (80 messages per second per number). They are adjustable, not a product decision.

### 5. Idempotency

There is no new mechanism. The executor already reserves the message as `queued` under a deterministic id and refuses any message that is not `queued`. Every retry sends that same stored message, as the same request body. `settleOutbound` settles it once. A retry therefore cannot create a second message, and an unknown outcome is never resent, because the message leaves `queued`.

### 6. Credits

Credits are charged when the model generates the reply (ADR-0043), before the send. Retries happen inside one `engine.send`, so one reply costs one charge whatever the number of calls. The credits code does not change.

### 7. Takeover

The last check runs before every call, including after each backoff. A person who takes control during a wait stops the retry, and the message fails `conversation_handled_by_human`. The CV-6B epoch and revision checks are unchanged.

### 8. Audit

These actions are new, and the audit event gains `attempt` (1–100):

- `channel.delivery_attempted` (`success` with reason `sent`, or `failure` with the stable code: `temporary_provider_error`, `rate_limited`, `not_connected`, `invalid_destination`, …, `outcome_unknown`);
- `channel.delivery_retry_scheduled` (`success`, with the reason for the retry);
- `channel.delivery_rate_limited` (`denied`).

Each event names:

- the organization;
- the actor (the person, or the runtime for the person);
- the message (target);
- the conversation (reference);
- the request id.

None of them holds a token, a phone number or the text. The worker's engine now records audit events too. The existing `conversation.message_*` events still settle the message once.

## Consequences

- One reply may make up to three calls to Meta, and all of them count toward the connection's limit.
- A timeout or a bare 5xx still ends `outcome_unknown` for a person to review, and is not retried. This is deliberately conservative.
- Each call makes one more Firestore transaction for the limit.
- There is no Terraform change. The collection is created on first write, and the services already have Firestore access.

## Not in this ADR

These are for later CV-6D phases: templates and media (phase 2), finish/tool actions (phase 3), and a second channel (phase 4).
