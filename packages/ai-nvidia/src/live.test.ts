import { ProviderCredential, type ProviderCall } from '@melonoffice/ai-gateway';
import { describe, expect, it } from 'vitest';
import { createNvidiaAdapter } from './adapter.js';
import { NEMOTRON_3_NANO_MODEL, NVIDIA_MODELS, NVIDIA_PROVIDER } from './catalogue.js';
import { catalogueDrift, listNvidiaModels } from './discovery.js';

/**
 * Live checks and the benchmark against NVIDIA's real hosted API (ADR-0080,
 * docs/providers/nvidia/BENCHMARKS.md). Skipped unless `NVIDIA_LIVE_API_KEY` is set in the shell of
 * whoever runs them by hand: never in CI, never with a key in Git. Public text only, as the terms
 * require (NVIDIA may use what it is sent).
 *
 *   NVIDIA_LIVE_API_KEY=... pnpm --filter @melonoffice/ai-nvidia exec vitest run src/live.test.ts
 */
const key = process.env.NVIDIA_LIVE_API_KEY;
const credentials = {
  resolve: async () => new ProviderCredential(key ?? ''),
};

const PUBLIC_PROMPTS = [
  'In two sentences, what is a sales pipeline?',
  'List three common stages of a B2B sales pipeline, one per line.',
  'Translate to Spanish: "Your order has shipped."',
];

const call = (text: string): ProviderCall => ({
  requestId: `live-${Date.now()}`,
  idempotencyKey: 'live',
  model: { id: NEMOTRON_3_NANO_MODEL.modelId, version: NEMOTRON_3_NANO_MODEL.version },
  capability: 'text_generation',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  outputModality: 'text',
  maxOutputTokens: 256,
  structuredOutput: false,
  credential: NVIDIA_PROVIDER.credential,
  deadline: new Date(Date.now() + 60_000),
});

describe.skipIf(key === undefined || key.length === 0)('NVIDIA live (manual only)', () => {
  it('lists served models and reports drift from the registry', async () => {
    const listing = await listNvidiaModels({ credentials });
    expect(listing.status).toBe('listed');
    if (listing.status === 'listed') {
      console.info('nvidia drift', catalogueDrift(listing.models), 'models', NVIDIA_MODELS.length);
    }
  });

  it('benchmarks each registered model on public prompts: latency and output tokens per second', async () => {
    const adapter = createNvidiaAdapter({ credentials });
    const rows: Record<string, unknown>[] = [];
    for (const text of PUBLIC_PROMPTS) {
      const started = performance.now();
      const outcome = await adapter.generate(call(text));
      const ms = performance.now() - started;
      rows.push(
        outcome.status === 'success'
          ? {
              model: NEMOTRON_3_NANO_MODEL.modelId,
              latencyMs: Math.round(ms),
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              outputTokensPerSecond: Math.round((outcome.usage.outputTokens / ms) * 1000),
            }
          : { model: NEMOTRON_3_NANO_MODEL.modelId, error: outcome.kind, http: outcome.httpStatus },
      );
    }
    console.table(rows);
    expect(rows).toHaveLength(PUBLIC_PROMPTS.length);
  }, 240_000);
});
