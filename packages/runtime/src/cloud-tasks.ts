import type { JobId } from '@melonoffice/domain';
import type { JobDispatcher } from './ports.js';

/** Cloud Tasks queue paths: `projects/{project}/locations/{region}/queues/{queue}`. */
const QUEUE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/queues\/[A-Za-z0-9-]{1,100}$/;

/** The metadata server's token endpoint for the service's own runtime identity. No key. */
export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Refresh the access token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

export interface CloudTasksDispatcherOptions {
  /** The queue jobs go to. */
  readonly queue: string;
  /** The worker endpoint a task calls: `https://…/internal/jobs/run`. */
  readonly targetUrl: string;
  /** The audience of the task's OIDC token: the worker's URL, which the worker checks. */
  readonly audience: string;
  /** The service account Cloud Tasks signs the OIDC token as. The only allowed invoker. */
  readonly invokerEmail: string;
  /** How long Cloud Tasks waits for one delivery, in seconds. At least the job lease. */
  readonly dispatchDeadlineSeconds: number;
  /** HTTP. Defaults to the global fetch; tests pass their own. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export class DispatchError extends Error {
  override readonly name = 'DispatchError';

  constructor(
    readonly code: 'token_unavailable' | 'enqueue_failed',
    readonly status?: number,
  ) {
    super(status === undefined ? code : `${code}: ${status}`);
  }
}

/**
 * Cloud Tasks over its REST API, with an access token from the metadata server: no client
 * library, key or credential of its own (ADR-0032). One task is one HTTP call to the worker with
 * an OIDC token for the invoker service account, now or at `scheduleTime`.
 */
function createCloudTasksClient(options: Omit<CloudTasksDispatcherOptions, 'targetUrl'>) {
  const { queue, audience, invokerEmail, dispatchDeadlineSeconds } = options;
  if (!QUEUE.test(queue)) throw new Error('Invalid Cloud Tasks queue path');
  if (!audience.startsWith('https://')) throw new Error('The worker URL must be https');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(invokerEmail)) {
    throw new Error('Invalid invoker service account');
  }
  if (!Number.isSafeInteger(dispatchDeadlineSeconds) || dispatchDeadlineSeconds < 15) {
    throw new Error('Invalid dispatch deadline');
  }
  const http = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token !== undefined && token.expiresAt - TOKEN_MARGIN_MS > now().getTime()) {
      return token.value;
    }
    let response: Response;
    try {
      response = await http(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
    } catch {
      throw new DispatchError('token_unavailable');
    }
    if (!response.ok) throw new DispatchError('token_unavailable', response.status);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new DispatchError('token_unavailable');
    }
    token = { value: body.access_token, expiresAt: now().getTime() + body.expires_in * 1000 };
    return token.value;
  }

  return {
    async enqueue(url: string, body: object, scheduleTime?: Date): Promise<void> {
      const payload = Buffer.from(JSON.stringify(body)).toString('base64');
      const task = {
        task: {
          httpRequest: {
            url,
            httpMethod: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            oidcToken: { serviceAccountEmail: invokerEmail, audience },
          },
          dispatchDeadline: `${dispatchDeadlineSeconds}s`,
          ...(scheduleTime === undefined ? {} : { scheduleTime: scheduleTime.toISOString() }),
        },
      };
      let response: Response;
      try {
        response = await http(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(task),
        });
      } catch (error) {
        if (error instanceof DispatchError) throw error;
        throw new DispatchError('enqueue_failed');
      }
      // Never pass on the response body: it may echo the request.
      if (!response.ok) throw new DispatchError('enqueue_failed', response.status);
    },
  };
}

/**
 * Hands a queued job to Cloud Tasks (D-X6-JOB, ADR-0032). The task carries exactly `{ jobId }`
 * and an OIDC token for the invoker service account; the worker re-reads everything else from
 * Firestore. Cloud Tasks is the transport, never the source of truth: a task that arrives twice,
 * late or for an ended job changes nothing (the lease, the revision and the node state decide).
 *
 * No task name is set, on purpose: a released job goes back to the queue under the same id and
 * must be deliverable again, and Cloud Tasks keeps names reserved long after a task ends.
 */
export function createCloudTasksDispatcher(options: CloudTasksDispatcherOptions): JobDispatcher {
  if (!options.targetUrl.startsWith('https://')) throw new Error('The worker URL must be https');
  const client = createCloudTasksClient(options);
  return {
    async dispatch(jobId: JobId) {
      await client.enqueue(options.targetUrl, { jobId });
    },
  };
}

/**
 * Queues a task for a later time on the same queue, worker and invoker as jobs (C5, ADR-0058):
 * the follow-ups' scheduler. Cloud Tasks holds the task until `at` (up to 30 days ahead) and
 * retries it with the queue's own policy; the worker re-reads everything from Firestore, so a
 * repeated or late task changes nothing. The body is small and carries no personal data.
 */
export interface CloudTasksScheduler {
  schedule(body: object, at: Date): Promise<void>;
}

export function createCloudTasksScheduler(
  options: CloudTasksDispatcherOptions,
): CloudTasksScheduler {
  if (!options.targetUrl.startsWith('https://')) throw new Error('The worker URL must be https');
  const client = createCloudTasksClient(options);
  return {
    async schedule(body: object, at: Date) {
      if (Number.isNaN(at.getTime())) throw new Error('Invalid schedule time');
      await client.enqueue(options.targetUrl, body, at);
    },
  };
}
