import type {
  ExecutionId,
  ExecutionJob,
  ExecutionJobState,
  ExecutionNodeId,
  IsoTimestamp,
  JobId,
  JobLease,
  JobOutcome,
  OrganizationId,
} from '@melonoffice/domain';
import { checkRef, isExecutionId, nameBasedUuid } from '@melonoffice/execution';
import { JobError } from './errors.js';

export const JOB_STATES = [
  'queued',
  'leased',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly ExecutionJobState[];

/**
 * Every allowed job state change (ADR-0030). Anything else is refused.
 *
 * - `queued → leased`: a worker takes it. `leased → leased`: another worker takes it over, only
 *   once the lease has expired, under a new lease id.
 * - `leased → succeeded | failed`: only the lease holder, with a valid lease.
 * - `queued | leased → cancelled`: its execution ended. The holder's later write is refused.
 * - `succeeded`, `failed` and `cancelled` are terminal.
 */
export const JOB_TRANSITIONS: Readonly<Record<ExecutionJobState, readonly ExecutionJobState[]>> = {
  queued: ['leased', 'cancelled'],
  leased: ['leased', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const isJobTerminal = (state: ExecutionJobState): boolean =>
  JOB_TRANSITIONS[state].length === 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z_]{0,63}$/;
const CORRELATION_ID = /^[\w-]{1,128}$/;
const WORKER_ID = /^[\w-]{1,128}$/;

const invalid = (detail: string): never => {
  throw new JobError('invalid_job', detail);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isJobId = (value: unknown): value is JobId =>
  typeof value === 'string' && UUID.test(value);
export const isWorkerId = (value: unknown): value is string =>
  typeof value === 'string' && WORKER_ID.test(value);
export const isCorrelationId = (value: unknown): value is string =>
  typeof value === 'string' && CORRELATION_ID.test(value);

const isAttempt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/**
 * The one id a unit of work can ever have: the organization, execution, node and attempt. The
 * same four always name the same job, so creating it twice stores it once; any other attempt,
 * node, execution or organization names another job.
 */
export function jobIdFor(
  organizationId: OrganizationId,
  executionId: ExecutionId,
  nodeId: string,
  attempt: number,
): JobId {
  if (!UUID.test(organizationId)) invalid('organizationId');
  if (!isExecutionId(executionId)) invalid('executionId');
  if (!NODE_ID.test(nodeId)) invalid('nodeId');
  if (!isAttempt(attempt)) invalid('attempt');
  return nameBasedUuid('melonoffice.job', [
    organizationId,
    executionId,
    nodeId,
    String(attempt),
  ]) as JobId;
}

/** The job's delivery key: names the logical job for a transport, not an external effect. */
export const jobKeyOf = (executionId: ExecutionId, nodeId: string, attempt: number): string =>
  `job:${executionId}:${nodeId}:${attempt}`;

/** What identifies a job. Everything else about it is decided here, never by a caller. */
export interface NewJob {
  readonly organizationId: OrganizationId;
  readonly executionId: ExecutionId;
  readonly nodeId: string;
  readonly attempt: number;
  readonly correlationId: string;
}

/** A new `queued` job. Pure. */
export function newJob(request: NewJob, at: IsoTimestamp): ExecutionJob {
  const { organizationId, executionId, nodeId, attempt, correlationId } = request;
  const id = jobIdFor(organizationId, executionId, nodeId, attempt);
  if (!isCorrelationId(correlationId)) invalid('correlationId');
  return Object.freeze({
    id,
    organizationId,
    executionId,
    nodeId: nodeId as ExecutionNodeId,
    attempt,
    state: 'queued',
    idempotencyKey: jobKeyOf(executionId, nodeId, attempt),
    correlationId,
    ...(attempt > 1 ? { retryOf: jobIdFor(organizationId, executionId, nodeId, attempt - 1) } : {}),
    leaseCount: 0,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}

const refuseTerminal = (job: ExecutionJob): void => {
  if (job.state === 'cancelled') throw new JobError('job_cancelled');
  if (isJobTerminal(job.state)) throw new JobError('job_terminal');
};

const plus = (at: IsoTimestamp, ms: number): IsoTimestamp =>
  new Date(Date.parse(at) + ms).toISOString() as IsoTimestamp;

/** Whether a lease still gives ownership at `now`, by the server's clock. */
export const leaseIsLive = (lease: JobLease | undefined, now: IsoTimestamp): boolean =>
  lease !== undefined && Date.parse(now) < Date.parse(lease.expiresAt);

/**
 * Takes the job's lease, or refuses without changing anything: `job_lease_held` while another
 * worker's lease is live, `job_cancelled` or `job_terminal` once it ended. A queued job, or a
 * leased one whose lease has expired, gets a new lease with a new id; the old holder can no
 * longer write.
 */
export function acquireLease(
  job: ExecutionJob,
  lease: { readonly leaseId: string; readonly workerId: string; readonly leaseMs: number },
  now: IsoTimestamp,
): ExecutionJob {
  refuseTerminal(job);
  if (job.state === 'leased' && leaseIsLive(job.lease, now)) {
    throw new JobError('job_lease_held');
  }
  if (!UUID.test(lease.leaseId) || lease.leaseId === job.lease?.leaseId) invalid('leaseId');
  if (!isWorkerId(lease.workerId)) invalid('workerId');
  if (!Number.isSafeInteger(lease.leaseMs) || lease.leaseMs < 1) invalid('leaseMs');
  return Object.freeze({
    ...job,
    state: 'leased',
    lease: Object.freeze({
      leaseId: lease.leaseId,
      workerId: lease.workerId,
      acquiredAt: now,
      expiresAt: plus(now, lease.leaseMs),
    }),
    leaseCount: job.leaseCount + 1,
    revision: job.revision + 1,
    updatedAt: now,
  });
}

/** What a lease holder proves it owns: the job, its lease id and the revision it leased. */
export interface LeaseProof {
  readonly jobId: JobId;
  readonly leaseId: string;
  readonly revision: number;
}

/**
 * Refuses a write that is not the current, live lease holder's: the job ended (`job_cancelled`,
 * `job_terminal`), another lease replaced this one (`job_lease_mismatch`), the job changed since
 * it was leased (`job_revision_mismatch`), or the lease expired (`job_lease_expired`).
 */
export function checkLeaseHolder(job: ExecutionJob, proof: LeaseProof, now: IsoTimestamp): void {
  refuseTerminal(job);
  if (job.id !== proof.jobId) throw new JobError('job_lease_mismatch');
  if (job.state !== 'leased' || job.lease?.leaseId !== proof.leaseId) {
    throw new JobError('job_lease_mismatch');
  }
  if (job.revision !== proof.revision) throw new JobError('job_revision_mismatch');
  if (!leaseIsLive(job.lease, now)) throw new JobError('job_lease_expired');
}

/** How a lease holder says the job ended. */
export interface JobFinish {
  readonly result: 'succeeded' | 'failed';
  readonly code: string;
  readonly ref?: { readonly type: string; readonly id: string };
}

/** A reference and nothing else: its type and id. */
function checkOutcomeRef(value: unknown) {
  if (!isRecord(value)) return invalid('outcome.ref');
  const { type, id, ...rest } = value;
  if (Object.keys(rest).length > 0) return invalid('outcome.ref.fields');
  try {
    return checkRef({ type, id }, 'outcome.ref');
  } catch {
    return invalid('outcome.ref');
  }
}

/** Checks a finish exactly: only its three fields, a stable code, a reference at most. */
export function checkFinish(value: unknown): JobFinish {
  if (!isRecord(value)) return invalid('outcome');
  const { result, code, ref, ...rest } = value;
  if (Object.keys(rest).length > 0) return invalid('outcome.fields');
  if (result !== 'succeeded' && result !== 'failed') return invalid('outcome.result');
  if (typeof code !== 'string' || !CODE.test(code)) return invalid('outcome.code');
  return Object.freeze({
    result,
    code,
    ...(ref === undefined ? {} : { ref: checkOutcomeRef(ref) }),
  });
}

/** The lease holder records how the job ended. The lease stays on the job as its history. */
export function finishJob(
  job: ExecutionJob,
  proof: LeaseProof,
  finish: JobFinish,
  now: IsoTimestamp,
): ExecutionJob {
  checkLeaseHolder(job, proof, now);
  const outcome: JobOutcome = Object.freeze({
    code: finish.code,
    ...(finish.ref === undefined ? {} : { ref: finish.ref }),
  });
  return Object.freeze({
    ...job,
    state: finish.result,
    outcome,
    revision: job.revision + 1,
    updatedAt: now,
    finishedAt: now,
  });
}

/** Cancels a job that has not ended, with a stable reason. Its lease holder can no longer write. */
export function cancelJob(job: ExecutionJob, reason: string, now: IsoTimestamp): ExecutionJob {
  refuseTerminal(job);
  if (!CODE.test(reason)) invalid('reason');
  return Object.freeze({
    ...job,
    state: 'cancelled',
    outcome: Object.freeze({ code: reason }),
    revision: job.revision + 1,
    updatedAt: now,
    finishedAt: now,
  });
}

/** Fields fixed at creation. A change that touches one is refused, never stored. */
const PROTECTED = [
  'id',
  'organizationId',
  'executionId',
  'nodeId',
  'attempt',
  'idempotencyKey',
  'correlationId',
  'retryOf',
  'createdAt',
] as const satisfies readonly (keyof ExecutionJob)[];

/**
 * Checks what a change returned: the same job, one revision ahead, with every protected field
 * unchanged, an allowed state change, and nothing but the job's own fields.
 */
export function checkNextJob(current: ExecutionJob, next: ExecutionJob): void {
  for (const field of PROTECTED) {
    if (next[field] !== current[field]) throw new JobError('invalid_job', `protected.${field}`);
  }
  if (next.revision !== current.revision + 1) throw new JobError('job_concurrency_conflict');
  if (next.state !== current.state || next.state === 'leased') {
    if (!JOB_TRANSITIONS[current.state].includes(next.state)) {
      throw new JobError('invalid_job', 'transition');
    }
  }
  if (next.leaseCount < current.leaseCount) invalid('leaseCount');
  checkStoredJob(next);
}

const KNOWN = new Set<string>([
  'id',
  'organizationId',
  'executionId',
  'nodeId',
  'attempt',
  'state',
  'lease',
  'idempotencyKey',
  'correlationId',
  'retryOf',
  'leaseCount',
  'outcome',
  'revision',
  'createdAt',
  'updatedAt',
  'finishedAt',
]);

/**
 * Checks a stored job before it is trusted: a record that fails is refused, never repaired or
 * used. A field the model does not know (an input, a tenant, a credential) makes it invalid.
 */
export function checkStoredJob(job: ExecutionJob): ExecutionJob {
  if (!isRecord(job)) return invalid('job');
  for (const key of Object.keys(job)) if (!KNOWN.has(key)) invalid(`unknown.${key}`);
  if (!isAttempt(job.attempt)) invalid('attempt');
  if (job.id !== jobIdFor(job.organizationId, job.executionId, job.nodeId, job.attempt)) {
    invalid('id');
  }
  if (!(JOB_STATES as readonly string[]).includes(job.state)) invalid('state');
  if (job.idempotencyKey !== jobKeyOf(job.executionId, job.nodeId, job.attempt)) {
    invalid('idempotencyKey');
  }
  if (!isCorrelationId(job.correlationId)) invalid('correlationId');
  const retryOf =
    job.attempt > 1
      ? jobIdFor(job.organizationId, job.executionId, job.nodeId, job.attempt - 1)
      : undefined;
  if (job.retryOf !== retryOf) invalid('retryOf');
  if (!Number.isSafeInteger(job.leaseCount) || job.leaseCount < 0) invalid('leaseCount');
  if (job.state === 'leased' && job.lease === undefined) invalid('lease');
  if (job.lease !== undefined) {
    const { leaseId, workerId, acquiredAt, expiresAt } = job.lease;
    if (!UUID.test(leaseId) || !isWorkerId(workerId)) invalid('lease');
    if (!(Date.parse(expiresAt) > Date.parse(acquiredAt))) invalid('lease.expiresAt');
  }
  if (isJobTerminal(job.state) !== (job.outcome !== undefined)) invalid('outcome');
  if (job.outcome !== undefined && !CODE.test(job.outcome.code)) invalid('outcome.code');
  if (!Number.isSafeInteger(job.revision) || job.revision < 1) invalid('revision');
  return job;
}
