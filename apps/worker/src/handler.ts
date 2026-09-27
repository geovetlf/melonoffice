import { isJobError, isJobId, type JobErrorCode, type JobService } from '@melonoffice/jobs';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { Runtime } from '@melonoffice/runtime';

/**
 * What one delivery of a job ended as, for the transport (ADR-0032). Cloud Tasks retries a
 * delivery that does not answer 2xx, so the status says only whether delivering again can help:
 *
 * - `200`: done with this delivery; delivering it again changes nothing. The body says how
 *   (`advanced` with the runtime's outcome, or `refused` with a stable code).
 * - `409`: another worker holds a live lease on the job. Deliver later: once that lease ends,
 *   the job is finished (and a later delivery is a no-op) or taken over.
 * - `400`: the request is not exactly `{ jobId }`. Nothing was read or changed.
 * - `503`: something failed before the work was known to be done (storage, for example).
 *   Delivering again is safe: the lease, the revision and the node state decide what runs.
 */
export interface JobRunResult {
  readonly status: 200 | 400 | 409 | 503;
  readonly body: {
    readonly result: 'advanced' | 'refused' | 'retry_later' | 'invalid_request' | 'unavailable';
    readonly code: string;
    readonly outcome?: string;
  };
}

export interface JobHandler {
  /** Runs one delivery of a job. The request is exactly `{ jobId }`; nothing else is read. */
  run(request: unknown, requestId: string): Promise<JobRunResult>;
}

export interface JobHandlerOptions {
  /** Only `acquire`: the lease is taken by the job service, from storage. */
  readonly jobs: Pick<JobService, 'acquire'>;
  /** Only `advance`: the runtime is the only way a node moves. */
  readonly runtime: Pick<Runtime, 'advance'>;
  /** This worker instance, recorded on the lease. Infrastructure, never an actor. */
  readonly workerId: string;
  readonly logger?: Logger;
}

/**
 * Refusals of `acquire` that no later delivery can change: the job is gone, ended, not this
 * worker's to run, or its execution ended. The job service already recorded what needed recording.
 */
const FINAL: readonly JobErrorCode[] = [
  'job_not_found',
  'job_terminal',
  'job_cancelled',
  'job_forbidden',
  'execution_not_found',
  'execution_not_runnable',
  'node_not_runnable',
  'job_attempt_mismatch',
  'invalid_job',
  'unresolved_tenant',
  'organization_inactive',
  'actor_not_allowed',
  'permission_denied',
];

const RETRY_LATER: readonly JobErrorCode[] = ['job_lease_held', 'job_concurrency_conflict'];

const answer = (status: JobRunResult['status'], body: JobRunResult['body']): JobRunResult =>
  Object.freeze({ status, body: Object.freeze(body) });

/** Exactly `{ jobId }` with a well-formed job id. */
function jobIdOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== 'jobId') return undefined;
  const { jobId } = request as { jobId: unknown };
  return isJobId(jobId) ? jobId : undefined;
}

/**
 * The worker's job handler (ADR-0032): deliberately thin. It checks the request, takes the lease
 * through the job service and hands the lease proof to the runtime. It decides nothing: no
 * tenant, user, attempt, node, tool, model, approval or verification comes from the request,
 * and it never changes a job, node or execution itself.
 */
export function createJobHandler({
  jobs,
  runtime,
  workerId,
  logger,
}: JobHandlerOptions): JobHandler {
  return {
    async run(request, requestId) {
      const jobId = jobIdOf(request);
      const log =
        logger === undefined
          ? undefined
          : withCorrelation(logger, {
              requestId,
              workerId,
              ...(jobId === undefined ? {} : { jobId }),
            });
      if (jobId === undefined) {
        log?.warn('job delivery refused', { code: 'invalid_request' });
        return answer(400, { result: 'invalid_request', code: 'invalid_request' });
      }
      const started = performance.now();
      log?.info('job received');

      let claim;
      try {
        claim = await jobs.acquire(jobId, workerId);
      } catch (error) {
        if (!isJobError(error)) {
          log?.error('job lease unavailable', { error });
          return answer(503, { result: 'unavailable', code: 'lease_unavailable' });
        }
        if (RETRY_LATER.includes(error.code)) {
          log?.info('job lease conflict', { code: error.code });
          return answer(409, { result: 'retry_later', code: error.code });
        }
        if (FINAL.includes(error.code)) {
          log?.info('job refused', { code: error.code });
          return answer(200, { result: 'refused', code: error.code });
        }
        // A lease error right after acquiring (expired, replaced) means another delivery owns it.
        log?.info('job lease conflict', { code: error.code });
        return answer(409, { result: 'retry_later', code: error.code });
      }
      log?.info('job claimed', { leaseId: claim.lease.leaseId, attempt: claim.job.attempt });

      try {
        // Only the lease proof: the runtime reads the job, execution and tenant again itself.
        const { jobId: id, leaseId, revision } = claim.lease;
        const result = await runtime.advance({ jobId: id, leaseId, revision });
        log?.info('job run', {
          outcome: result.outcome,
          code: result.code,
          durationMs: Math.round(performance.now() - started),
        });
        return answer(200, { result: 'advanced', outcome: result.outcome, code: result.code });
      } catch (error) {
        // Nothing is undone or repeated here. A later delivery finds the lease (live: 409; expired:
        // taken over) and the node state (running: outcome unknown, never re-run).
        log?.error('job run failed', {
          error,
          durationMs: Math.round(performance.now() - started),
        });
        return answer(503, { result: 'unavailable', code: 'run_failed' });
      }
    },
  };
}
