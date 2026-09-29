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

/** The reference an agent's specialist names in `policies.model` for its tasks (ADR-0063). */
export const AGENT_TASK_POLICY_REF = Object.freeze({
  id: 'agent_task' as PolicyId,
  version: 1,
});

/**
 * The model policy of an agent's task (Agent Engine phase 2, ADR-0063). The same model and
 * limits as a conversation agent's turn (ADR-0043): the company's own records are at most
 * `confidential`, and only Gemini 2.5 Flash-Lite on Vertex AI (D-7) may see them, for text only,
 * in DEV only. No fallback, one retry on a transient error, and at most US$0.01 per call, which is
 * 1 credit (D-12).
 */
export const AGENT_TASK_POLICY: ModelPolicy = Object.freeze({
  ...CONVERSATION_AGENT_POLICY,
  id: AGENT_TASK_POLICY_REF.id,
  version: AGENT_TASK_POLICY_REF.version,
});

/** The reference the AI Gateway uses for assisted calls about a document (ADR-0079). */
export const DOCUMENT_READ_POLICY_REF = Object.freeze({
  id: 'document_read' as PolicyId,
  version: 1,
});

/**
 * The model policy of reading an uploaded PDF that has no text layer (Document Engine DOC-2,
 * ADR-0079). The business's documents are `confidential`, and this policy lets exactly that data
 * reach exactly one model, Gemini 2.5 Flash-Lite on Vertex AI (D-7), as text and a stored PDF, in
 * DEV only. No fallback, one retry on a transient error, and at most US$0.01 per call, which is
 * 1 credit (D-12): 100 pages (the most one call reads) estimate about 26,000 input tokens
 * (US$0.0026) and the 16,000 output tokens the document service asks for at most (US$0.0064).
 */
export const DOCUMENT_READ_POLICY: ModelPolicy = Object.freeze({
  id: DOCUMENT_READ_POLICY_REF.id,
  version: DOCUMENT_READ_POLICY_REF.version,
  allowedProviders: Object.freeze([VERTEX_AI_PROVIDER_ID]),
  allowedModels: Object.freeze([modelKey(VERTEX_AI_PROVIDER_ID, GEMINI_2_5_FLASH_LITE)]),
  allowedCapabilities: Object.freeze(['text_generation'] as const),
  allowedModalities: Object.freeze(['text', 'document'] as const),
  environments: Object.freeze(['dev'] as const),
  maxSensitivity: 'confidential',
  maxCostMicroUsd: CREDIT_RATE.microUsdPerCredit,
  fallback: 'none',
  maxAttempts: 2,
  backoffMs: 500,
});
