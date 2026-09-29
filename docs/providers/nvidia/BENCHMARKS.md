# Benchmarks

**No results yet.** This environment cannot reach NVIDIA (egress is blocked), and no key exists. Nothing here ranks models.

## How to run

It needs a key and public prompts only:

```
NVIDIA_LIVE_API_KEY=... pnpm --filter @melonoffice/ai-nvidia exec vitest run src/live.test.ts
```

It is skipped in CI and whenever the variable is unset. It prints:

- served models, and drift from the registry;
- for each registered model and prompt: latency (ms), input and output tokens, and output tokens per second.

## Metrics to collect before comparing providers

| Metric                   | How                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Latency (p50/p95)        | Wall time per call over at least 30 calls per model.                                              |
| Output tokens per second | `completion_tokens / latency`.                                                                    |
| Context                  | The published limit, confirmed with a long public input.                                          |
| Tool calling             | The share of calls whose tool call passes the gateway's schema check, on a fixed public tool set. |
| Reliability              | The success rate, and the rate of 429, timeouts and 5xx, over a day.                              |
| Cost                     | Provider cost from the recorded price ($0 during the trial), and credits charged.                 |
| Free eligibility         | The recorded `terms` (offering, production, contentUse).                                          |

Reasoning, coding and vision quality need a fixed public evaluation set with scored answers. That set does not exist yet, and no model is called "better" without it.
