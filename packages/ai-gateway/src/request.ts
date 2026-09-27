import type {
  AICapability,
  AILatencyTier,
  AIModality,
  AIQualityTier,
  DataSensitivity,
} from '@melonoffice/domain';
import { isForbiddenField } from '@melonoffice/tools';
import { looksLikeSecretText } from './secrets.js';

export const AI_CAPABILITIES = [
  'text_generation',
  'reasoning',
  'structured_output',
  'image_generation',
  'image_understanding',
  'audio_understanding',
  'transcription',
  'speech',
  'embeddings',
] as const satisfies readonly AICapability[];
export const AI_MODALITIES = ['text', 'image', 'audio'] as const satisfies readonly AIModality[];
export const SENSITIVITIES = [
  'public',
  'internal',
  'confidential',
  'restricted',
] as const satisfies readonly DataSensitivity[];
export const QUALITY_TIERS = [
  'basic',
  'standard',
  'high',
] as const satisfies readonly AIQualityTier[];
export const LATENCY_TIERS = [
  'fast',
  'standard',
  'slow',
] as const satisfies readonly AILatencyTier[];

export const MAX_MESSAGES = 200;
export const MAX_TEXT_LENGTH = 400_000;
export const MAX_METADATA_ENTRIES = 20;
export const MAX_OUTPUT_TOKENS = 1_000_000;

/** A piece of a message. Media is passed by reference, never inline. */
export type AIContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image' | 'audio';
      readonly ref: { readonly type: string; readonly id: string };
    };

export interface AIMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly AIContentPart[];
}

/** What the model must support beyond its capability. */
export interface AIRequirements {
  readonly minContextTokens?: number;
  readonly structuredOutput?: boolean;
  readonly toolUse?: boolean;
  readonly streaming?: boolean;
}

/**
 * One AI call, as a specialist or a future GIA asks for it (ADR-0027). There is deliberately no
 * organization, user, credential or provider key here: the organization and user come from the
 * tenant, the specialist and department from the stored execution, and credentials from secure
 * infrastructure. Every object is closed, so nothing else can be smuggled in.
 */
export interface AIRequest {
  /** The caller's id for this call; the same id is the same call (idempotency). */
  readonly requestId: string;
  readonly executionId: string;
  readonly nodeId?: string;
  readonly specialistId: string;
  /** A stable code for what the call is for, e.g. `summarise_document`. */
  readonly taskType: string;
  readonly capability: AICapability;
  readonly requirements?: AIRequirements;
  readonly messages: readonly AIMessage[];
  readonly outputModality: AIModality;
  readonly quality?: AIQualityTier;
  readonly latency?: AILatencyTier;
  /** The most this call may cost, in millionths of a US dollar. */
  readonly maxCostMicroUsd?: number;
  /** The most credits this call may spend. */
  readonly maxCredits?: number;
  readonly maxOutputTokens: number;
  readonly sensitivity: DataSensitivity;
  /** Safe, flat labels for tracing. Never authority, never a secret. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What a model call asks for, whoever makes it: everything in `AIRequest` but who it is for.
 * Routing, cost and credits read only this.
 */
export type AIModelRequest = Omit<AIRequest, 'executionId' | 'nodeId' | 'specialistId'>;

/**
 * What a person may ask the AI Gateway about directly (ADR-0037). Each type names the record the
 * assistance is about, and the gateway knows which permission it needs.
 */
export const ASSIST_SUBJECT_TYPES = ['conversation'] as const;
export type AssistSubjectType = (typeof ASSIST_SUBJECT_TYPES)[number];

/**
 * An assisted call (ADR-0037): a person asks, for themselves, about one record they can read. It
 * is an `AIRequest` without an execution or a specialist, since none is involved: the subject says
 * what the call is about. The organization and user still come from the tenant, never from here.
 */
export interface AssistedAIRequest extends AIModelRequest {
  readonly subject: { readonly type: AssistSubjectType; readonly id: string };
}

/**
 * Why a request is refused before anything else happens. `authority_in_input` and
 * `secret_in_input` are security refusals.
 */
export type AIRequestProblem = 'invalid_request' | 'authority_in_input' | 'secret_in_input';

const REQUEST_ID = /^[\w-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z_]{0,63}$/;
const KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const REF_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const REF_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const REQUEST_KEYS = new Set([
  'requestId',
  'executionId',
  'nodeId',
  'specialistId',
  'taskType',
  'capability',
  'requirements',
  'messages',
  'outputModality',
  'quality',
  'latency',
  'maxCostMicroUsd',
  'maxCredits',
  'maxOutputTokens',
  'sensitivity',
  'metadata',
]);
const ASSISTED_REQUEST_KEYS = new Set([
  ...[...REQUEST_KEYS].filter((k) => !['executionId', 'nodeId', 'specialistId'].includes(k)),
  'subject',
]);
const REQUIREMENT_KEYS = new Set(['minContextTokens', 'structuredOutput', 'toolUse', 'streaming']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const oneOf = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value);

const count = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

class Refusal {
  constructor(readonly problem: AIRequestProblem) {}
}
const refuse = (problem: AIRequestProblem): never => {
  throw new Refusal(problem);
};

/** Keys: a forbidden name is authority smuggling; anything else unknown is just invalid. */
function closed(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(isForbiddenField(key) ? 'authority_in_input' : 'invalid_request');
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || [...value].length > max) return refuse('invalid_request');
  // A prompt that carries a credential is refused: models never receive secrets.
  if (looksLikeSecretText(value)) refuse('secret_in_input');
  return value;
}

