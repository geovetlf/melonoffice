import type { AIModelDefinition, AIProviderDefinition, DataSensitivity } from '@melonoffice/domain';
import { isDeploymentEnvironment, isForbiddenField } from '@melonoffice/tools';
import type { ProviderAdapter } from './adapter.js';
import { AIConfigError } from './errors.js';
import {
  AI_CAPABILITIES,
  AI_MODALITIES,
  LATENCY_TIERS,
  QUALITY_TIERS,
  SENSITIVITIES,
} from './request.js';

export const AI_STATUSES = ['active', 'paused', 'disabled', 'retired'] as const;

/**
 * Aggregators and intermediaries. MelonOffice uses official provider APIs only (ADR-0027):
 * a provider whose id or name matches one of these is refused.
 */
export const INTERMEDIARIES: readonly RegExp[] = [
  /openrouter/i,
  /replicate/i,
  /fal[._-]?ai/i,
  /^fal$/i,
  /together/i,
  /hugging\s*face|huggingface|^hf$/i,
];

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

export const sensitivityRank = (s: DataSensitivity): number => SENSITIVITIES.indexOf(s);

export const modelKey = (providerId: string, modelId: string): string => `${providerId}/${modelId}`;

const invalid = (detail: string): never => {
  throw new AIConfigError(detail);
};

const listOf = (value: unknown, allowed: readonly string[], field: string): void => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((v) => typeof v !== 'string' || !allowed.includes(v)) ||
    new Set(value).size !== value.length
  ) {
    invalid(field);
  }
};

const count = (value: unknown, min: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

export function checkProvider(p: AIProviderDefinition): AIProviderDefinition {
  if (!ID.test(p.id)) invalid('provider.id');
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 100) {
    invalid('provider.name');
  }
  if (INTERMEDIARIES.some((r) => r.test(p.id) || r.test(p.name))) {
    invalid(`provider.intermediary:${p.id}`);
  }
  if (p.access !== 'official') invalid('provider.access');
  if (!(AI_STATUSES as readonly string[]).includes(p.status)) invalid('provider.status');
  listOf(p.capabilities, AI_CAPABILITIES, 'provider.capabilities');
  listOf(p.modalities, AI_MODALITIES, 'provider.modalities');
  if (!Array.isArray(p.environments) || !p.environments.every(isDeploymentEnvironment)) {
    invalid('provider.environments');
  }
  // A reference only: provider and scopes, never a value.
  const credential = p.credential as unknown as Record<string, unknown>;
  if (
    typeof credential !== 'object' ||
    credential === null ||
    Object.keys(credential).some((k) => k !== 'provider' && k !== 'scopes') ||
    typeof credential.provider !== 'string' ||
    !ID.test(credential.provider) ||
    isForbiddenField(credential.provider) ||
    !Array.isArray(credential.scopes)
  ) {
    invalid('provider.credential');
  }
  if (!(SENSITIVITIES as readonly string[]).includes(p.maxSensitivity)) {
    invalid('provider.maxSensitivity');
  }
  return p;
}

export function checkModel(
  m: AIModelDefinition,
  provider: AIProviderDefinition,
): AIModelDefinition {
  const at = `model.${m.providerId}/${m.modelId}`;
  if (m.providerId !== provider.id) invalid(`${at}.providerId`);
  if (!MODEL_ID.test(m.modelId)) invalid(`${at}.modelId`);
  if (!VERSION.test(m.version)) invalid(`${at}.version`);
  if (!(AI_STATUSES as readonly string[]).includes(m.status)) invalid(`${at}.status`);
  listOf(m.capabilities, AI_CAPABILITIES, `${at}.capabilities`);
  if (!m.capabilities.every((c) => provider.capabilities.includes(c))) {
    invalid(`${at}.capabilities`);
  }
  listOf(m.inputModalities, AI_MODALITIES, `${at}.inputModalities`);
  listOf(m.outputModalities, AI_MODALITIES, `${at}.outputModalities`);
  if (!count(m.contextWindowTokens, 1)) invalid(`${at}.contextWindowTokens`);
  if (!count(m.maxOutputTokens, 1)) invalid(`${at}.maxOutputTokens`);
  for (const flag of ['structuredOutput', 'toolUse', 'streaming'] as const) {
    if (typeof m[flag] !== 'boolean') invalid(`${at}.${flag}`);
  }
  if (!(QUALITY_TIERS as readonly string[]).includes(m.quality)) invalid(`${at}.quality`);
  if (!(LATENCY_TIERS as readonly string[]).includes(m.latency)) invalid(`${at}.latency`);
  const { pricing } = m;
  if (pricing.status === 'known') {
    if (
      pricing.currency !== 'USD' ||
      !count(pricing.inputMicroUsdPerMillionTokens, 0) ||
      !count(pricing.outputMicroUsdPerMillionTokens, 0) ||
      typeof pricing.source !== 'string' ||
      pricing.source.length === 0 ||
      Number.isNaN(Date.parse(pricing.asOf))
    ) {
      invalid(`${at}.pricing`);
    }
  } else if (pricing.status !== 'unknown') {
    invalid(`${at}.pricing`);
  }
  if (!Array.isArray(m.environments) || !m.environments.every(isDeploymentEnvironment)) {
    invalid(`${at}.environments`);
  }
  if (
    !(SENSITIVITIES as readonly string[]).includes(m.maxSensitivity) ||
    sensitivityRank(m.maxSensitivity) > sensitivityRank(provider.maxSensitivity)
  ) {
    invalid(`${at}.maxSensitivity`);
  }
  return m;
}

