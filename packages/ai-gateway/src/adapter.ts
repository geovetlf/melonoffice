import type { AICapability, AIModality, CredentialReference } from '@melonoffice/domain';
import type { AIMessage, AIOutputSchema } from './request.js';
import type { AIToolCall, AIToolDefinition } from './tools.js';

/**
 * What the gateway gives an adapter for one attempt (ADR-0027). Built only from the validated
 * request and the registry: no organization, user or secret. The credential is a reference the
 * adapter resolves itself, through infrastructure, just before calling the provider.
 */
export interface ProviderCall {
  readonly requestId: string;
  /** Stable for the request across retries and models: pass it where the provider supports it. */
  readonly idempotencyKey: string;
  readonly model: { readonly id: string; readonly version: string };
  readonly capability: AICapability;
  readonly messages: readonly AIMessage[];
  readonly outputModality: AIModality;
  readonly maxOutputTokens: number;
  readonly structuredOutput: boolean;
  /** The shape of a structured answer, already checked (ADR-0038). */
  readonly outputSchema?: AIOutputSchema;
  /** The tools the model may call, already checked (R3, ADR-0076). */
  readonly tools?: readonly AIToolDefinition[];
  readonly credential: CredentialReference;
  /** When the call must have finished. */
  readonly deadline: Date;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Of `inputTokens`, how many the provider served from its cache, when it says. */
  readonly cachedInputTokens?: number;
}

/** What a model answered: text, a structured answer, or calls to the tools it was offered. */
export interface AIOutput {
  readonly text?: string;
  readonly structured?: unknown;
  readonly toolCalls?: readonly AIToolCall[];
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use';

/**
 * How a provider call failed, as the adapter classifies it. The gateway decides from this alone
 * whether to retry, fall back or stop; it never sees the provider's own error format.
 */
export type ProviderErrorKind =
  /** Retried: the provider may answer next time. */
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'unavailable'
  /** Not retried. */
  | 'authentication'
  | 'invalid_request'
  | 'content_policy'
  | 'invalid_response'
  /** The input did not fit this model's context: not retried; a larger model may take it. */
  | 'context_overflow';

export type ProviderOutcome =
  | {
      readonly status: 'success';
      /** `toolCalls`: the tools the model asked to call, in its order (R3, ADR-0076). */
      readonly output: AIOutput;
      readonly usage: ProviderUsage;
      readonly finishReason: FinishReason;
      /** The provider's own id for the call, when it gives one. */
      readonly providerRequestId?: string;
    }
  | {
      readonly status: 'error';
      readonly kind: ProviderErrorKind;
      /** The provider's HTTP status, when there is one. Never its message. */
      readonly httpStatus?: number;
      /**
       * On `rate_limited`: how long the provider asked to wait before the next call (its
       * `Retry-After`), in milliseconds, when it said (ADR-0080).
       */
      readonly retryAfterMs?: number;
    };

/**
 * One piece of a streamed answer (R4, ADR-0077). The texts, joined, must be the `end` outcome's
 * text exactly; the gateway refuses a stream where they differ.
 */
export type ProviderStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'end'; readonly outcome: ProviderOutcome };

export type ProviderHealth = 'available' | 'degraded' | 'unavailable';

/**
 * Translates MelonMotor's calls to one official provider API and back (ADR-0027). Nothing else
 * knows a provider's request or response format. Each adapter lives in its own package (the
 * first, Vertex AI, in `@melonoffice/ai-vertex`, ADR-0038); tests use fake adapters.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  /** Changes whenever the translation changes, for reproducibility. */
  readonly adapterVersion: string;
  generate(call: ProviderCall): Promise<ProviderOutcome>;
  /**
   * Streaming (R4, ADR-0077), for adapters and models that support it: the answer's text as it
   * comes, then exactly one `end` with the whole outcome, as `generate` would have answered. A
   * streamed call is text only: it is never given tools or an output schema. Like `generate`, it
   * never throws and never passes on the provider's own words about an error.
   */
  stream?(call: ProviderCall): AsyncIterable<ProviderStreamEvent>;
  capabilities(): readonly AICapability[];
  health(): Promise<ProviderHealth>;
}

/**
 * Where adapters get credentials: infrastructure (e.g. a secret manager read with the service's
 * runtime identity). The value never leaves the adapter: it is not returned to the gateway,
 * logged, audited, stored or given to a model. Not implemented in X4.
 */
export interface CredentialResolver {
  resolve(reference: CredentialReference): Promise<ProviderCredential>;
}

/**
 * A resolved credential. Opaque: it serialises and prints as `[redacted]`, so it cannot leak
 * into a log line or a JSON body by accident.
 */
export class ProviderCredential {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** For the adapter's HTTP client only. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

export const TRANSIENT_ERRORS: readonly ProviderErrorKind[] = [
  'timeout',
  'network',
  'rate_limited',
  'server_error',
  'unavailable',
];

/** Worth trying again on the same model: timeouts, network errors, 429 and 5xx. */
export const isTransient = (kind: ProviderErrorKind): boolean => TRANSIENT_ERRORS.includes(kind);

/**
 * Worth trying another model: the provider itself could not serve the call. A request the
 * provider refused (invalid, content policy) would be refused elsewhere too, so it never falls
 * back.
 */
export const allowsFallback = (kind: ProviderErrorKind): boolean =>
  isTransient(kind) ||
  kind === 'authentication' ||
  kind === 'invalid_response' ||
  kind === 'context_overflow';

/** The longest a provider's `Retry-After` is honoured, in milliseconds (a day). */
const MAX_RETRY_AFTER_MS = 86_400_000;

/**
 * A `Retry-After` header as milliseconds from now (ADR-0080): seconds, or an HTTP date. Undefined
 * when absent or unreadable, never negative, and at most a day, so a provider cannot park a
 * server for longer.
 */
export function retryAfterMsOf(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value.length === 0 || value.length > 64) return undefined;
  let ms: number;
  if (/^\d{1,9}$/.test(value)) ms = Number(value) * 1000;
  else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    ms = at - nowMs;
  }
  return Math.min(Math.max(0, Math.ceil(ms)), MAX_RETRY_AFTER_MS);
}
