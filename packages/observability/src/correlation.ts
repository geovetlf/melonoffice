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
  /** The plan, and the workflow version it came from (ADR-0028). */
  readonly planId?: string;
  readonly workflowId?: string;
  readonly workflowVersion?: number;
  /** An execution job, its attempt, and the lease and worker that hold it (ADR-0030). */
  readonly jobId?: string;
  readonly attempt?: number;
  readonly leaseId?: string;
  readonly workerId?: string;
  /** The id that ties a job back to the request that created it. */
  readonly correlationId?: string;
  /** The conversation an assisted AI call is about (ADR-0037). */
  readonly conversationId?: string;
  /**
   * An AI call's task type, the department whose agent made it and how the router ordered the
   * models (ADR-0072), so its cost can be traced to company, department, agent and task.
   */
  readonly taskType?: string;
  readonly departmentId?: string;
  readonly routingStrategy?: string;
}

const KEYS = [
  'requestId',
  'organizationId',
  'executionId',
  'nodeId',
  'specialistId',
  'toolId',
  'provider',
  'planId',
  'workflowId',
  'jobId',
  'leaseId',
  'workerId',
  'correlationId',
  'conversationId',
  'taskType',
  'departmentId',
  'routingStrategy',
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
  for (const key of ['toolVersion', 'workflowVersion', 'attempt'] as const) {
    const version = correlation[key];
    if (version !== undefined && Number.isSafeInteger(version) && version >= 1) {
      bindings[key] = version;
    }
  }
  return logger.child(bindings);
}
