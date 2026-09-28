import { CREDIT_RATE, modelKey } from '@melonoffice/ai-gateway';
import type { ModelPolicy, PolicyId } from '@melonoffice/domain';
import { GEMINI_2_5_FLASH_LITE, VERTEX_AI_PROVIDER_ID } from './catalogue.js';

/** The reference a conversation agent's specialist names in `policies.model` (ADR-0043). */
export const CONVERSATION_AGENT_POLICY_REF = Object.freeze({
  id: 'conversation_agent' as PolicyId,
  version: 1,
});

/**
 * The model policy of a conversation agent's turn (CV-6B, ADR-0043). The same decision as
 * assisted AI on conversations (ADR-0038), for the runtime's calls: the customer's words are
 * `confidential`, and this policy lets exactly that data reach exactly one model, Gemini 2.5
 * Flash-Lite on Vertex AI (D-7), for text only, in DEV only. No fallback, one retry on a transient
 * error, and at most US$0.01 per call, which is 1 credit (D-12).
 */
export const CONVERSATION_AGENT_POLICY: ModelPolicy = Object.freeze({
  id: CONVERSATION_AGENT_POLICY_REF.id,
  version: CONVERSATION_AGENT_POLICY_REF.version,
  allowedProviders: Object.freeze([VERTEX_AI_PROVIDER_ID]),
  allowedModels: Object.freeze([modelKey(VERTEX_AI_PROVIDER_ID, GEMINI_2_5_FLASH_LITE)]),
  allowedCapabilities: Object.freeze(['text_generation'] as const),
  allowedModalities: Object.freeze(['text'] as const),
  environments: Object.freeze(['dev'] as const),
  maxSensitivity: 'confidential',
  maxCostMicroUsd: CREDIT_RATE.microUsdPerCredit,
  fallback: 'none',
  maxAttempts: 2,
  backoffMs: 500,
});
