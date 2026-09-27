import type { AICapability, AIModality, CredentialReference } from '@melonoffice/domain';
import type { AIMessage } from './request.js';

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
  readonly credential: CredentialReference;
  /** When the call must have finished. */
  readonly deadline: Date;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
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
  | 'invalid_response';

export type ProviderOutcome =
  | {
      readonly status: 'success';
      readonly output: { readonly text?: string; readonly structured?: unknown };
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
    };

export type ProviderHealth = 'available' | 'degraded' | 'unavailable';

/**
 * Translates MelonMotor's calls to one official provider API and back (ADR-0027). Nothing else
 * knows a provider's request or response format. No adapter exists yet: the first arrives with
 * the choice of provider (D-7). Tests use fake adapters.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  /** Changes whenever the translation changes, for reproducibility. */
  readonly adapterVersion: string;
  generate(call: ProviderCall): Promise<ProviderOutcome>;
  /** Streaming, for adapters and models that support it. Not used by the gateway yet. */
  stream?(call: ProviderCall): AsyncIterable<{ readonly text: string }>;
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
  isTransient(kind) || kind === 'authentication' || kind === 'invalid_response';
