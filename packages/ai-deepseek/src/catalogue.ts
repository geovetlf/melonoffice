import type { AIModelDefinition, AIProviderDefinition } from '@melonoffice/domain';

/**
 * DeepSeek, through its official API only (LLM Router, ADR-0072). Its API key lives in Secret
 * Manager and is read by the adapter through a `CredentialResolver`; this definition holds only
 * the reference.
 *
 * DeepSeek processes data outside Google Cloud, so it may receive data up to `internal` only:
 * none of the `confidential` data GIA, agents, Company Brain or conversations send can reach it
 * until the owner decides otherwise. DEV only.
 *
 * Prices are `unknown` until they are confirmed against DeepSeek's official pricing page: the
 * gateway refuses a call it cannot account for (`price_unknown`), so nothing reaches DeepSeek
 * before then. Context and output limits are set at or below DeepSeek's published ones.
 */
export const DEEPSEEK_PROVIDER_ID = 'deepseek';

export const DEEPSEEK_PROVIDER: AIProviderDefinition = Object.freeze({
  id: DEEPSEEK_PROVIDER_ID,
  name: 'DeepSeek',
  status: 'active',
  access: 'official',
  capabilities: Object.freeze(['text_generation', 'structured_output', 'reasoning'] as const),
  modalities: Object.freeze(['text'] as const),
  environments: Object.freeze(['dev'] as const),
  credential: Object.freeze({ provider: 'deepseek', scopes: Object.freeze([]) }),
  maxSensitivity: 'internal',
});

export const DEEPSEEK_CHAT = 'deepseek-chat';
export const DEEPSEEK_REASONER = 'deepseek-reasoner';

/** DeepSeek's general chat model: text in, text or a JSON object out. */
export const DEEPSEEK_CHAT_MODEL: AIModelDefinition = Object.freeze({
  providerId: DEEPSEEK_PROVIDER_ID,
  modelId: DEEPSEEK_CHAT,
  // DeepSeek serves its current chat model under this name.
  version: 'current',
  displayName: 'DeepSeek Chat',
  status: 'active',
  capabilities: Object.freeze(['text_generation', 'structured_output'] as const),
  inputModalities: Object.freeze(['text'] as const),
  outputModalities: Object.freeze(['text'] as const),
  contextWindowTokens: 64_000,
  maxOutputTokens: 8_192,
  structuredOutput: true,
  toolUse: false,
  streaming: false,
  quality: 'standard',
  latency: 'standard',
  pricing: Object.freeze({ status: 'unknown' }),
  environments: Object.freeze(['dev'] as const),
  maxSensitivity: 'internal',
  priority: 20,
});

/** DeepSeek's reasoning model: text in, text out; its reasoning is never part of the answer. */
export const DEEPSEEK_REASONER_MODEL: AIModelDefinition = Object.freeze({
  providerId: DEEPSEEK_PROVIDER_ID,
  modelId: DEEPSEEK_REASONER,
  version: 'current',
  displayName: 'DeepSeek Reasoner',
  status: 'active',
  capabilities: Object.freeze(['text_generation', 'reasoning'] as const),
  inputModalities: Object.freeze(['text'] as const),
  outputModalities: Object.freeze(['text'] as const),
  contextWindowTokens: 64_000,
  maxOutputTokens: 32_768,
  structuredOutput: false,
  toolUse: false,
  streaming: false,
  quality: 'high',
  latency: 'slow',
  pricing: Object.freeze({ status: 'unknown' }),
  environments: Object.freeze(['dev'] as const),
  maxSensitivity: 'internal',
  priority: 30,
});

export const DEEPSEEK_MODELS: readonly AIModelDefinition[] = Object.freeze([
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_REASONER_MODEL,
]);
