import {
  creditsFor,
  routeModel,
  type CreditRate,
  type ModelPolicyCatalogue,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import type {
  DeploymentEnvironment,
  PlanBudget,
  PlanEstimate,
  SpecialistVersion,
} from '@melonoffice/domain';

/**
 * Estimates what a specialist step's AI work could cost (ADR-0028). An estimate is never a
 * charge and never a reservation: only the AI Gateway charges, once, for a call that happened.
 */
export interface PlanEstimator {
  estimate(version: SpecialistVersion, budget: PlanBudget | undefined): PlanEstimate;
}

export const UNKNOWN_ESTIMATE: PlanEstimate = Object.freeze({
  status: 'unknown',
  costMicroUsd: null,
  credits: null,
});

export interface PlanEstimatorOptions {
  readonly registry: ProviderRegistry;
  readonly policies: ModelPolicyCatalogue;
  readonly environment: DeploymentEnvironment | undefined;
  /** The credit rate (D-12). Without one, credits stay unknown. */
  readonly rate: CreditRate | undefined;
}

/**
 * The estimator the gateway's own pure pieces make: the specialist's model policy, the gateway's
 * deterministic router, and the model's known price for the step's token budget. Anything
 * missing (budget, environment, policy, a routable model, a known price or the credit rate)
 * makes the estimate `unknown`: a cost is never invented.
 */
export function createPlanEstimator({
  registry,
  policies,
  environment,
  rate,
}: PlanEstimatorOptions): PlanEstimator {
  return Object.freeze({
    estimate(version: SpecialistVersion, budget: PlanBudget | undefined): PlanEstimate {
      if (budget === undefined || environment === undefined) return UNKNOWN_ESTIMATE;
      const policy = policies.resolve(version.configuration.policies.model);
      if (policy === undefined) return UNKNOWN_ESTIMATE;
      const route = routeModel(registry, policy, environment, {
        capability: 'text_generation',
        inputModalities: ['text'],
        outputModality: 'text',
        sensitivity: 'internal',
        estimatedInputTokens: budget.inputTokens,
        maxOutputTokens: budget.outputTokens,
      });
      const cost =
        route.status === 'selected' ? route.candidates[0]?.estimatedCostMicroUsd : undefined;
      if (cost === undefined) return UNKNOWN_ESTIMATE;
      if (rate === undefined) {
        return Object.freeze({ status: 'unknown', costMicroUsd: cost, credits: null });
      }
      return Object.freeze({
        status: 'estimated',
        costMicroUsd: cost,
        credits: creditsFor(cost, rate),
      });
    },
  });
}

/** A plan's total: `estimated` only when every specialist step's estimate is. */
export function totalEstimate(estimates: readonly PlanEstimate[]): PlanEstimate {
  if (estimates.length === 0 || estimates.some((e) => e.status !== 'estimated')) {
    return UNKNOWN_ESTIMATE;
  }
  return Object.freeze({
    status: 'estimated',
    costMicroUsd: estimates.reduce((sum, e) => sum + (e.costMicroUsd ?? 0), 0),
    credits: estimates.reduce((sum, e) => sum + (e.credits ?? 0), 0),
  });
}
