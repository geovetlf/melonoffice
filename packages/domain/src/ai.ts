import type { PolicyId } from './ids.js';
import type { CredentialReference, DeploymentEnvironment } from './tool.js';

/**
 * What a model can do (ADR-0027). A model lists exactly the capabilities it has; nothing assumes
 * every model can do everything.
 */
export type AICapability =
  | 'text_generation'
  | 'reasoning'
  | 'structured_output'
  | 'image_generation'
  | 'image_understanding'
  | 'audio_understanding'
  | 'transcription'
  | 'speech'
  | 'embeddings';

/**
 * The kind of content a model takes or produces. `document`: a stored PDF, passed by reference
 * (ADR-0079).
 */
export type AIModality = 'text' | 'image' | 'audio' | 'document';

/**
 * How sensitive the data in a request is. Policies restrict which providers and models may see
 * each level. A classification, not a data-loss-prevention system.
 */
export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** Relative quality and latency, as the catalogue describes a model. Not measured values. */
export type AIQualityTier = 'basic' | 'standard' | 'high';
export type AILatencyTier = 'fast' | 'standard' | 'slow';

/**
 * How the router orders the models that meet every requirement of a call (LLM Router, ADR-0072).
 * Only the order: a strategy never lets a call reach a model its policy, budget, sensitivity or
 * environment rules out.
 *
 * - `balanced` (default): the cheapest model of at least `standard` quality when one fits,
 *   otherwise the cheapest that fits.
 * - `cost_optimized`: the cheapest that fits.
 * - `quality_first`: the highest quality, then the cheapest.
 * - `latency_first`: the fastest, then the cheapest.
 * - `reliability_first`: providers in good health first, then the model's priority, then cost.
 */
export type AIRoutingStrategy =
  'cost_optimized' | 'balanced' | 'quality_first' | 'latency_first' | 'reliability_first';

/** Where a provider or model is in its life. Only `active` ones are routed to. */
export type AIStatus = 'active' | 'paused' | 'disabled' | 'retired';

/**
 * A model's price, only when it comes from a trusted source in code or configuration. Otherwise
 * `unknown`: prices are never invented. Amounts are in millionths of a US dollar per million
 * tokens, so they stay integers.
 */
export type AIModelPricing =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'known';
      readonly currency: 'USD';
      readonly inputMicroUsdPerMillionTokens: number;
      readonly outputMicroUsdPerMillionTokens: number;
      /**
       * The price of input the provider served from its cache, when it has one. Absent: cached
       * input is charged as any other input, so a call is never under-charged.
       */
      readonly cachedInputMicroUsdPerMillionTokens?: number;
      /** Where the price was taken from, e.g. the provider's published price list. */
      readonly source: string;
      readonly asOf: string;
    };

/**
 * How a provider offers a model, as its official terms say (ADR-0080). Recorded, never assumed:
 * a free endpoint is not unlimited and not, by itself, allowed in production.
 *
 * - `free_endpoint`: offered at no charge, under the provider's own conditions;
 * - `free_prototyping`: at no charge for prototyping, development, testing or evaluation only;
 * - `paid`: charged by the provider, at a known price;
 * - `commercial_license`: needs a licence or subscription bought from the provider;
 * - `not_allowed`: the terms do not let MelonOffice use it;
 * - `unavailable`: the provider does not serve it now;
 * - `unknown`: not published, or not yet checked.
 */
export type AIOffering =
  | 'free_endpoint'
  | 'free_prototyping'
  | 'paid'
  | 'commercial_license'
  | 'not_allowed'
  | 'unavailable'
  | 'unknown';

/**
 * A model's terms of use, from the provider's official sources, with where and when they were
 * read. The registry enforces them: a model whose terms do not allow production cannot be
 * registered for `prod`, and a model whose provider may use what it is sent can only receive
 * `public` data.
 */
