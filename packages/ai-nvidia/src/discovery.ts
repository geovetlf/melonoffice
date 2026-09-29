import type { CredentialResolver } from '@melonoffice/ai-gateway';
import type { CredentialReference } from '@melonoffice/domain';
import { NVIDIA_HOSTED_BASE_URL } from './adapter.js';
import { NVIDIA_API_MODEL_NAMES, NVIDIA_PROVIDER } from './catalogue.js';

/**
 * Model discovery (ADR-0080), through NVIDIA's official OpenAI-compatible `GET /v1/models`, never
 * by reading web pages. It only reports: the registry stays the versioned, reviewed list of what
 * MelonOffice uses, and nothing is registered, priced or allowed because NVIDIA lists it.
 *
 * The list says which models are served; it does not say a model's price, its terms, whether it
 * is a free endpoint, or its capabilities. Those stay recorded by hand from NVIDIA's official
 * pages, with their source and date.
 */
export type ModelListing =
  | { readonly status: 'listed'; readonly models: readonly string[] }
  | {
      readonly status: 'failed';
      readonly reason: 'authentication' | 'rate_limited' | 'unavailable' | 'invalid_response';
    };

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_BYTES = 2_000_000;
const MAX_MODELS = 5_000;

export async function listNvidiaModels(options: {
  readonly credentials: CredentialResolver;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<ModelListing> {
  const call = options.fetch ?? fetch;
  const base = (options.baseUrl ?? NVIDIA_HOSTED_BASE_URL).replace(/\/$/, '');
  const failed = (reason: Extract<ModelListing, { status: 'failed' }>['reason']): ModelListing =>
    Object.freeze({ status: 'failed', reason });
  let key: string;
  try {
    const reference: CredentialReference = NVIDIA_PROVIDER.credential;
    key = (await options.credentials.resolve(reference)).reveal();
  } catch {
    return failed('authentication');
  }
  let answer: Response;
  try {
    answer = await call(`${base}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    return failed('unavailable');
  }
  if (answer.status === 401 || answer.status === 402 || answer.status === 403) {
    return failed('authentication');
  }
  if (answer.status === 429) return failed('rate_limited');
  if (!answer.ok) return failed('unavailable');
  try {
    const raw = await answer.text();
    if (Buffer.byteLength(raw) > MAX_BYTES) return failed('invalid_response');
    const body = JSON.parse(raw) as unknown;
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length > MAX_MODELS) return failed('invalid_response');
    const models = new Set<string>();
    for (const item of data as unknown[]) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !MODEL_NAME.test(id)) return failed('invalid_response');
      models.add(id);
    }
    return Object.freeze({ status: 'listed', models: Object.freeze([...models].sort()) });
  } catch {
    return failed('invalid_response');
  }
}

/**
 * How the registry compares with what NVIDIA serves: registered models NVIDIA no longer lists
 * (retired or renamed: to review before they fail), and the count of served models MelonOffice
 * has not registered (a count only: each needs its terms read before it is added).
 */
export interface CatalogueDrift {
  readonly missing: readonly string[];
  readonly unregistered: number;
}

export function catalogueDrift(served: readonly string[]): CatalogueDrift {
  const listed = new Set(served);
  const registered = new Set(Object.values(NVIDIA_API_MODEL_NAMES));
  return Object.freeze({
    missing: Object.freeze([...registered].filter((m) => !listed.has(m)).sort()),
    unregistered: served.filter((m) => !registered.has(m)).length,
  });
}
