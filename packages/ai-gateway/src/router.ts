import type {
  AICapability,
  AILatencyTier,
  AIModality,
  AIQualityTier,
  DataSensitivity,
  DeploymentEnvironment,
  ModelPolicy,
} from '@melonoffice/domain';
import { costMicroUsd } from './cost.js';
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
}

/**
 * Why no model fits. Each is the step at which the last candidate was ruled out, in the router's
 * fixed order, so the answer is the most specific reason.
 */
export type RouteRefusal =
  | 'no_model_available'
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
    }
  | { readonly status: 'none'; readonly reason: RouteRefusal };

const rank = <T extends string>(list: readonly T[], value: T): number => list.indexOf(value);

/**
 * Chooses a model (ADR-0027). Deterministic: equal inputs give the same answer, in the same
 * order. No AI: the candidates are filtered by fixed rules, then sorted by the policy's preferred
 * list, higher quality, lower known cost, faster latency, then provider and model id.
 *
 * `unavailable` holds the providers known to be down; they are left out.
 */
export function routeModel(
  registry: ProviderRegistry,
  policy: ModelPolicy,
  environment: DeploymentEnvironment,
  request: RouteRequest,
  unavailable: ReadonlySet<string> = new Set(),
): RouteDecision {
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
  const estimate = (r: ResolvedModel) =>
    costMicroUsd(r.model.pricing, {
      inputTokens: request.estimatedInputTokens,
      outputTokens: request.maxOutputTokens,
    });

  const steps: [RouteRefusal, (r: ResolvedModel) => boolean][] = [
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
      (r) =>
        request.quality === undefined ||
        rank(QUALITY_TIERS, r.model.quality) >= rank(QUALITY_TIERS, request.quality),
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
  const sorted = candidates
    .map((r) => Object.freeze({ ...r, estimatedCostMicroUsd: estimate(r) }))
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        rank(QUALITY_TIERS, b.model.quality) - rank(QUALITY_TIERS, a.model.quality) ||
        (a.estimatedCostMicroUsd ?? Infinity) - (b.estimatedCostMicroUsd ?? Infinity) ||
        rank(LATENCY_TIERS, a.model.latency) - rank(LATENCY_TIERS, b.model.latency) ||
        compare(modelKey(a.provider.id, a.model.modelId), modelKey(b.provider.id, b.model.modelId)),
    );
  const first = sorted[0];
  return Object.freeze({
    status: 'selected',
    candidates: Object.freeze(sorted),
    reason: first !== undefined && order(first) < preferred.length ? 'preferred' : 'best_match',
  });
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
