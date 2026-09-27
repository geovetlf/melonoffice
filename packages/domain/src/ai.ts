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

/** The kind of content a model takes or produces. */
export type AIModality = 'text' | 'image' | 'audio';

/**
 * How sensitive the data in a request is. Policies restrict which providers and models may see
 * each level. A classification, not a data-loss-prevention system.
 */
export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** Relative quality and latency, as the catalogue describes a model. Not measured values. */
export type AIQualityTier = 'basic' | 'standard' | 'high';
export type AILatencyTier = 'fast' | 'standard' | 'slow';

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
      /** Where the price was taken from, e.g. the provider's published price list. */
      readonly source: string;
      readonly asOf: string;
    };

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
}
