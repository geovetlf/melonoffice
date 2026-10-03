import type { AIRoutingStrategy } from '@melonoffice/domain';
import type { AIOutput, FinishReason, ProviderOutcome, ProviderUsage } from './adapter.js';
import type { AICreditState } from './credits.js';
import { carriesLabelledSecret, looksLikeSecretText } from './secrets.js';
import { checkToolCalls, type AIToolDefinition } from './tools.js';

/** Which versions answered, for reproducibility: adapter, exact model, and policy. */
export interface AIVersions {
  readonly adapter: string;
  readonly model: string;
  readonly policy: { readonly id: string; readonly version: number };
}

/**
 * The answer to an AI call (ADR-0027). Always one of these, never an ambiguous exception, and
 * never a secret. `denied` means nothing was sent to any provider.
 */
export type AIResponse =
  | {
      readonly status: 'completed';
      readonly requestId: string;
      readonly provider: string;
      readonly model: string;
      readonly versions: AIVersions;
      readonly output: AIOutput;
      readonly usage: ProviderUsage;
      readonly latencyMs: number;
      readonly finishReason: FinishReason;
      readonly cost: {
        readonly estimatedMicroUsd: number | null;
        readonly actualMicroUsd: number | null;
      };
      readonly credits: {
        readonly state: AICreditState;
        readonly estimated: number | null;
        readonly consumed: number;
      };
      readonly providerRequestId: string | null;
      readonly attempts: number;
      /** Set when another model answered than the one first chosen. */
      readonly fallbackFrom: string | null;
      /**
       * How the router ordered the models (ADR-0072). The gateway always sets it; optional so
       * answers built before it existed stay valid.
       */
      readonly strategy?: AIRoutingStrategy;
    }
  | {
      readonly status: 'failed';
      readonly requestId: string;
      readonly code: string;
      readonly provider: string | null;
      readonly model: string | null;
      readonly attempts: number;
      readonly latencyMs: number;
    }
  | {
      readonly status: 'denied';
      readonly requestId: string;
      readonly code: string;
      /**
       * For a refusal for credits (`credits_insufficient`, `credit_limit_exceeded`): about how
       * many credits the cheapest model that could serve the request would have cost (D-12).
       */
      readonly estimatedCredits?: number;
    };

const PROVIDER_REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const FINISH: readonly FinishReason[] = ['stop', 'length', 'content_filter', 'tool_use'];

const count = (v: unknown): boolean =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000;

/** Every string in a structured output, at any depth. */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 8 || typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap((v) => stringsOf(v, depth + 1));
}

/**
 * Checks what an adapter returned before anything else sees it: known fields and types,
 * sane usage, and no text that looks like a credential. A provider's answer that fails is an
 * `invalid_response`, never passed on.
 */
export function checkProviderSuccess(
  outcome: Extract<ProviderOutcome, { status: 'success' }>,
  tools?: readonly AIToolDefinition[],
): boolean {
  const { output, usage, finishReason, providerRequestId } = outcome;
  if (typeof output !== 'object' || output === null) return false;
  if (Object.keys(output).some((k) => !['text', 'structured', 'toolCalls'].includes(k))) {
    return false;
  }
  if (
    output.text === undefined &&
    output.structured === undefined &&
    output.toolCalls === undefined
  ) {
    return false;
  }
  // Tool calls only to the tools this request offered, with arguments their schema accepts, and
  // `tool_use` only with calls (R3, ADR-0076).
  if (output.toolCalls !== undefined && !checkToolCalls(output.toolCalls, tools)) return false;
  if ((finishReason === 'tool_use') !== (output.toolCalls !== undefined)) return false;
  if (output.text !== undefined && typeof output.text !== 'string') return false;
  if (output.text !== undefined && looksLikeSecretText(output.text)) return false;
  // A credential under its name, such as a password copied from the data (G-7).
  if (output.text !== undefined && carriesLabelledSecret(output.text)) return false;
  if (output.structured !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(output.structured);
    } catch {
      return false;
    }
    if (json === undefined || looksLikeSecretText(json.replace(/[{}[\]",:]/g, ' '))) return false;
    if (stringsOf(output.structured).some(carriesLabelledSecret)) return false;
  }
  if (typeof usage !== 'object' || usage === null) return false;
  if (!count(usage.inputTokens) || !count(usage.outputTokens)) return false;
  if (
    usage.cachedInputTokens !== undefined &&
    (!count(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens)
  ) {
    return false;
  }
  if (!FINISH.includes(finishReason)) return false;
  if (providerRequestId !== undefined && !PROVIDER_REQUEST_ID.test(providerRequestId)) return false;
  return true;
}
