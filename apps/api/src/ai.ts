import {
  ASSIST_MODEL_POLICIES,
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
  modelKey,
  type CreditRate,
  type ModelPolicyCatalogue,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import {
  createVertexAIAdapter,
  GEMINI_2_5_FLASH_LITE,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
  VERTEX_AI_PROVIDER_ID,
} from '@melonoffice/ai-vertex';
import type { DeploymentEnvironment, ModelPolicy, PolicyId } from '@melonoffice/domain';

/**
 * The model policy of assisted AI on conversations (CV-5, ADR-0038). A conversation is the
 * customer's words and details, `confidential`: this policy lets exactly that data reach exactly
 * one model, Gemini 2.5 Flash-Lite on Vertex AI (D-7), for text only, in DEV only. It is the
 * explicit decision; the default policy still stops at `internal`, and no other provider or model
 * is allowed by it, now or when one is added to the registry.
 *
 * No fallback: if the model cannot answer, the call fails rather than going anywhere else. One
 * retry on a transient error. At most US$0.01 per call, which is 1 credit (D-12).
 */
export const CONVERSATION_ASSIST_POLICY: ModelPolicy = Object.freeze({
  id: ASSIST_MODEL_POLICIES.conversation.id as PolicyId,
  version: ASSIST_MODEL_POLICIES.conversation.version,
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

/**
 * The model policy of Company Brain extraction (ADR-0051): what a person tells GIA about their
 * business, or a document they give, is the business's own knowledge (`confidential`). Same
 * model, environment, cost ceiling and no fallback as the conversation policy; its own name, so
 * allowing this data is its own decision.
 */
export const COMPANY_KNOWLEDGE_ASSIST_POLICY: ModelPolicy = Object.freeze({
  ...CONVERSATION_ASSIST_POLICY,
  id: ASSIST_MODEL_POLICIES.company_knowledge.id as PolicyId,
  version: ASSIST_MODEL_POLICIES.company_knowledge.version,
});

/**
 * The model policy of GIA's chat (ADR-0052): a person's question and the company context GIA
 * reads for them are the business's own knowledge (`confidential`). Same model, environment,
 * cost ceiling (1 credit per message, Geovet's decision) and no fallback; its own name.
 */
export const GIA_ASSIST_POLICY: ModelPolicy = Object.freeze({
  ...CONVERSATION_ASSIST_POLICY,
  id: ASSIST_MODEL_POLICIES.gia.id as PolicyId,
  version: ASSIST_MODEL_POLICIES.gia.version,
});

/** What the AI Gateway is built with on this server; see `AppOptions['ai']`. */
export interface AIConfiguration {
  readonly environment?: DeploymentEnvironment;
  readonly registry?: ProviderRegistry;
  readonly policies?: ModelPolicyCatalogue;
  readonly creditRate?: CreditRate;
}

/**
 * The AI Gateway's configuration from the service's settings (ADR-0038). Vertex AI is registered
 * only when its project and location and the environment are all set; otherwise nothing is, and
 * every AI call is denied (fails closed). Where the provider or the policy do not allow the
 * environment (anywhere but DEV today), calls are denied too.
 */
export function aiConfigurationOf(config: {
  readonly deploymentEnvironment?: DeploymentEnvironment;
  readonly vertexAI?: { readonly projectId: string; readonly location: string };
  readonly fetch?: typeof fetch;
}): AIConfiguration {
  const { deploymentEnvironment: environment, vertexAI } = config;
  if (environment === undefined) return {};
  if (vertexAI === undefined) return { environment };
  return {
    environment,
    registry: createProviderRegistry({
      providers: [VERTEX_AI_PROVIDER],
      models: VERTEX_AI_MODELS,
      adapters: [
        createVertexAIAdapter({
          projectId: vertexAI.projectId,
          location: vertexAI.location,
          ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        }),
      ],
    }),
    policies: createModelPolicyCatalogue([
      CONVERSATION_ASSIST_POLICY,
      COMPANY_KNOWLEDGE_ASSIST_POLICY,
      GIA_ASSIST_POLICY,
    ]),
    creditRate: CREDIT_RATE,
  };
}
