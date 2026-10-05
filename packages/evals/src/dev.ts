import { createProviderRegistry, type ProviderRegistry } from '@melonoffice/ai-gateway';
import {
  createVertexAIAdapter,
  METADATA_TOKEN_URL,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
} from '@melonoffice/ai-vertex';
import type { ModelPolicy } from '@melonoffice/domain';
import { harnessRoute, harnessTaskPolicy } from '@melonoffice/harness';

/**
 * Where a real eval run may go (ADR-0134): DEV only, never staging or production, and never more
 * than the run budget Geovet authorised on 2026-10-03 (about 70 credits, US$0.70, per full run).
 */
export const EVAL_DEV_PROJECT = 'melonoffice';
export const EVAL_LOCATION = 'us-central1';
export const EVAL_MAX_BUDGET_CREDITS = 70;

/**
 * The agent task policy exactly as the worker routes it (its `HARNESS_ROUTE`, ADR-0100): NVIDIA
 * first where the data policy lets it take the call, then the task's strategy, at most one credit
 * per call. Only the providers the run registers are candidates.
 */
export const evalTaskPolicy = (): ModelPolicy => harnessTaskPolicy(harnessRoute(['nvidia']));

/**
 * A fetch that answers the Vertex adapter's metadata-server token request with the person's own
 * short-lived token (`gcloud auth print-access-token` in Cloud Shell), and passes every other
 * request on. The token is never written anywhere.
 */
export function withAccessToken(token: string, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === METADATA_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: token, expires_in: 3000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return inner(input, init);
  }) as typeof fetch;
}

/** Vertex AI in DEV, through its official adapter, with the person's token. */
export function devVertexRegistry(token: string, inner?: typeof fetch): ProviderRegistry {
  return createProviderRegistry({
    providers: [VERTEX_AI_PROVIDER],
    models: VERTEX_AI_MODELS,
    adapters: [
      createVertexAIAdapter({
        projectId: EVAL_DEV_PROJECT,
        location: EVAL_LOCATION,
        fetch: withAccessToken(token, inner),
      }),
    ],
  });
}