function checkMessage(value: unknown): void {
  if (!isRecord(value)) return refuse('invalid_request');
  closed(value, new Set(['role', 'content']));
  if (!oneOf(['system', 'user', 'assistant'], value.role)) refuse('invalid_request');
  const { content } = value;
  if (!Array.isArray(content) || content.length === 0 || content.length > 50) {
    return refuse('invalid_request');
  }
  for (const part of content) {
    if (!isRecord(part)) return refuse('invalid_request');
    if (part.type === 'text') {
      closed(part, new Set(['type', 'text']));
      text(part.text, MAX_TEXT_LENGTH);
    } else if (part.type === 'image' || part.type === 'audio') {
      closed(part, new Set(['type', 'ref']));
      const { ref } = part;
      if (!isRecord(ref)) return refuse('invalid_request');
      closed(ref, new Set(['type', 'id']));
      if (typeof ref.type !== 'string' || !REF_TYPE.test(ref.type)) refuse('invalid_request');
      if (typeof ref.id !== 'string' || !REF_ID.test(ref.id)) refuse('invalid_request');
    } else {
      refuse('invalid_request');
    }
  }
}

function checkMetadata(value: unknown): void {
  if (!isRecord(value)) return refuse('invalid_request');
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) refuse('invalid_request');
  for (const [key, item] of entries) {
    if (isForbiddenField(key)) refuse('authority_in_input');
    if (!KEY.test(key)) refuse('invalid_request');
    if (typeof item === 'string') text(item, 200);
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) refuse('invalid_request');
    } else if (typeof item !== 'boolean') refuse('invalid_request');
  }
}

