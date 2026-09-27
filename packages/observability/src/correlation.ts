import type { Logger } from './logger.js';

/**
 * Ids that tie log lines together: the request, the execution and node it worked on and, for a
 * tool call (ADR-0026), the organization, specialist and exact tool version.
 */
export interface Correlation {
  readonly requestId?: string;
  readonly organizationId?: string;
  readonly executionId?: string;
  readonly nodeId?: string;
  readonly specialistId?: string;
  readonly toolId?: string;
  readonly toolVersion?: number;
  /** The AI provider and model of an AI call (ADR-0027). */
  readonly provider?: string;
  readonly model?: string;
}

const KEYS = [
  'requestId',
  'organizationId',
  'executionId',
  'nodeId',
  'specialistId',
  'toolId',
  'provider',
] as const;

const ID = /^[\w-]{1,128}$/;

/**
 * A logger whose every line carries the given correlation ids (ADR-0024), so all lines of one
 * execution can be found together. Malformed ids are left out rather than logged.
 */
export function withCorrelation(logger: Logger, correlation: Correlation): Logger {
  const bindings: Record<string, string | number> = {};
  for (const key of KEYS) {
    const value = correlation[key];
    if (value !== undefined && ID.test(value)) bindings[key] = value;
  }
  // Model ids may carry dots and colons (e.g. versions); nothing else.
  const { model } = correlation;
  if (model !== undefined && /^[\w.:/-]{1,160}$/.test(model)) bindings.model = model;
  const { toolVersion } = correlation;
  if (toolVersion !== undefined && Number.isSafeInteger(toolVersion) && toolVersion >= 1) {
    bindings.toolVersion = toolVersion;
  }
  return logger.child(bindings);
}