/** A model with its provider and the adapter that serves it. */
export interface ResolvedModel {
  readonly provider: AIProviderDefinition;
  readonly model: AIModelDefinition;
  readonly adapter: ProviderAdapter;
}

/**
 * Providers, their models and the adapter of each (ADR-0027): provider → capabilities →
 * models → adapter. It holds no secrets, only credential references, and it never calls a
 * provider: the gateway does, through the adapter.
 */
export interface ProviderRegistry {
  providers(): readonly AIProviderDefinition[];
  provider(id: string): AIProviderDefinition | undefined;
  /** Every model of every provider, in a fixed order. */
  models(): readonly ResolvedModel[];
  /** One exact model of a provider. */
  model(providerId: string, modelId: string): ResolvedModel | undefined;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

/**
 * Builds the registry, checking every provider, model and adapter:
 *
 * - providers are official APIs, never intermediaries, with a credential reference only;
 * - a model belongs to a known provider and claims nothing its provider cannot do;
 * - every provider has exactly one adapter that says it can do what the provider claims.
 */
export function createProviderRegistry(input: {
  readonly providers: readonly AIProviderDefinition[];
  readonly models: readonly AIModelDefinition[];
  readonly adapters: readonly ProviderAdapter[];
}): ProviderRegistry {
  const providers = new Map<string, AIProviderDefinition>();
  for (const p of input.providers) {
    checkProvider(p);
    if (providers.has(p.id)) invalid(`provider.duplicate:${p.id}`);
    providers.set(p.id, deepFreeze(structuredClone(p)));
  }
  const adapters = new Map<string, ProviderAdapter>();
  for (const a of input.adapters) {
    const provider = providers.get(a.providerId);
    if (provider === undefined) invalid(`adapter.provider:${a.providerId}`);
    if (adapters.has(a.providerId)) invalid(`adapter.duplicate:${a.providerId}`);
    if (!VERSION.test(a.adapterVersion)) invalid(`adapter.version:${a.providerId}`);
    const can = a.capabilities();
    if (!provider?.capabilities.every((c) => can.includes(c))) {
      invalid(`adapter.capabilities:${a.providerId}`);
    }
    adapters.set(a.providerId, a);
  }
  for (const id of providers.keys()) {
    if (!adapters.has(id)) invalid(`adapter.missing:${id}`);
  }
  const models: ResolvedModel[] = [];
  const keys = new Set<string>();
  for (const m of input.models) {
    const provider = providers.get(m.providerId);
    const adapter = adapters.get(m.providerId);
    if (provider === undefined || adapter === undefined) {
      return invalid(`model.provider:${m.providerId}`);
    }
    checkModel(m, provider);
    const key = modelKey(m.providerId, m.modelId);
    if (keys.has(key)) invalid(`model.duplicate:${key}`);
    keys.add(key);
    models.push(Object.freeze({ provider, model: deepFreeze(structuredClone(m)), adapter }));
  }
  models.sort((a, b) => {
    const x = modelKey(a.provider.id, a.model.modelId);
    const y = modelKey(b.provider.id, b.model.modelId);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const allProviders = Object.freeze([...providers.values()]);
  const allModels = Object.freeze(models);
  return Object.freeze({
    providers: () => allProviders,
    provider: (id: string) => providers.get(id),
    models: () => allModels,
    model: (providerId: string, modelId: string) =>
      allModels.find((r) => r.provider.id === providerId && r.model.modelId === modelId),
  });
}

/**
 * MelonOffice's providers and models. Empty: the launch provider is decision D-7, and no
 * provider, model or price is invented before it. Tests use fake providers.
 */
export const AI_PROVIDER_CATALOGUE: readonly AIProviderDefinition[] = Object.freeze([]);
export const AI_MODEL_CATALOGUE: readonly AIModelDefinition[] = Object.freeze([]);

export const defaultProviderRegistry = (): ProviderRegistry =>
  createProviderRegistry({
    providers: AI_PROVIDER_CATALOGUE,
    models: AI_MODEL_CATALOGUE,
    adapters: [],
  });
