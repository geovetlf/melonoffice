import type { ModelPolicy, PolicyId } from '@melonoffice/domain';
import { isDeploymentEnvironment } from '@melonoffice/tools';
import { AIConfigError } from './errors.js';
import { AI_CAPABILITIES, AI_MODALITIES, LATENCY_TIERS, SENSITIVITIES } from './request.js';

const ID = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL = /^[a-z][a-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const invalid = (detail: string): never => {
  throw new AIConfigError(`policy.${detail}`);
};

const list = (value: unknown, ok: (v: unknown) => boolean, field: string): void => {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every(ok) || new Set(value).size !== value.length) {
    invalid(field);
  }
};

const int = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Checks a model policy; one that could widen access by mistake is refused when loaded. */
export function checkModelPolicy(p: ModelPolicy): ModelPolicy {
  if (!ID.test(p.id)) invalid('id');
  if (!int(p.version, 1, Number.MAX_SAFE_INTEGER)) invalid('version');
  list(p.allowedProviders, (v) => typeof v === 'string' && PROVIDER.test(v), 'allowedProviders');
  list(p.allowedModels, (v) => typeof v === 'string' && MODEL.test(v), 'allowedModels');
  list(p.preferred, (v) => typeof v === 'string' && MODEL.test(v), 'preferred');
  list(
    p.allowedCapabilities,
    (v) => (AI_CAPABILITIES as readonly unknown[]).includes(v),
    'allowedCapabilities',
  );
  list(
    p.allowedModalities,
    (v) => (AI_MODALITIES as readonly unknown[]).includes(v),
    'allowedModalities',
  );
  if (!Array.isArray(p.environments) || !p.environments.every(isDeploymentEnvironment)) {
    invalid('environments');
  }
  if (!(SENSITIVITIES as readonly string[]).includes(p.maxSensitivity)) invalid('maxSensitivity');
  if (p.maxCostMicroUsd !== undefined && !int(p.maxCostMicroUsd, 0, Number.MAX_SAFE_INTEGER)) {
    invalid('maxCostMicroUsd');
  }
  if (p.maxLatency !== undefined && !(LATENCY_TIERS as readonly string[]).includes(p.maxLatency)) {
    invalid('maxLatency');
  }
  if (p.fallback !== 'none' && p.fallback !== 'compatible') invalid('fallback');
  if (!int(p.maxAttempts, 1, 5)) invalid('maxAttempts');
  if (!int(p.backoffMs, 0, 30_000)) invalid('backoffMs');
  return p;
}

/**
 * The policy used when a specialist names none. A safe default, not a product decision: any
 * registered provider and model, data up to `internal`, fallback only to a compatible model,
 * and up to three attempts on transient errors.
 */
export const DEFAULT_MODEL_POLICY: ModelPolicy = Object.freeze({
  id: 'default_model' as PolicyId,
  version: 1,
  environments: Object.freeze(['dev', 'staging', 'prod'] as const),
  maxSensitivity: 'internal',
  fallback: 'compatible',
  maxAttempts: 3,
  backoffMs: 500,
});

/** Model policies by id and version, from configuration. */
export interface ModelPolicyCatalogue {
  /** The policy a specialist names, or the default when it names none. */
  resolve(
    reference: { readonly id: string; readonly version: number } | undefined,
  ): ModelPolicy | undefined;
}

export function createModelPolicyCatalogue(
  policies: readonly ModelPolicy[],
  fallback: ModelPolicy = DEFAULT_MODEL_POLICY,
): ModelPolicyCatalogue {
  const byKey = new Map<string, ModelPolicy>();
  for (const p of [fallback, ...policies]) {
    checkModelPolicy(p);
    const key = `${p.id}@${p.version}`;
    if (byKey.has(key) && p !== fallback) invalid(`duplicate:${key}`);
    byKey.set(key, Object.freeze(structuredClone(p)));
  }
  const defaultPolicy = byKey.get(`${fallback.id}@${fallback.version}`);
  return Object.freeze({
    resolve(reference: { readonly id: string; readonly version: number } | undefined) {
      // A specialist that names a policy gets exactly that version, or nothing: never a guess.
      if (reference === undefined) return defaultPolicy;
      return byKey.get(`${reference.id}@${reference.version}`);
    },
  });
}
