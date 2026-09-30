import type {
  AIDataPolicy,
  AICapability,
  AILatencyTier,
  AIModality,
  AIQualityTier,
  AIRoutingStrategy,
  DataSensitivity,
  DeploymentEnvironment,
  ModelPolicy,
} from '@melonoffice/domain';
import type { ProviderHealth } from './adapter.js';
import { costMicroUsd } from './cost.js';
import { dataPolicyAllows } from './data-policy.js';
import {
  modelKey,
  sensitivityRank,
  type ProviderRegistry,
  type ResolvedModel,
} from './registry.js';
import { LATENCY_TIERS, QUALITY_TIERS } from './request.js';

/** What the router chooses from. All of it comes from the validated request and the tenant. */
export interface RouteRequest {
  readonly capability: AICapability;
  readonly inputModalities: readonly AIModality[];
  readonly outputModality: AIModality;
  readonly quality?: AIQualityTier;
  readonly latency?: AILatencyTier;
  readonly maxCostMicroUsd?: number;
  readonly sensitivity: DataSensitivity;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly minContextTokens?: number;
  readonly structuredOutput?: boolean;
  readonly toolUse?: boolean;
  readonly streaming?: boolean;
  /** The caller's order, when it has one; otherwise the policy's, otherwise `balanced`. */
  readonly strategy?: AIRoutingStrategy;
}

export const DEFAULT_ROUTING_STRATEGY: AIRoutingStrategy = 'balanced';

/**
 * Why no model fits. Each is the step at which the last candidate was ruled out, in the router's
 * fixed order, so the answer is the most specific reason.
 */
export type RouteRefusal =
  | 'no_model_available'
  | 'data_policy_not_allowed'
  | 'capability_unsupported'
  | 'modality_unsupported'
  | 'requirements_unmet'
  | 'provider_not_allowed'
  | 'model_not_allowed'
  | 'model_disabled'
  | 'environment_not_allowed'
  | 'sensitivity_not_allowed'
  | 'quality_not_met'
  | 'latency_not_met'
  | 'cost_limit_exceeded'
  | 'provider_unavailable';

export interface RouteCandidate extends ResolvedModel {
  /** The most the call can cost on this model (input estimate + `maxOutputTokens`). */
  readonly estimatedCostMicroUsd: number | undefined;
}

export type RouteDecision =
  | {
      readonly status: 'selected';
      /** The chosen model first, then the compatible fallbacks, in order. */
      readonly candidates: readonly RouteCandidate[];
      readonly reason: 'preferred' | 'best_match';
      readonly strategy: AIRoutingStrategy;
    }
  | { readonly status: 'none'; readonly reason: RouteRefusal };

const rank = <T extends string>(list: readonly T[], value: T): number => list.indexOf(value);

/**
 * Chooses a model (ADR-0027, ADR-0072). Deterministic: equal inputs give the same answer, in the
 * same order. No AI: the candidates are filtered by fixed rules (first the data policy, ADR-0100:
 * a provider the call's data may not reach is never a candidate; then capability, modality, context
 * and output size, structured output, tools, streaming, policy, status, environment, sensitivity,
 * quality, latency, cost limit, provider health), and only then ordered: the policy's preferred
 * list first, then the routing strategy, then the model's priority and its id. A strategy only
 * orders; it can never bring back a model a filter left out.
 *
 * `unavailable` holds the providers known to be down; they are left out. `health` says how the
 * rest are doing, for `reliability_first`. `dataPolicy` is the server's data policy (ADR-0100).
 */