/** The fields every model call shares, whoever asks: everything but who the call is for. */
function checkCommon(request: Record<string, unknown>): void {
  if (request.metadata !== undefined) checkMetadata(request.metadata);
  const { messages } = request;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return refuse('invalid_request');
  }
  for (const message of messages) checkMessage(message);
  if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) {
    refuse('invalid_request');
  }
  if (typeof request.taskType !== 'string' || !CODE.test(request.taskType)) {
    refuse('invalid_request');
  }
  if (!oneOf(AI_CAPABILITIES, request.capability)) refuse('invalid_request');
  if (!oneOf(AI_MODALITIES, request.outputModality)) refuse('invalid_request');
  if (!oneOf(SENSITIVITIES, request.sensitivity)) refuse('invalid_request');
  if (request.quality !== undefined && !oneOf(QUALITY_TIERS, request.quality)) {
    refuse('invalid_request');
  }
  if (request.latency !== undefined && !oneOf(LATENCY_TIERS, request.latency)) {
    refuse('invalid_request');
  }
  if (!count(request.maxOutputTokens, 1, MAX_OUTPUT_TOKENS)) refuse('invalid_request');
  for (const limit of [request.maxCostMicroUsd, request.maxCredits]) {
    if (limit !== undefined && !count(limit, 0, Number.MAX_SAFE_INTEGER)) {
      refuse('invalid_request');
    }
  }
  const { requirements } = request;
  if (requirements !== undefined) {
    if (!isRecord(requirements)) return refuse('invalid_request');
    closed(requirements, REQUIREMENT_KEYS);
    if (
      requirements.minContextTokens !== undefined &&
      !count(requirements.minContextTokens, 1, 100_000_000)
    ) {
      refuse('invalid_request');
    }
    for (const flag of ['structuredOutput', 'toolUse', 'streaming'] as const) {
      const v = requirements[flag];
      if (v !== undefined && typeof v !== 'boolean') refuse('invalid_request');
    }
  }
}

function problemOf(check: () => void): AIRequestProblem | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.problem;
    throw error;
  }
}

/**
 * Checks a request and returns why it is refused, or nothing. Refusals come in a fixed order:
 * authority or secrets anywhere win over a merely malformed field, so the audit says why.
 */
export function checkAIRequest(request: unknown): AIRequestProblem | undefined {
  return problemOf(() => {
    if (!isRecord(request)) return refuse('invalid_request');
    closed(request, REQUEST_KEYS);
    checkCommon(request);
    if (typeof request.executionId !== 'string' || !UUID.test(request.executionId)) {
      refuse('invalid_request');
    }
    if (typeof request.specialistId !== 'string' || !UUID.test(request.specialistId)) {
      refuse('invalid_request');
    }
    if (
      request.nodeId !== undefined &&
      (typeof request.nodeId !== 'string' || !NODE_ID.test(request.nodeId))
    ) {
      refuse('invalid_request');
    }
  });
}

/** Checks an assisted request (ADR-0037) the same way, with its subject instead of an execution. */
export function checkAssistedAIRequest(request: unknown): AIRequestProblem | undefined {
  return problemOf(() => {
    if (!isRecord(request)) return refuse('invalid_request');
    closed(request, ASSISTED_REQUEST_KEYS);
    checkCommon(request);
    const { subject } = request;
    if (!isRecord(subject)) return refuse('invalid_request');
    closed(subject, new Set(['type', 'id']));
    if (!oneOf(ASSIST_SUBJECT_TYPES, subject.type)) refuse('invalid_request');
    if (typeof subject.id !== 'string' || !UUID.test(subject.id)) refuse('invalid_request');
  });
}

/** The modalities a request's messages carry. */
export function inputModalitiesOf(request: Pick<AIRequest, 'messages'>): readonly AIModality[] {
  const found = new Set<AIModality>();
  for (const message of request.messages) {
    for (const part of message.content) found.add(part.type);
  }
  return AI_MODALITIES.filter((m) => found.has(m));
}

/**
 * A rough, deterministic token estimate for cost limits before a call: four characters per
 * token, rounded up, plus a fixed allowance per media part. The provider's reported usage is
 * what is charged.
 */
export function estimateInputTokens(request: Pick<AIRequest, 'messages'>): number {
  let tokens = 0;
  for (const message of request.messages) {
    for (const part of message.content) {
      tokens += part.type === 'text' ? Math.ceil([...part.text].length / 4) : 1_000;
    }
  }
  return tokens;
}
