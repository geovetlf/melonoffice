# Rate limits

| Provider | Model            | Endpoint                 | Limit                                                          | Unit    | Environment | Source                                                                                     | Effective date  |
| -------- | ---------------- | ------------------------ | -------------------------------------------------------------- | ------- | ----------- | ------------------------------------------------------------------------------------------ | --------------- |
| NVIDIA   | any hosted model | integrate.api.nvidia.com | UNKNOWN / NOT_PUBLISHED                                        | —       | trial       | No official page found (checked the NIM FAQ, LLM APIs reference, trial terms, model cards) | —               |
| NVIDIA   | any hosted model | integrate.api.nvidia.com | Trial credits deducted per use; amount UNKNOWN / NOT_PUBLISHED | credits | trial       | Trial Terms of Service §Credits                                                            | v. 2025-09-19   |
| NVIDIA   | Nemotron 3 Nano  | chat completions         | `max_tokens` per the model card: 128K output                   | tokens  | any         | model card                                                                                 | read 2026-09-29 |

Developer forum posts by users mention a per-minute figure and ask to raise it. Those are not NVIDIA documentation, so they are **not** used or hard-coded.

## How MelonOffice handles limits it cannot know

When NVIDIA answers **429**, the adapter returns `rate_limited` with NVIDIA's `Retry-After`. The header may be seconds or an HTTP date, and is capped at a day. Then:

1. The gateway records it: an `ai provider error` log line with the kind, and the health tracker.
2. The health tracker leaves NVIDIA out of routing until `Retry-After` has passed.
3. Within the call, the gateway waits `max(policy backoff, Retry-After)` and tries once more. It never waits longer than 10 seconds.
4. If NVIDIA asked for longer, or the attempts are spent, the call goes to the next compatible model when the policy allows fallback. Otherwise it fails with `rate_limited`.
5. Attempts are bounded by the policy's `maxAttempts`, at most 5. There are never infinite retries.

Without `Retry-After`, the policy's backoff applies, and three transient failures within a minute open a 30-second cooldown.

TPM, concurrency and per-key limits are not published, so no fixed limiter is configured for them. A limiter would need numbers MelonOffice does not have.
