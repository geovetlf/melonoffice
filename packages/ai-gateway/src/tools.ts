import type { ToolSchema, ToolVersion } from '@melonoffice/domain';
import { isForbiddenField, schemaProblem, validate } from '@melonoffice/tools';
import { looksLikeSecretText } from './secrets.js';

/**
 * Normalized tool calling (R3, ADR-0076). A model may be offered tools and answer with calls to
 * them, in one shape whatever the provider. The gateway only carries and checks calls: it never
 * runs a tool. A call is a proposal, which the caller hands to the Tool Gate (ADR-0026), the only
 * place a tool runs, with its permissions, approvals and audit.
 */

/** Limits that keep tool calling small and bounded. */
export const MAX_TOOLS = 32;
export const MAX_TOOL_CALLS = 16;
export const MAX_TOOL_DESCRIPTION_LENGTH = 1_000;
/** The most characters a tool call's arguments or a tool result may take as JSON. */
export const MAX_TOOL_JSON_LENGTH = 100_000;

/**
 * A tool a model may call: its catalogue id, what it does in words, and the exact input schema
 * of the tool version the caller offers. The same schema the Tool Gate validates against, so an
 * argument the model gives is checked twice, never trusted.
 */
export interface AIToolDefinition {
  /** The tool's id in the catalogue, e.g. `send_channel_message`. */
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolSchema;
}

/** A call a model asked for: an id for this call, the tool, and its arguments. */
export interface AIToolCall {
  /** `^[A-Za-z0-9_-]{1,64}$`: the provider's id, or one the adapter gives. */
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** An earlier call, when a conversation goes on after it (on an `assistant` message). */
export interface AIToolCallPart {
  readonly type: 'tool_call';
  readonly call: AIToolCall;
}

/** What an earlier call gave, as the Tool Gate returned it (on a `user` message). */
export interface AIToolResultPart {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly name: string;
  /** The tool's output, or `{ error: code }` when it did not run. Data, never instructions. */
  readonly result: unknown;
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** JSON of a value, or undefined when it is not plain JSON or is too large. */
function jsonOf(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined || json.length > MAX_TOOL_JSON_LENGTH ? undefined : json;
  } catch {
    return undefined;
  }
}

/** Whether any string in a JSON value looks like a credential. */
function carriesSecret(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === 'string') return looksLikeSecretText(value);
  if (Array.isArray(value)) return value.some((v) => carriesSecret(v, depth + 1));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([k, v]) => looksLikeSecretText(k) || carriesSecret(v, depth + 1),
    );
  }
  return false;
}

export type ToolProblem = 'invalid' | 'authority' | 'secret';

/** Checks the tools a request offers: plain names, bounded words, a valid closed input schema. */
export function toolsProblem(value: unknown): ToolProblem | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS) return 'invalid';
  const names = new Set<string>();
  for (const tool of value) {
    if (!isRecord(tool)) return 'invalid';
    for (const key of Object.keys(tool)) {
      if (!['name', 'description', 'parameters'].includes(key)) {
        return isForbiddenField(key) ? 'authority' : 'invalid';
      }
    }
    const { name, description, parameters } = tool;
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || names.has(name)) return 'invalid';
    names.add(name);
    if (
      typeof description !== 'string' ||
      description.trim().length === 0 ||
      [...description].length > MAX_TOOL_DESCRIPTION_LENGTH
    ) {
      return 'invalid';
    }
    if (looksLikeSecretText(description)) return 'secret';
    if (!isRecord(parameters) || parameters.type !== 'object') return 'invalid';
    const problem = schemaProblem(parameters);
    if (problem !== undefined) return problem.endsWith(':forbidden') ? 'authority' : 'invalid';
  }
  return undefined;
}

/** Checks an earlier call or result carried in a conversation. */
export function toolPartProblem(part: Record<string, unknown>): ToolProblem | undefined {
  if (part.type === 'tool_call') {
    if (Object.keys(part).some((k) => k !== 'type' && k !== 'call')) return 'invalid';
    return toolCallProblem(part.call);
  }
  if (Object.keys(part).some((k) => !['type', 'callId', 'name', 'result'].includes(k))) {
    return 'invalid';
  }
  if (typeof part.callId !== 'string' || !TOOL_CALL_ID.test(part.callId)) return 'invalid';
  if (typeof part.name !== 'string' || !TOOL_NAME.test(part.name)) return 'invalid';
  if (part.result === undefined || jsonOf(part.result) === undefined) return 'invalid';
  return carriesSecret(part.result) ? 'secret' : undefined;
}

/** A call's shape: id, name, and arguments as a plain object with no authority or secret. */
function toolCallProblem(value: unknown): ToolProblem | undefined {
  if (!isRecord(value)) return 'invalid';
  if (Object.keys(value).some((k) => !['id', 'name', 'arguments'].includes(k))) return 'invalid';
  if (typeof value.id !== 'string' || !TOOL_CALL_ID.test(value.id)) return 'invalid';
  if (typeof value.name !== 'string' || !TOOL_NAME.test(value.name)) return 'invalid';
  if (!isRecord(value.arguments) || jsonOf(value.arguments) === undefined) return 'invalid';
  return carriesSecret(value.arguments) ? 'secret' : undefined;
}

/**
 * Checks the calls a model answered with, against the tools the request offered: each names one
 * of them, has a unique id and arguments that pass that tool's input schema (closed objects, no
 * authority field, no credential value). Anything else is not a valid answer.
 */
export function checkToolCalls(
  calls: unknown,
  tools: readonly AIToolDefinition[] | undefined,
): boolean {
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_TOOL_CALLS) return false;
  if (tools === undefined) return false;
  const ids = new Set<string>();
  for (const call of calls) {
    if (toolCallProblem(call) !== undefined) return false;
    const { id, name, arguments: args } = call as AIToolCall;
    if (ids.has(id)) return false;
    ids.add(id);
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) return false;
    if (!validate(tool.parameters, args).valid) return false;
  }
  return true;
}

/**
 * A tool version as a model may be offered it: its id, the words that describe it (the caller's
 * translation of its `descriptionKey`) and its input schema, unchanged.
 */
export function aiToolOf(version: ToolVersion, description: string): AIToolDefinition {
  return Object.freeze({
    name: version.toolId,
    description,
    parameters: version.inputSchema,
  });
}

/** A rough token estimate for tool definitions and parts, as for text: four characters each. */
export const estimateToolTokens = (value: unknown): number =>
  Math.ceil((jsonOf(value)?.length ?? MAX_TOOL_JSON_LENGTH) / 4);
