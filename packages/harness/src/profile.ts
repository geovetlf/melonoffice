import type { AIQualityTier, AIRoutingStrategy } from '@melonoffice/domain';
import {
  HARNESS_INTENTS,
  HarnessError,
  type HarnessContextSourceId,
  type HarnessIntent,
  type ModelProfile,
  type TaskClassification,
} from './model.js';

/**
 * How a task's reading turns into a model profile and a context plan (ADR-0099 §4, §5). A policy
 * is configuration: it names strategies and, optionally, quality floors, never a model, provider
 * or price. The AI Gateway's router still chooses the model, under the agent's model policy.
 */
export interface HarnessProfilePolicy {
  readonly id: string;
  readonly version: number;
  /** The profile for each intent. */
  readonly intents: Readonly<Record<HarnessIntent, ModelProfile>>;
  /**
   * The strategy of a complex task, whatever its intent: complexity is a reason to prefer a
   * better model when one is allowed.
   */
  readonly complex?: { readonly strategy: AIRoutingStrategy };
}

const STRATEGIES: readonly AIRoutingStrategy[] = [
  'cost_optimized',
  'balanced',
  'quality_first',
  'latency_first',
  'reliability_first',
];
const QUALITIES: readonly AIQualityTier[] = ['basic', 'standard', 'high'];

/**
 * The initial policy: simple readings go to the cheapest model that fits, analysis and planning
 * to the best, the rest balanced. No quality floor: with only Gemini 2.5 Flash-Lite (`basic`)
 * approved (D-7), a floor would refuse every complex task instead of answering it.
 */
export const DEFAULT_HARNESS_PROFILE_POLICY: HarnessProfilePolicy = Object.freeze({
  id: 'harness_default',
  version: 1,
  intents: Object.freeze({
    question: Object.freeze({ strategy: 'cost_optimized' }),
    classification: Object.freeze({ strategy: 'cost_optimized' }),
    extraction: Object.freeze({ strategy: 'cost_optimized' }),
    summary: Object.freeze({ strategy: 'cost_optimized' }),
    generation: Object.freeze({ strategy: 'balanced' }),
    action: Object.freeze({ strategy: 'balanced' }),
    analysis: Object.freeze({ strategy: 'quality_first' }),
    planning: Object.freeze({ strategy: 'quality_first' }),
  }),
  complex: Object.freeze({ strategy: 'quality_first' }),
} satisfies HarnessProfilePolicy);

/** Checks a policy when it is loaded: every intent has a known strategy and floor. */
export function checkProfilePolicy(policy: HarnessProfilePolicy): HarnessProfilePolicy {
  const bad = (field: string): never => {
    throw new HarnessError('invalid_task', `profile_policy.${field}`);
  };
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(policy.id)) bad('id');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) bad('version');
  for (const intent of HARNESS_INTENTS) {
    const profile = policy.intents[intent];
    if (profile === undefined || !STRATEGIES.includes(profile.strategy)) bad(`${intent}.strategy`);
    if (profile.minimumQuality !== undefined && !QUALITIES.includes(profile.minimumQuality)) {
      bad(`${intent}.minimumQuality`);
    }
  }
  if (policy.complex !== undefined && !STRATEGIES.includes(policy.complex.strategy)) {
    bad('complex.strategy');
  }
  return policy;
}

/** The model profile of one reading. */
export function modelProfileOf(
  classification: TaskClassification,
  policy: HarnessProfilePolicy = DEFAULT_HARNESS_PROFILE_POLICY,
): ModelProfile {
  const base = policy.intents[classification.intent];
  const strategy =
    classification.complexity === 'complex' && policy.complex !== undefined
      ? policy.complex.strategy
      : base.strategy;
  return Object.freeze({
    strategy,
    ...(base.minimumQuality === undefined ? {} : { minimumQuality: base.minimumQuality }),
  });
}

/** Intents that can work on the text they are given alone. */
const SELF_CONTAINED: readonly HarnessIntent[] = ['classification', 'extraction', 'summary'];

/**
 * The context a task needs, and only that (ADR-0099 §13): the company memory unless the task
 * only works on the text it gives (a classification, extraction or summary about no business
 * area), the CRM when it is about customers. Each source is still read as the person, with the
 * agent's permissions.
 */
export function contextPlanOf(classification: TaskClassification): HarnessContextSourceId[] {
  const plan: HarnessContextSourceId[] = [];
  if (!SELF_CONTAINED.includes(classification.intent) || classification.domains.length > 0) {
    plan.push('company_brain');
  }
  if (classification.domains.includes('crm')) plan.push('crm');
  return plan;
}

/** A task that should be a plan of several steps, which the planner runs (block 3). */
export const needsPlan = (classification: TaskClassification): boolean =>
  classification.complexity === 'complex' &&
  (classification.intent === 'planning' || classification.intent === 'action');
