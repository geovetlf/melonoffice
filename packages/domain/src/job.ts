import type { ExecutionId, ExecutionNodeId, ExecutionRef } from './execution.js';
import type { Brand, IsoTimestamp, OrganizationId } from './ids.js';

/**
 * Id of one execution job (ADR-0030): a name-based UUID of the organization, execution, node and
 * attempt, so the same unit of work always has the same id and is never stored twice.
 */
export type JobId = Brand<string, 'JobId'>;

/**
 * Where a job is. `succeeded`, `failed` and `cancelled` are terminal: nothing moves a job out of
 * them. `leased` means one worker owns it until its lease expires.
 */
export type ExecutionJobState = 'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled';

/** Who owns a leased job, and until when, by the server's clock. */
export interface JobLease {
  /** Random, new on every acquisition: the proof of ownership a worker writes with. */
  readonly leaseId: string;
  /** The worker instance that holds it. Operational, not an identity or an audit actor. */
  readonly workerId: string;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/** How a job ended: a stable code, and where a result is, never the result itself. */
export interface JobOutcome {
  readonly code: string;
  readonly ref?: ExecutionRef;
}

/**
 * One unit of runtime work: run one node of one execution, at one attempt (ADR-0030). It is a
 * pointer, not a payload. It never carries user input, a tenant, a user, credentials, secrets or
 * a copy of the execution: authority and data are always read again from the stored execution,
 * whose version snapshot also names the Company Context it runs with.
 */
export interface ExecutionJob {
  readonly id: JobId;
  /** Copied from the stored execution when the job is created, and checked against it after. */
  readonly organizationId: OrganizationId;
  readonly executionId: ExecutionId;
  readonly nodeId: ExecutionNodeId;
  /** The node's attempt this job runs (ADR-0029). Fixed at creation; never chosen by a caller. */
  readonly attempt: number;
  readonly state: ExecutionJobState;
  /** The current or last lease. It gives ownership only while the job is `leased` and unexpired. */
  readonly lease?: JobLease;
  /**
   * Names the logical job for delivery (`job:{executionId}:{nodeId}:{attempt}`), so a transport
   * can deduplicate it. It is not the idempotency key of an external effect: that one is the
   * node's (ADR-0029).
   */
  readonly idempotencyKey: string;
  /** The request that created the job, carried to every log line and audit event about it. */
  readonly correlationId: string;
  /** The job of the previous attempt of the same node, when this one is a retry. */
  readonly retryOf?: JobId;
  /** How many times the job was leased: more than one means an earlier owner lost its lease. */
  readonly leaseCount: number;
  readonly outcome?: JobOutcome;
  /** Increases with every change; a write expecting another revision is refused. */
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
}
