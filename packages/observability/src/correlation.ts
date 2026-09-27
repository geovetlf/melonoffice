import type { Logger } from './logger.js';

/** Ids that tie log lines together: the request, and the execution and node it worked on. */
export interface Correlation {
  readonly requestId?: string;
  readonly executionId?: string;
  readonly nodeId?: string;
}

const ID = /^[\w-]{1,128}$/;

/**
 * A logger whose every line carries the given correlation ids (ADR-0024), so all lines of one
 * execution can be found together. Malformed ids are left out rather than logged.
 */
export function withCorrelation(logger: Logger, correlation: Correlation): Logger {
  const bindings: Record<string, string> = {};
  for (const key of ['requestId', 'executionId', 'nodeId'] as const) {
    const value = correlation[key];
    if (value !== undefined && ID.test(value)) bindings[key] = value;
  }
  return logger.child(bindings);
}
