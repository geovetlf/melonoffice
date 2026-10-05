import {
  ASSIST_MODEL_POLICIES,
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
  dataPolicyFromEnv,
  modelKey,
  type CreditRate,
  type ModelPolicyCatalogue,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import {
  createVertexAIAdapter,
  DOCUMENT_READ_POLICY,
  GEMINI_2_5_FLASH_LITE,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
  VERTEX_AI_PROVIDER_ID,
} from '@melonoffice/ai-vertex';
import {
  createDeepSeekAdapter,
  DEEPSEEK_MODELS,
  DEEPSEEK_PROVIDER,
} from '@melonoffice/ai-deepseek';
import {
  createNvidiaAdapter,
  NVIDIA_MODELS,
  NVIDIA_PROVIDER,
  NVIDIA_TRIAL_DATA_POLICY,
} from '@melonoffice/ai-nvidia';
import type {
  AIDataPolicy,
  DeploymentEnvironment,
  ModelPolicy,
  PolicyId,
  SecretRef,
} from '@melonoffice/domain';
import { harnessDataPolicy, harnessRoute, harnessTaskPolicy } from '@melonoffice/harness';
import {
  aiProviderKeysFromSecrets,
  createSecretManagerStore,
  isAISecretRef,
  type SecretStore,
} from '@melonoffice/integrations';

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

/**
 * The model policy of the Decision Engine (ADR-0065), for the few decisions a rule cannot settle
 * (choosing among several fitting agents): the request and the candidates are the business's own
 * (`confidential`). Same model, environment, cost ceiling (1 credit) and no fallback; its own name.
 */
export const DECISION_ASSIST_POLICY: ModelPolicy = Object.freeze({
  ...CONVERSATION_ASSIST_POLICY,
  id: ASSIST_MODEL_POLICIES.decision.id as PolicyId,
  version: ASSIST_MODEL_POLICIES.decision.version,
});

/** What the AI Gateway is built with on this server; see `AppOptions['ai']`. */
export interface AIConfiguration {
  readonly environment?: DeploymentEnvironment;
  readonly registry?: ProviderRegistry;
  readonly policies?: ModelPolicyCatalogue;
  readonly creditRate?: CreditRate;
  /** Which data each provider may receive here (ADR-0100), applied before routing. */
  readonly dataPolicy?: AIDataPolicy;
}

/**
 * The AI Gateway's configuration from the service's settings (ADR-0038, ADR-0072). Each provider
 * is registered only when its own settings are set, and nothing at all without the environment
 * (fails closed): Vertex AI with its project and location; DeepSeek and NVIDIA (ADR-0080) with
 * the Secret Manager reference of their keys. Registering a provider allows nothing by itself: a call reaches it only
 * where a model policy allows it and the model's price is known. Where the provider or the policy
 * do not allow the environment (anywhere but DEV today), calls are denied too.
 */
export function aiConfigurationOf(config: {
  readonly deploymentEnvironment?: DeploymentEnvironment;
  readonly vertexAI?: { readonly projectId: string; readonly location: string };
  /** The documents bucket (ADR-0078): Vertex AI reads a scanned PDF from it (ADR-0079). */
  readonly documentsBucket?: string;
  readonly deepSeek?: { readonly keySecret: SecretRef };
  readonly nvidia?: { readonly keySecret: SecretRef };
  readonly fetch?: typeof fetch;
  /** Where AI provider keys are read; Secret Manager unless given (tests). */
  readonly secrets?: SecretStore;
  /** The process environment, for `AI_DATA_POLICY` (ADR-0100). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}): AIConfiguration {
  const { deploymentEnvironment: environment, vertexAI, deepSeek, nvidia } = config;
  if (environment === undefined) return {};
  const fetchOption = config.fetch === undefined ? {} : { fetch: config.fetch };
  const providers = [];
  const models = [];
  const adapters = [];
  if (vertexAI !== undefined) {
    providers.push(VERTEX_AI_PROVIDER);
    models.push(...VERTEX_AI_MODELS);
    adapters.push(
      createVertexAIAdapter({
        projectId: vertexAI.projectId,
        location: vertexAI.location,
        ...(config.documentsBucket === undefined
          ? {}
          : { documentsBucket: config.documentsBucket }),
        ...fetchOption,
      }),
    );
  }
  if (deepSeek !== undefined) {
    providers.push(DEEPSEEK_PROVIDER);
    models.push(...DEEPSEEK_MODELS);
    adapters.push(
      createDeepSeekAdapter({
        credentials: aiProviderKeysFromSecrets(
          config.secrets ?? createSecretManagerStore({ ...fetchOption, accepts: isAISecretRef }),
          { [DEEPSEEK_PROVIDER.credential.provider]: deepSeek.keySecret },
        ),
        ...fetchOption,
      }),
    );
  }
  if (nvidia !== undefined) {
    providers.push(NVIDIA_PROVIDER);
    models.push(...NVIDIA_MODELS);
    adapters.push(
      createNvidiaAdapter({
        credentials: aiProviderKeysFromSecrets(
          config.secrets ?? createSecretManagerStore({ ...fetchOption, accepts: isAISecretRef }),
          { [NVIDIA_PROVIDER.credential.provider]: nvidia.keySecret },
        ),
        ...fetchOption,
      }),
    );
  }
  if (providers.length === 0) return { environment };
  return {
    environment,
    // The data policy before routing (ADR-0100): NVIDIA gets public, synthetic and test data only
    // while it is on trial terms; `AI_DATA_POLICY` changes it for this environment.
    dataPolicy: dataPolicyFromEnv(
      config.env ?? {},
      environment,
      harnessDataPolicy(NVIDIA_TRIAL_DATA_POLICY),
    ),
    registry: createProviderRegistry({ providers, models, adapters }),
    policies: createModelPolicyCatalogue([
      CONVERSATION_ASSIST_POLICY,
      COMPANY_KNOWLEDGE_ASSIST_POLICY,
      GIA_ASSIST_POLICY,
      DECISION_ASSIST_POLICY,
      // Reading a scanned PDF a person uploads (ADR-0079).
      DOCUMENT_READ_POLICY,
      // The policy template agents name (`agent_task@2`), exactly as the worker routes it, so the
      // Harness's planning call resolves it here too (ADR-0170).
      harnessTaskPolicy(harnessRoute([NVIDIA_PROVIDER.id])),
    ]),
    creditRate: CREDIT_RATE,
  };
}