export function routeModel(
  registry: ProviderRegistry,
  policy: ModelPolicy,
  environment: DeploymentEnvironment,
  request: RouteRequest,
  unavailable: ReadonlySet<string> = new Set(),
  health: (providerId: string) => ProviderHealth = () => 'available',
  dataPolicy?: AIDataPolicy,
): RouteDecision {
  const strategy = request.strategy ?? policy.strategy ?? DEFAULT_ROUTING_STRATEGY;
  const limit = [request.maxCostMicroUsd, policy.maxCostMicroUsd].filter(
    (v): v is number => v !== undefined,
  );
  const maxCost = limit.length === 0 ? undefined : Math.min(...limit);
  const maxLatency = [request.latency, policy.maxLatency]
    .filter((v): v is AILatencyTier => v !== undefined)
    .reduce<number | undefined>(
      (min, v) => Math.min(min ?? Infinity, rank(LATENCY_TIERS, v)),
      undefined,
    );
  // The higher of what the call asks for and what the policy requires.
  const qualityFloor = [request.quality, policy.minimumQuality]
    .filter((v): v is AIQualityTier => v !== undefined)
    .reduce<number | undefined>((max, v) => Math.max(max ?? -1, rank(QUALITY_TIERS, v)), undefined);
  const estimate = (r: ResolvedModel) =>
    costMicroUsd(r.model.pricing, {
      inputTokens: request.estimatedInputTokens,
      outputTokens: request.maxOutputTokens,
    });

  const steps: [RouteRefusal, (r: ResolvedModel) => boolean][] = [
    // The data policy before anything else (Geovet, 2026-09-30): what the call carries decides
    // which providers may be considered at all, whatever their capability, price or preference.
    [
      'data_policy_not_allowed',
      (r) => dataPolicyAllows(dataPolicy, r.provider.id, environment, request.sensitivity),
    ],
    [
      'capability_unsupported',
      (r) =>
        r.model.capabilities.includes(request.capability) &&
        (policy.allowedCapabilities?.includes(request.capability) ?? true),
    ],
    [
      'modality_unsupported',
      (r) =>
        request.inputModalities.every((m) => r.model.inputModalities.includes(m)) &&
        r.model.outputModalities.includes(request.outputModality) &&
        [...request.inputModalities, request.outputModality].every(
          (m) => policy.allowedModalities?.includes(m) ?? true,
        ),
    ],
    [
      'requirements_unmet',
      (r) =>
        r.model.contextWindowTokens >=
          Math.max(
            request.minContextTokens ?? 0,
            request.estimatedInputTokens + request.maxOutputTokens,
          ) &&
        r.model.maxOutputTokens >= request.maxOutputTokens &&
        (!request.structuredOutput || r.model.structuredOutput) &&
        (!request.toolUse || r.model.toolUse) &&
        (!request.streaming || r.model.streaming),
    ],
    ['provider_not_allowed', (r) => policy.allowedProviders?.includes(r.provider.id) ?? true],
    [
      'model_not_allowed',
      (r) => policy.allowedModels?.includes(modelKey(r.provider.id, r.model.modelId)) ?? true,
    ],
    ['model_disabled', (r) => r.provider.status === 'active' && r.model.status === 'active'],
    [
      'environment_not_allowed',
      (r) =>
        policy.environments.includes(environment) &&
        r.provider.environments.includes(environment) &&
        r.model.environments.includes(environment),
    ],
    [
      'sensitivity_not_allowed',
      (r) => {
        const s = sensitivityRank(request.sensitivity);
        return (
          s <= sensitivityRank(policy.maxSensitivity) &&
          s <= sensitivityRank(r.provider.maxSensitivity) &&
          s <= sensitivityRank(r.model.maxSensitivity)
        );
      },
    ],
    [
      'quality_not_met',
      (r) => qualityFloor === undefined || rank(QUALITY_TIERS, r.model.quality) >= qualityFloor,
    ],
    [
      'latency_not_met',
      (r) => maxLatency === undefined || rank(LATENCY_TIERS, r.model.latency) <= maxLatency,
    ],
    [
      'cost_limit_exceeded',
      (r) => {
        if (maxCost === undefined) return true;
        const cost = estimate(r);
        // With a limit, a model whose price is unknown cannot be shown to respect it.
        return cost !== undefined && cost <= maxCost;
      },
    ],
    ['provider_unavailable', (r) => !unavailable.has(r.provider.id)],
  ];

  let candidates: readonly ResolvedModel[] = registry.models();
  if (candidates.length === 0) return { status: 'none', reason: 'no_model_available' };
  for (const [refusal, keep] of steps) {
    candidates = candidates.filter(keep);
    if (candidates.length === 0) return Object.freeze({ status: 'none', reason: refusal });
  }

  const preferred = policy.preferred ?? [];
  const order = (r: ResolvedModel) => {
    const i = preferred.indexOf(modelKey(r.provider.id, r.model.modelId));
    return i === -1 ? preferred.length : i;
  };
  // Preferred providers next (ADR-0100): evaluated first, never required.
  const providers = policy.preferredProviders ?? [];
  const providerOrder = (r: ResolvedModel) => {
    const i = providers.indexOf(r.provider.id);
    return i === -1 ? providers.length : i;
  };
  type Scored = RouteCandidate;
  const cost = (r: Scored) => r.estimatedCostMicroUsd ?? Infinity;
  const quality = (r: Scored) => -rank(QUALITY_TIERS, r.model.quality);
  const latency = (r: Scored) => rank(LATENCY_TIERS, r.model.latency);
  const priority = (r: Scored) => r.model.priority ?? 1000;
  const healthy = (r: Scored) => (health(r.provider.id) === 'available' ? 0 : 1);
  // `balanced`: at least the quality asked for, or `standard` when nothing was asked, if any fits.
  const floor = rank(QUALITY_TIERS, request.quality ?? 'standard');
  const meetsFloor = (r: Scored) => (rank(QUALITY_TIERS, r.model.quality) >= floor ? 0 : 1);
  const keys: Record<AIRoutingStrategy, readonly ((r: Scored) => number)[]> = {
    cost_optimized: [cost, quality, latency],
    balanced: [meetsFloor, cost, quality, latency],
    quality_first: [quality, cost, latency],
    latency_first: [latency, cost, quality],
    reliability_first: [healthy, priority, cost, quality],
  };
  const byStrategy = [order, providerOrder, ...keys[strategy], priority];
  const sorted = candidates
    .map((r) => Object.freeze({ ...r, estimatedCostMicroUsd: estimate(r) }))
    .sort((a, b) => {
      for (const key of byStrategy) {
        const diff = key(a) - key(b);
        if (diff !== 0 && !Number.isNaN(diff)) return diff;
      }
      return compare(
        modelKey(a.provider.id, a.model.modelId),
        modelKey(b.provider.id, b.model.modelId),
      );
    });
  const first = sorted[0];
  return Object.freeze({
    status: 'selected',
    candidates: Object.freeze(sorted),
    reason:
      first !== undefined &&
      (order(first) < preferred.length || providerOrder(first) < providers.length)
        ? 'preferred'
        : 'best_match',
    strategy,
  });
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
