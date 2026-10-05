import { CREDIT_RATE } from '@melonoffice/ai-gateway';
import type {
  AICapability,
  AIModality,
  DeploymentEnvironment,
  ModelPolicy,
  PolicyId,
} from '@melonoffice/domain';
import { DEFAULT_HARNESS_LIMITS } from './limits.js';

/**
 * The model policy of agent tasks as the Harness routes them (ADR-0100), version 2 of
 * `agent_task`. An agent names the kind of work (an agent task), never a model: this policy pins
 * no provider and no model. Every model the registry holds is a candidate, and the AI Gateway's
 * router leaves out each one that does not fit the call (data sensitivity, environment,
 * capability, modality, cost, budget, availability).
 *
 * Among those that fit it tries the configured providers first (`preferredProviders`: NVIDIA, by
 * Geovet's decision of 2026-09-30), then the task's strategy (the cheapest that fits for simple
 * work, the strongest for complex work), and falls back automatically to the next compatible
 * model when one is unavailable, fails, is rate limited or would go over the budget. Which
 * providers come first is configuration given here, never a branch in code.
 */
export const HARNESS_TASK_POLICY_REF = Object.freeze({
  id: 'agent_task' as PolicyId,
  version: 2,
});

/**
 * The model policy of a conversation agent's turn as the Harness routes it (ADR-0100), version 2 of
 * `conversation_agent`: like an agent task, no provider or model pinned, text only.
 */
export const HARNESS_CONVERSATION_POLICY_REF = Object.freeze({
  id: 'conversation_agent' as PolicyId,
  version: 2,
});

export interface HarnessTaskPolicyConfig {
  /** Providers to evaluate first, in order. Only an order: every rule still applies. */
  readonly preferredProviders: readonly string[];
  /** Where the policy applies. */
  readonly environments: readonly DeploymentEnvironment[];
  /** The most one call may cost, in millionths of a US dollar (the credit rule's cap). */
  readonly maxCostMicroUsd?: number;
  /** The most provider calls one request may make, over every model (the task's limit). */
  readonly maxModelCalls?: number;
}

/**
 * How every agent's calls are routed in DEV (ADR-0100, ADR-0170): the given providers first, at
 * most one credit per call, and the task's limit of provider calls. The worker, the API and the
 * evals all route with it, so `agent_task@2` is the same policy wherever it is resolved.
 */
export const harnessRoute = (preferredProviders: readonly string[]): HarnessTaskPolicyConfig =>
  Object.freeze({
    preferredProviders: Object.freeze([...preferredProviders]),
    environments: Object.freeze(['dev'] as const),
    maxCostMicroUsd: CREDIT_RATE.microUsdPerCredit,
    maxModelCalls: DEFAULT_HARNESS_LIMITS.maxModelCalls,
  });

const agentPolicy = (
  ref: { readonly id: PolicyId; readonly version: number },
  config: HarnessTaskPolicyConfig,
  only?: {
    readonly capabilities: readonly AICapability[];
    readonly modalities: readonly AIModality[];
  },
): ModelPolicy =>
  Object.freeze({
    id: ref.id,
    version: ref.version,
    ...(only === undefined
      ? {}
      : {
          allowedCapabilities: Object.freeze([...only.capabilities]),
          allowedModalities: Object.freeze([...only.modalities]),
        }),
    environments: Object.freeze([...config.environments]),
    // The company's own records. The data policy and each provider's terms leave out, before
    // routing, every provider that may not receive them (NVIDIA's trial terms: public data only).
    maxSensitivity: 'confidential',
    ...(config.maxCostMicroUsd === undefined ? {} : { maxCostMicroUsd: config.maxCostMicroUsd }),
    fallback: 'compatible',
    maxAttempts: 2,
    ...(config.maxModelCalls === undefined ? {} : { maxCalls: config.maxModelCalls }),
    backoffMs: 500,
    preferredProviders: Object.freeze([...config.preferredProviders]),
  });

export const harnessTaskPolicy = (config: HarnessTaskPolicyConfig): ModelPolicy =>
  agentPolicy(HARNESS_TASK_POLICY_REF, config);

/** A conversation agent's turn: text in, text out, as version 1 allowed. */
export const harnessConversationPolicy = (config: HarnessTaskPolicyConfig): ModelPolicy =>
  agentPolicy(HARNESS_CONVERSATION_POLICY_REF, config, {
    capabilities: ['text_generation'],
    modalities: ['text'],
  });

/**
 * The kinds of AI work a task may need (ADR-0100), beyond text. Each maps to what the AI Gateway's
 * router selects on (a capability and its modalities), so a new kind of model is one more
 * provider adapter and registry entry, never a change to agents or to the Harness.
 */
export const HARNESS_AI_KINDS = [
  'text',
  'vision',
  'audio',
  'video',
  'embedding',
  'image',
  'document',
  'voice',
] as const;
export type HarnessAIKind = (typeof HARNESS_AI_KINDS)[number];

export type HarnessAINeed =
  | {
      readonly kind: HarnessAIKind;
      readonly supported: true;
      readonly capability: AICapability;
      readonly inputModalities: readonly AIModality[];
      readonly outputModality: AIModality;
    }
  /** Nothing in the gateway can carry it yet (video): the task is refused, never approximated. */
  | { readonly kind: HarnessAIKind; readonly supported: false };

const need = (
  kind: HarnessAIKind,
  capability: AICapability,
  inputModalities: readonly AIModality[],
  outputModality: AIModality,
): HarnessAINeed =>
  Object.freeze({
    kind,
    supported: true,
    capability,
    inputModalities: Object.freeze([...inputModalities]),
    outputModality,
  });

const NEEDS: Readonly<Record<HarnessAIKind, HarnessAINeed>> = Object.freeze({
  text: need('text', 'text_generation', ['text'], 'text'),
  vision: need('vision', 'image_understanding', ['text', 'image'], 'text'),
  audio: need('audio', 'audio_understanding', ['audio'], 'text'),
  video: Object.freeze({ kind: 'video', supported: false }),
  embedding: need('embedding', 'embeddings', ['text'], 'text'),
  image: need('image', 'image_generation', ['text'], 'image'),
  document: need('document', 'text_generation', ['text', 'document'], 'text'),
  voice: need('voice', 'speech', ['text'], 'audio'),
});

/** What the AI Gateway is asked to select on, for one kind of AI work. */
export const aiNeedOf = (kind: HarnessAIKind): HarnessAINeed => NEEDS[kind];
