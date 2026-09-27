import type { WorkflowStatus } from '@melonoffice/domain';

export const WORKFLOW_STATUSES = [
  'draft',
  'active',
  'paused',
  'archived',
] as const satisfies readonly WorkflowStatus[];

/**
 * Every allowed workflow status change (ADR-0028). Only `active` workflows are instantiated;
 * `archived` is history and final. A version, once written, never changes in any status.
 */
export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export const isWorkflowStatus = (value: unknown): value is WorkflowStatus =>
  typeof value === 'string' && (WORKFLOW_STATUSES as readonly string[]).includes(value);

export const canChangeWorkflowStatus = (from: WorkflowStatus, to: WorkflowStatus): boolean =>
  WORKFLOW_TRANSITIONS[from].includes(to);
