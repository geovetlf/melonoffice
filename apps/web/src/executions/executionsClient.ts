import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Stopping work that is under way (ADR-0024, ADR-0029): a plan or an agent task is an execution,
 * and a person may ask it to stop. The server cancels it and everything it delegated, records
 * why, and refuses one that already ended. Starting is never done from here: approving a plan or
 * asking an agent starts the work.
 */

export class ExecutionRequestError extends Error {
  override readonly name = 'ExecutionRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`execution request failed: ${status} ${code}`);
  }
}

export interface ExecutionsClient {
  /** Asks the execution (a plan's or an agent task's) to stop, as the person's own request. */
  cancel(executionId: string): Promise<void>;
}

export function createExecutionsClient(
  request: ReplyRequest,
  organizationId: string,
): ExecutionsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/executions`;
  return {
    async cancel(executionId) {
      const response = await request(`${base}/${encodeURIComponent(executionId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'director_request' }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        throw new ExecutionRequestError(
          response.status,
          typeof body.error === 'string' ? body.error : 'unexpected',
        );
      }
    },
  };
}
