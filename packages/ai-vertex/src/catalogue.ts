import type { AIModelDefinition, AIProviderDefinition } from '@melonoffice/domain';

/**
 * Google Cloud Vertex AI, MelonOffice's first AI provider (D-7, approved 2026-09-27; ADR-0038).
 * Its official API only, called with the service's own identity: the credential is a reference
 * to that identity's OAuth scope, never a key.
 *
 * It may receive data up to `confidential`, but that is only a ceiling: each model says its own
 * limit, and a call reaches a model only when a policy names that model and allows the data.
 * Nothing here allows any other provider or model. DEV only until another environment is
 * approved.
 */
export const VERTEX_AI_PROVIDER_ID = 'google-vertex-ai';

export const VERTEX_AI_PROVIDER: AIProviderDefinition = Object.freeze({
  id: VERTEX_AI_PROVIDER_ID,
  name: 'Google Cloud Vertex AI',
  status: 'active',
  access: 'official',
  capabilities: Object.freeze(['text_generation', 'structured_output'] as const),
  modalities: Object.freeze(['text'] as const),
  environments: Object.freeze(['dev'] as const),
  credential: Object.freeze({
    provider: 'google_cloud',
    scopes: Object.freeze(['https://www.googleapis.com/auth/cloud-platform']),
  }),
  maxSensitivity: 'confidential',
});

export const GEMINI_2_5_FLASH_LITE = 'gemini-2.5-flash-lite';

/**
 * Gemini 2.5 Flash-Lite on Vertex AI (D-7), text in and text or JSON out. The price is Google's
 * published standard price for text: US$0.10 per million input tokens and US$0.40 per million
 * output tokens, reasoning included. A price change is a change here, with its date.
 */
export const GEMINI_2_5_FLASH_LITE_MODEL: AIModelDefinition = Object.freeze({
  providerId: VERTEX_AI_PROVIDER_ID,
  modelId: GEMINI_2_5_FLASH_LITE,
  // The stable model Vertex AI serves under this id.
  version: 'stable',
  status: 'active',
  capabilities: Object.freeze(['text_generation', 'structured_output'] as const),
  inputModalities: Object.freeze(['text'] as const),
  outputModalities: Object.freeze(['text'] as const),
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 65_536,
  structuredOutput: true,
  // Function calling (R3, ADR-0076): the model proposes calls, the Tool Gate runs them.
  toolUse: true,
  streaming: false,
  quality: 'basic',
  latency: 'fast',
  pricing: Object.freeze({
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 100_000,
    outputMicroUsdPerMillionTokens: 400_000,
    source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    asOf: '2026-09-27',
  }),
  environments: Object.freeze(['dev'] as const),
  maxSensitivity: 'confidential',
});

/** The provider and models this package serves, for the provider registry. */
export const VERTEX_AI_MODELS: readonly AIModelDefinition[] = Object.freeze([
  GEMINI_2_5_FLASH_LITE_MODEL,
]);
