import type { InvoicingSyncJobId, OrganizationId } from '@melonoffice/domain';
import {
  isIntegrationError,
  type InvoicingGateway,
  type InvoicingRepository,
} from '@melonoffice/integrations';
import type { Logger } from '@melonoffice/observability';

/** The only route that runs invoicing syncs (ADR-0193). It means "run this sync for a while". */
export const RUN_INVOICING_SYNC_PATH = '/internal/invoicing/sync';

export interface InvoicingSyncTask {
  readonly organizationId: OrganizationId;
  readonly jobId: InvoicingSyncJobId;
}

export interface InvoicingSyncResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

export interface InvoicingSyncHandler {
  run(request: unknown): Promise<InvoicingSyncResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly `{ organizationId, jobId }`. */
function taskOf(request: unknown): InvoicingSyncTask | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  if (Object.keys(request).sort().join(',') !== 'jobId,organizationId') return undefined;
  const { organizationId, jobId } = request as Record<string, unknown>;
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return undefined;
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return undefined;
  return { organizationId: organizationId as OrganizationId, jobId: jobId as InvoicingSyncJobId };
}

const answer = (status: InvoicingSyncResult['status'], body: InvoicingSyncResult['body']) =>
  Object.freeze({ status, body: Object.freeze(body) });

/**
 * The worker's invoicing sync handler: thin, like the job handler. The gateway re-reads the sync
 * and its connection, takes the sync's lease, reads up to a run's pages and gives the lease back.
 * When the sync wants more (pages left, or a retry at its time), its next run is queued here.
 *
 * `200` is done for this delivery (ran, ended, or another worker holds it); `503` asks the queue
 * to deliver again, which is safe: the lease keeps one run at a time.
 */
export function createInvoicingSyncHandler(options: {
  readonly gateway: Pick<InvoicingGateway, 'runSync'>;
  readonly syncs: Pick<InvoicingRepository, 'findJob'>;
  readonly scheduler: { schedule(task: InvoicingSyncTask, at: Date): Promise<void> };
  readonly workerId: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
}): InvoicingSyncHandler {
  const { gateway, syncs, scheduler, workerId, logger, now = () => new Date() } = options;
  return Object.freeze({
    async run(request: unknown) {
      const task = taskOf(request);
      if (task === undefined) return answer(400, { result: 'invalid_request' });
      try {
        const { job, again } = await gateway.runSync(task.organizationId, task.jobId, workerId);
        if (again) {
          const at = job.nextAttemptAt === undefined ? now() : new Date(job.nextAttemptAt);
          await scheduler.schedule(task, at);
        }
        logger?.info('invoicing sync run', { status: job.status, again });
        return answer(200, { result: job.status });
      } catch (error) {
        const code = isIntegrationError(error) ? error.code : 'unavailable';
        if (code === 'sync_not_found') return answer(200, { result: 'not_found' });
        if (code === 'sync_in_progress') {
          // Another worker holds it, or its time has not come. If a lease holds it, look again
          // when the lease ends, so a worker lost mid-run does not leave it running for good.
          try {
            const job = await syncs.findJob(task.organizationId, task.jobId);
            if (job?.status === 'running' && job.leaseUntil !== undefined) {
              await scheduler.schedule(task, new Date(job.leaseUntil));
            }
            return answer(200, { result: 'in_progress' });
          } catch {
            return answer(503, { result: 'unavailable', code });
          }
        }
        logger?.warn('invoicing sync run failed', { code });
        return answer(503, { result: 'unavailable', code });
      }
    },
  });
}
