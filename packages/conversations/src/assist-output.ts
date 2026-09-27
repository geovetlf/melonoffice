import type { DepartmentId } from '@melonoffice/domain';
import type { AssistOperation } from './assist-context.js';
import { MAX_TEXT_LENGTH } from './model.js';

/**
 * What a customer may want, as a closed, small taxonomy (ADR-0037). Extended here, as data; a
 * code a model invents is read as `other`, never passed on.
 */
export const CONVERSATION_INTENTS = [
  'sales_inquiry',
  'purchase_intent',
  'support_request',
  'complaint',
  'billing_question',
  'reservation_request',
  'product_question',
  'delivery_question',
  'human_request',
  'other',
] as const;
export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number];

export interface SummaryResult {
  readonly type: 'summary';
  readonly summary: string;
  readonly intent: ConversationIntent;
  readonly customerNeed: string | null;
  readonly keyPoints: readonly string[];
  readonly providedData: readonly { readonly label: string; readonly value: string }[];
  readonly actionsTaken: readonly string[];
  readonly pendingInformation: readonly string[];
  readonly nextSteps: readonly string[];
}

export interface IntentResult {
  readonly type: 'intent';
  readonly primary: ConversationIntent;
  readonly secondary: readonly ConversationIntent[];
  /** A signal only, when the model gave a sensible one; never a decision. */
  readonly confidence: number | null;
  readonly missingInformation: readonly string[];
  /** Whether a person should take over. Detected, never acted on: nothing is transferred. */
  readonly requiresHuman: boolean;
  readonly requiresHumanReason: string | null;
}

export interface ReplyResult {
  readonly type: 'reply';
  /** A draft for a person to review, edit and send through CV-2 themselves. Never sent here. */
  readonly reply: string;
  readonly explanation: string | null;
  readonly warnings: readonly string[];
}

export interface NextStepsResult {
  readonly type: 'next_steps';
  readonly nextSteps: readonly string[];
  readonly missingInformation: readonly string[];
  /** One of the organization's active departments, or null. A suggestion: nothing is assigned. */
  readonly departmentId: DepartmentId | null;
  readonly requiresHuman: boolean;
}

export type AssistResult = SummaryResult | IntentResult | ReplyResult | NextStepsResult;

class Invalid extends Error {}
const invalid = (): never => {
  throw new Invalid('invalid');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Control characters other than line breaks and tabs are never shown.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return invalid();
  const trimmed = value.trim();
  if (trimmed.length === 0 || [...trimmed].length > max || CONTROL.test(trimmed)) invalid();
  return trimmed;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return text(value, max);
}

function texts(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return invalid();
  return value.map((item) => text(item, maxLength));
}

function flag(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') return invalid();
  return value;
}

const intentOf = (value: unknown): ConversationIntent => {
  if (typeof value !== 'string') return invalid();
  return (CONVERSATION_INTENTS as readonly string[]).includes(value)
    ? (value as ConversationIntent)
    : 'other';
};

/** The model's answer as an object: structured output, or JSON text, possibly fenced. */
function objectOf(output: { readonly text?: string; readonly structured?: unknown }): unknown {
  if (output.structured !== undefined) return output.structured;
  if (output.text === undefined) return invalid();
  const raw = output.text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalid();
  }
}

/**
 * Reads a model's answer into the operation's result, or nothing when it does not fit. Every
 * field is checked and bounded; keys the shape does not name are dropped, never shown. The text
 * is only ever displayed as text: nothing in it is run, followed or stored as a message.
 */
export function parseAssistOutput(
  operation: AssistOperation,
  output: { readonly text?: string; readonly structured?: unknown },
  departmentOfAlias: ReadonlyMap<string, DepartmentId>,
): AssistResult | undefined {
  try {
    const o = objectOf(output);
    if (!isRecord(o)) return invalid();
    switch (operation) {
      case 'summary': {
        const provided = o.providedData ?? [];
        if (!Array.isArray(provided) || provided.length > 20) return invalid();
        return {
          type: 'summary',
          summary: text(o.summary, 2_000),
          intent: intentOf(o.intent),
          customerNeed: optionalText(o.customerNeed, 500),
          keyPoints: texts(o.keyPoints, 10, 300),
          providedData: provided.map((item) => {
            if (!isRecord(item)) return invalid();
            return { label: text(item.label, 60), value: text(item.value, 300) };
          }),
          actionsTaken: texts(o.actionsTaken, 10, 300),
          pendingInformation: texts(o.pendingInformation, 10, 300),
          nextSteps: texts(o.nextSteps, 10, 300),
        };
      }
      case 'intent': {
        const secondary = o.secondary ?? [];
        if (!Array.isArray(secondary) || secondary.length > 5) return invalid();
        const primary = intentOf(o.primary);
        const confidence =
          typeof o.confidence === 'number' &&
          Number.isFinite(o.confidence) &&
          o.confidence >= 0 &&
          o.confidence <= 1
            ? o.confidence
            : null;
        return {
          type: 'intent',
          primary,
          secondary: [
            ...new Set(secondary.map(intentOf).filter((i) => i !== 'other' && i !== primary)),
          ],
          confidence,
          missingInformation: texts(o.missingInformation, 10, 300),
          requiresHuman: flag(o.requiresHuman),
          requiresHumanReason: optionalText(o.requiresHumanReason, 300),
        };
      }
      case 'reply':
        return {
          type: 'reply',
          reply: text(o.reply, MAX_TEXT_LENGTH),
          explanation: optionalText(o.explanation, 500),
          warnings: texts(o.warnings, 5, 300),
        };
      case 'next_steps': {
        const steps = texts(o.nextSteps, 10, 300);
        if (steps.length === 0) return invalid();
        const alias = o.department;
        if (alias !== undefined && alias !== null && typeof alias !== 'string') return invalid();
        return {
          type: 'next_steps',
          nextSteps: steps,
          missingInformation: texts(o.missingInformation, 10, 300),
          // An alias that names none of the organization's departments is no suggestion at all.
          departmentId: typeof alias === 'string' ? (departmentOfAlias.get(alias) ?? null) : null,
          requiresHuman: flag(o.requiresHuman),
        };
      }
    }
  } catch (error) {
    if (error instanceof Invalid) return undefined;
    throw error;
  }
}
