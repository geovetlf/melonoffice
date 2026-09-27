import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type { ExecutionJob, ExecutionRef, IsoTimestamp, JobId } from '@melonoffice/domain';
import {
  checkNextJob,
  checkStoredJob,
  isJobId,
  JobError,
  type JobRepository,
  type JobWrite,
} from '@melonoffice/jobs';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `executionJobs/{jobId}` (ADR-0030). The id is deterministic (organization, execution, node,
 * attempt), so a job can only ever be stored once. Pointers only: no input, output, tenant,
 * user or credential. Written only by the server, never by clients.
 */
export const EXECUTION_JOBS = 'executionJobs';

interface JobDocument {
  readonly organizationId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly state: string;
  readonly lease: {
    readonly leaseId: string;
    readonly workerId: string;
    readonly acquiredAt: FirestoreTimestamp;
    readonly expiresAt: FirestoreTimestamp;
  } | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly retryOf: string | null;
  readonly leaseCount: number;
  readonly outcome: { readonly code: string; readonly ref: ExecutionRef | null } | null;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
  readonly finishedAt: FirestoreTimestamp | null;
}

const ts = (at: string) => Timestamp.fromDate(new Date(at));
const iso = (at: FirestoreTimestamp) => at.toDate().toISOString() as IsoTimestamp;

export function toJobDocument(job: ExecutionJob): JobDocument {
  return {
    organizationId: job.organizationId,
    executionId: job.executionId,
    nodeId: job.nodeId,
    attempt: job.attempt,
    state: job.state,
    lease:
      job.lease === undefined
        ? null
        : {
            leaseId: job.lease.leaseId,
            workerId: job.lease.workerId,
            acquiredAt: ts(job.lease.acquiredAt),
            expiresAt: ts(job.lease.expiresAt),
          },
    idempotencyKey: job.idempotencyKey,
    correlationId: job.correlationId,
    retryOf: job.retryOf ?? null,
    leaseCount: job.leaseCount,
    outcome:
      job.outcome === undefined
        ? null
        : {
            code: job.outcome.code,
            ref:
              job.outcome.ref === undefined
                ? null
                : { type: job.outcome.ref.type, id: job.outcome.ref.id },
          },
    revision: job.revision,
    createdAt: ts(job.createdAt),
    updatedAt: ts(job.updatedAt),
    finishedAt: job.finishedAt === undefined ? null : ts(job.finishedAt),
  };
}

/**
 * Reads a stored job back, checked by the model. Any field the model does not know, a changed
 * id or an inconsistent lease makes it invalid: refused, never repaired or used.
 */
export function toJob(id: string, data: Record<string, unknown>): ExecutionJob {
  const { lease, retryOf, outcome, createdAt, updatedAt, finishedAt, ...rest } =
    data as unknown as JobDocument & Record<string, unknown>;
  const job = {
    id,
    ...rest,
    ...(lease === null || lease === undefined
      ? {}
      : {
          lease: {
            leaseId: lease.leaseId,
            workerId: lease.workerId,
            acquiredAt: iso(lease.acquiredAt),
            expiresAt: iso(lease.expiresAt),
          },
        }),
    ...(retryOf === null || retryOf === undefined ? {} : { retryOf }),
    ...(outcome === null || outcome === undefined
      ? {}
      : { outcome: { code: outcome.code, ...(outcome.ref === null ? {} : { ref: outcome.ref }) } }),
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt),
    ...(finishedAt === null || finishedAt === undefined ? {} : { finishedAt: iso(finishedAt) }),
  } as unknown as ExecutionJob;
  try {
    return checkStoredJob(job);
  } catch {
    throw new JobError('invalid_job', 'stored');
  }
}

/** Jobs in Firestore. Every write is one transaction with its audit events. */
export class FirestoreJobRepository implements JobRepository {
  constructor(private readonly db: Firestore) {}

  async find(id: JobId): Promise<ExecutionJob | undefined> {
    if (!isJobId(id)) return undefined;
    const snapshot = await this.db.collection(EXECUTION_JOBS).doc(id).get();
    if (!snapshot.exists) return undefined;
    return toJob(snapshot.id, snapshot.data() as Record<string, unknown>);
  }

  async create({ job, events }: JobWrite): Promise<'created' | 'exists'> {
    checkStoredJob(job);
    if (job.state !== 'queued' || job.revision !== 1) throw new JobError('invalid_job', 'new');
    const doc = this.db.collection(EXECUTION_JOBS).doc(job.id);
    try {
      // Reading first makes concurrent creates conflict, so Firestore re-runs the loser, which
      // then finds the job. `create` also fails on an existing document, as a second guard.
      return await this.db.runTransaction(async (t) => {
        if ((await t.get(doc)).exists) return 'exists' as const;
        t.create(doc, toJobDocument(job));
        this.#append(t, events);
        return 'created' as const;
      });
    } catch (error) {
      // gRPC 6: ALREADY_EXISTS.
      if ((error as { code?: unknown }).code === 6) return 'exists';
      throw error;
    }
  }

  async update(id: JobId, change: (current: ExecutionJob) => JobWrite): Promise<ExecutionJob> {
    if (!isJobId(id)) throw new JobError('job_not_found');
    const doc = this.db.collection(EXECUTION_JOBS).doc(id);
    // Firestore re-runs the whole function when the job changed after it was read, so `change`
    // always decides on the state it overwrites: two workers can never both take a lease.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      if (!snapshot.exists) throw new JobError('job_not_found');
      const current = toJob(snapshot.id, snapshot.data() as Record<string, unknown>);
      const { job, events } = change(current);
      checkNextJob(current, job);
      t.set(doc, toJobDocument(job));
      this.#append(t, events);
      return job;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
