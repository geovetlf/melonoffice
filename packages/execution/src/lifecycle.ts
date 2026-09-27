import type { ExecutionMode, ExecutionNodeStatus, ExecutionStatus } from '@melonoffice/domain';

export const EXECUTION_STATUSES = [
  'pending',
  'planning',
  'waiting_approval',
  'running',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'paused',
  'retrying',
] as const satisfies readonly ExecutionStatus[];

export const EXECUTION_MODES = [
  'ask',
  'plan',
  'execute',
  'review',
  'debug',
  'delegate',
] as const satisfies readonly ExecutionMode[];

/**
 * Every allowed status change (ADR-0024). Anything not listed is refused. Notes:
 *
 * - `completed` is reached only from `verifying`: a step that ran is not a task that is done.
 * - `completed`, `failed` and `cancelled` are terminal. A failed execution is retried, when a
 *   future recovery policy allows it, by a new execution pointing at it (`parentExecutionId`).
 * - `cancelled` is reachable from every non-terminal status.
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> =
  {
    pending: ['planning', 'waiting_approval', 'running', 'failed', 'cancelled'],
    planning: ['waiting_approval', 'running', 'paused', 'failed', 'cancelled'],
    waiting_approval: ['planning', 'running', 'failed', 'cancelled'],
    running: ['waiting_approval', 'verifying', 'paused', 'retrying', 'failed', 'cancelled'],
    verifying: ['completed', 'retrying', 'failed', 'cancelled'],
    paused: ['planning', 'running', 'failed', 'cancelled'],
    retrying: ['running', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  };

export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['completed', 'failed', 'cancelled'];

export const isExecutionStatus = (value: unknown): value is ExecutionStatus =>
  typeof value === 'string' && (EXECUTION_STATUSES as readonly string[]).includes(value);

export const isExecutionMode = (value: unknown): value is ExecutionMode =>
  typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);

export const isTerminal = (status: ExecutionStatus): boolean => TERMINAL_STATUSES.includes(status);

export const canTransition = (from: ExecutionStatus, to: ExecutionStatus): boolean =>
  EXECUTION_TRANSITIONS[from].includes(to);

export const NODE_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const satisfies readonly ExecutionNodeStatus[];

/** Node status changes. `completed`, `failed`, `skipped` and `cancelled` are final. */
export const NODE_TRANSITIONS: Readonly<
  Record<ExecutionNodeStatus, readonly ExecutionNodeStatus[]>
> = {
  pending: ['running', 'skipped', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export const isNodeStatus = (value: unknown): value is ExecutionNodeStatus =>
  typeof value === 'string' && (NODE_STATUSES as readonly string[]).includes(value);

export const isNodeFinal = (status: ExecutionNodeStatus): boolean =>
  NODE_TRANSITIONS[status].length === 0;
