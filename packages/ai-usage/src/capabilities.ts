import type { AIUsageCapability } from '@melonoffice/domain';

/**
 * The AI capabilities named so far (ADR-0073). A list, not a closed type: adding one is adding an
 * id here, with its providers, models and prices, and whatever engine serves it emits the same
 * `AIUsageEvent`. Only `llm` has an engine today (the LLM Router, ADR-0072).
 */
export const AI_USAGE_CAPABILITIES = Object.freeze([
  'llm',
  'image_generation',
  'image_editing',
  'video_generation',
  'video_transformation',
  'video_editing',
  'audio_generation',
  'music_generation',
  'speech_to_text',
  'text_to_speech',
  'voice_cloning',
  'voice_transformation',
  'document_ai',
  'document_generation',
  'ocr',
  'vision',
  'embeddings',
  'reranking',
  'search',
  'web_search',
  'browser_automation',
  'agent_execution',
  'reasoning',
  'classification',
  'extraction',
  'translation',
  'moderation',
  'avatars',
  'digital_humans',
  'three_d',
  'presentations',
  'code_generation',
  'computer_use',
] as const satisfies readonly AIUsageCapability[]);

const CAPABILITY = /^[a-z][a-z0-9_]{1,63}$/;
const UNIT = /^[a-z][a-z0-9_]{0,63}$/;
const DIMENSION = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Well-formed ids only: a capability, unit or dimension is a code, never free text. */
export const isCapabilityId = (value: unknown): value is AIUsageCapability =>
  typeof value === 'string' && CAPABILITY.test(value);
export const isUnit = (value: unknown): value is string =>
  typeof value === 'string' && UNIT.test(value);
export const isUsageCode = (value: unknown): value is string =>
  typeof value === 'string' && CODE.test(value);
export const isDimension = (value: unknown): value is string =>
  typeof value === 'string' && DIMENSION.test(value);
