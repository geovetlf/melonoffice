import type { AIModelDefinition, AIProviderDefinition } from '@melonoffice/domain';

/**
 * NVIDIA, through its official hosted API (the NVIDIA API Catalog, build.nvidia.com), as one more
 * provider behind the AI Gateway (ADR-0080). Nothing above the gateway knows it: GIA, agents,
 * workflows and Company Brain ask for a capability, and the router chooses.
 *
 * What NVIDIA's official sources say, read on 2026-09-29 (docs/providers/nvidia):
 *
 * - Members of the NVIDIA Developer Program have free access to the hosted NIM API endpoints for
 *   prototyping, research, development and testing only. Production needs an NVIDIA AI Enterprise
 *   licence or a subscription bought from NVIDIA.
 * - The hosted API is governed by the NVIDIA API Trial Terms of Service (v. September 19, 2025):
 *   internal testing and evaluation only, not production; and NVIDIA may use what it is sent to
 *   improve its products and models.
 * - NVIDIA publishes no rate limit or quota for it: those are recorded as unknown, never guessed.
 *
 * So NVIDIA is DEV only and receives `public` data only: none of the `confidential` data GIA,
 * agents, Company Brain or conversations send can reach it. The registry enforces both from the
 * recorded terms.
 */
export const NVIDIA_PROVIDER_ID = 'nvidia';

/** Where NVIDIA's free hosted access and its production condition are stated. */
export const NVIDIA_NIM_FAQ_URL = 'https://docs.api.nvidia.com/nim/docs/product';
/** The terms that govern the hosted trial API. */
export const NVIDIA_API_TRIAL_TERMS_URL =
  'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf';
/** When the sources above were read. */
export const NVIDIA_TERMS_VERIFIED_AT = '2026-09-29';

export const NVIDIA_PROVIDER: AIProviderDefinition = Object.freeze({
  id: NVIDIA_PROVIDER_ID,
  name: 'NVIDIA',
  status: 'active',
  access: 'official',
  capabilities: Object.freeze(['text_generation'] as const),
  modalities: Object.freeze(['text'] as const),
  environments: Object.freeze(['dev'] as const),
  credential: Object.freeze({ provider: 'nvidia', scopes: Object.freeze([]) }),
  maxSensitivity: 'public',
});

/**
 * The model's id in MelonOffice's registry. NVIDIA names models `{publisher}/{model}`; a registry
 * id has no `/` (it is the separator of `provider/model`), so the adapter maps each id to NVIDIA's
 * name in `NVIDIA_API_MODEL_NAMES`, and a model missing there is never sent.
 */
export const NEMOTRON_3_NANO = 'nemotron-3-nano-30b-a3b';

/** Each registered model's name in NVIDIA's API. A closed list. */
export const NVIDIA_API_MODEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [NEMOTRON_3_NANO]: 'nvidia/nemotron-3-nano-30b-a3b',
});

/**
 * NVIDIA Nemotron 3 Nano 30B A3B: text in, text or calls to tools out. Its model card
 * (docs.api.nvidia.com) publishes a 128K-token context and output, tool calling, and six languages
 * including Spanish and English. MelonOffice caps the answer well below that. Its reasoning trace
 * is switched off for plain answers and never passed on.
 *
 * Structured output on the hosted endpoint is not documented (NVIDIA documents it for self-hosted
 * NIM), so it is not claimed. Quality and latency are the catalogue's neutral tiers, not measured.
 *
 * Price: no charge in US dollars under the Developer Program's free prototyping access, which
 * spends NVIDIA's own trial credits. That is the provider's cost only; what a customer is charged
 * stays MelonOffice's credit rule (D-12), unchanged.
 */
export const NEMOTRON_3_NANO_MODEL: AIModelDefinition = Object.freeze({
  providerId: NVIDIA_PROVIDER_ID,
  modelId: NEMOTRON_3_NANO,
  version: 'hosted-2025-12-15',
  displayName: 'NVIDIA Nemotron 3 Nano 30B A3B',
  status: 'active',
  capabilities: Object.freeze(['text_generation'] as const),
  inputModalities: Object.freeze(['text'] as const),
  outputModalities: Object.freeze(['text'] as const),
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_384,
  structuredOutput: false,
  toolUse: true,
  streaming: true,
  quality: 'standard',
  latency: 'standard',
  pricing: Object.freeze({
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 0,
    outputMicroUsdPerMillionTokens: 0,
    source: NVIDIA_NIM_FAQ_URL,
    asOf: NVIDIA_TERMS_VERIFIED_AT,
  }),
  environments: Object.freeze(['dev'] as const),
  maxSensitivity: 'public',
  priority: 40,
  terms: Object.freeze({
    offering: 'free_prototyping',
    production: 'requires_license',
    contentUse: 'may_be_used',
    source: NVIDIA_API_TRIAL_TERMS_URL,
    verifiedAt: NVIDIA_TERMS_VERIFIED_AT,
    documentationUrl: 'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b',
  }),
});

export const NVIDIA_MODELS: readonly AIModelDefinition[] = Object.freeze([NEMOTRON_3_NANO_MODEL]);

/**
 * Models whose chat template takes `enable_thinking` (their model card says so): switched off for
 * a plain answer, so no reasoning trace is generated, paid for or risked in the answer.
 */
export const THINKING_SWITCH_MODELS: ReadonlySet<string> = new Set([NEMOTRON_3_NANO]);