export interface AIModelTerms {
  readonly offering: AIOffering;
  /** `requires_license`: production needs a licence the organization does not have yet. */
  readonly production: 'allowed' | 'not_allowed' | 'requires_license' | 'unknown';
  /** Whether the provider may keep or use what it is sent, e.g. to improve its models. */
  readonly contentUse: 'not_used' | 'may_be_used' | 'unknown';
  /** The official page or document the terms were read from (`https://`). */
  readonly source: string;
  /** When they were read (`YYYY-MM-DD`). */
  readonly verifiedAt: string;
  /** The model's official documentation (`https://`), when it has one. */
  readonly documentationUrl?: string;
}

/**
 * An official AI provider (ADR-0027). MelonOffice talks to providers through their own official
 * API only: aggregators and intermediaries are refused by the registry. No secret is kept here,
 * only a reference to where the credential lives.
 */
export interface AIProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly status: AIStatus;
  /** Always `official`: the registry refuses anything else. */
  readonly access: 'official';
  readonly capabilities: readonly AICapability[];
  readonly modalities: readonly AIModality[];
  /** Where the provider processes data, when it says. */
  readonly regions?: readonly string[];
  readonly environments: readonly DeploymentEnvironment[];
  readonly credential: CredentialReference;
  /** The highest data sensitivity this provider may receive. */
  readonly maxSensitivity: DataSensitivity;
}

/** One model of a provider, at one exact version. A changed model is a new version. */
export interface AIModelDefinition {
  readonly providerId: string;
  readonly modelId: string;
  readonly version: string;
  /** How people see it, e.g. in a future control center. Never used to route. */
  readonly displayName?: string;
  readonly status: AIStatus;
  readonly capabilities: readonly AICapability[];
  readonly inputModalities: readonly AIModality[];
  readonly outputModalities: readonly AIModality[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly structuredOutput: boolean;
  readonly toolUse: boolean;
  readonly streaming: boolean;
  readonly quality: AIQualityTier;
  readonly latency: AILatencyTier;
  readonly pricing: AIModelPricing;
  readonly environments: readonly DeploymentEnvironment[];
  /** The highest data sensitivity this model may receive; never above its provider's. */
  readonly maxSensitivity: DataSensitivity;
  /** Lower first among otherwise equal models, and first under `reliability_first`. */
  readonly priority?: number;
  /** Its terms of use, when recorded (ADR-0080). Absent: none recorded. */
  readonly terms?: AIModelTerms;
}

/**
 * Which providers and models an organization's AI calls may use, and within which limits
 * (ADR-0027). Configuration, versioned: a specialist names one through `policies.model`.
 */
export interface ModelPolicy {
  readonly id: PolicyId;
  readonly version: number;
  /** Absent: any provider in the registry. Present: only these. */
  readonly allowedProviders?: readonly string[];
  /** Absent: any model of an allowed provider. Present: only these (`provider/model`). */
  readonly allowedModels?: readonly string[];
  readonly allowedCapabilities?: readonly AICapability[];
  readonly allowedModalities?: readonly AIModality[];
  readonly environments: readonly DeploymentEnvironment[];
  /** The highest sensitivity this policy lets any call carry. */
  readonly maxSensitivity: DataSensitivity;
  /** The most one call may cost, in millionths of a US dollar. A model with no known price is then excluded. */
  readonly maxCostMicroUsd?: number;
  readonly maxLatency?: AILatencyTier;
  /** Try other compatible models when the chosen one is unavailable. */
  readonly fallback: 'none' | 'compatible';
  /** Attempts per model for transient errors (1 = no retry). */
  readonly maxAttempts: number;
  readonly backoffMs: number;
  /** Models to prefer, in order (`provider/model`). Otherwise the router's fixed order applies. */
  readonly preferred?: readonly string[];
  /** How the router orders the models that fit (ADR-0072). Absent: `balanced`. */
  readonly strategy?: AIRoutingStrategy;
}
