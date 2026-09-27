import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { ExecutionJob, JobId } from '@melonoffice/domain';
import { JobError } from './errors.js';
import { checkNextJob, checkStoredJob } from './model.js';

/** The new state of a job and the audit events that record the change, written together. */
export interface JobWrite {
  readonly job: ExecutionJob;
  readonly events: readonly AuditEvent[];
}

/**
 * Where execution jobs live (ADR-0030): Firestore in the API and the worker, memory in tests.
 * Every write stores the job and its audit events together, or nothing. There is no delete and
 * no way to write a job without going through `checkNextJob`.
 */
export interface JobRepository {
  /**
   * The job with this id, checked, or absent. It is not scoped by organization: the job's own
   * stored organization is what the service checks against the stored execution and the tenant.
   */
  find(id: JobId): Promise<ExecutionJob | undefined>;
  /**
   * Stores a new job, once. `exists` when a job with the same id is already stored, whatever its
   * state: the id is deterministic, so a retried or concurrent create never makes a second one,
   * and never changes the first. Its events are written only by the create that stored it.
   */
  create(write: JobWrite): Promise<'created' | 'exists'>;
  /**
   * Reads the current job and lets `change` decide the next one, in one transaction. What it
   * returns must pass `checkNextJob`; a concurrent write in between is refused
   * (`job_concurrency_conflict`), and Firestore re-runs `change` on the fresh state instead. If
   * `change` throws, nothing is written. An absent job is `job_not_found`.
   */
  update(id: JobId, change: (current: ExecutionJob) => JobWrite): Promise<ExecutionJob>;
}

/**
 * For tests and local runs only. Each operation reads, decides and writes without awaiting in
 * between, so operations are serialized exactly as Firestore transactions serialize them.
 */
export class InMemoryJobRepository implements JobRepository {
  readonly #jobs = new Map<string, ExecutionJob>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(id: JobId): Promise<ExecutionJob | undefined> {
    const job = this.#jobs.get(id);
    return job === undefined ? undefined : checkStoredJob(job);
  }

  async create({ job, events }: JobWrite): Promise<'created' | 'exists'> {
    checkStoredJob(job);
    if (job.state !== 'queued' || job.revision !== 1) throw new JobError('invalid_job', 'new');
    if (this.#jobs.has(job.id)) return 'exists';
    this.#append(events);
    this.#jobs.set(job.id, job);
    return 'created';
  }

  async update(id: JobId, change: (current: ExecutionJob) => JobWrite): Promise<ExecutionJob> {
    const stored = this.#jobs.get(id);
    if (stored === undefined) throw new JobError('job_not_found');
    const current = checkStoredJob(stored);
    const { job, events } = change(current);
    checkNextJob(current, job);
    this.#append(events);
    this.#jobs.set(id, job);
    return job;
  }

  #append(events: readonly AuditEvent[]): void {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for job events');
    this.audit.appendNow(events);
  }

  /** Test hook: stores a record as given, the way corrupted or tampered data would look. */
  put(job: ExecutionJob): void {
    this.#jobs.set(job.id, job);
  }
}
