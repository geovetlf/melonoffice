import type {
  FiscalDocument,
  InvoicingConnection,
  InvoicingParty,
  InvoicingPayment,
  InvoicingSyncJob,
} from '@melonoffice/domain';
import {
  isIntegrationError,
  type IntegrationRegistry,
  type InvoicingAdapter,
  type InvoicingGateway,
  type StoredInvoicingRecord,
} from '@melonoffice/integrations';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { MAX_REQUEST_BODY_BYTES } from './body-limit.js';

/**
 * Where a sync's runs are queued for the worker (ADR-0193): the job transport's queue. The task
 * names the organization and the sync, nothing else.
 */
export interface InvoicingSyncScheduler {
  schedule(
    task: { readonly organizationId: string; readonly jobId: string },
    at: Date,
  ): Promise<void>;
}

/**
 * The Billing Integration Gateway's routes (ADR-0193): an organization's connections to its own
 * invoicing systems, their syncs, file imports and the normalized records read from them. Read
 * only: no route issues, voids or changes a fiscal document. Internal for now: no screen calls
 * them yet.
 *
 * Connections use the channel permissions (`channel.*`), since they share the plan's connection
 * limit; syncs and records use `invoicing.sync` and `invoicing.read`. The gateway checks every
 * permission again. Secrets never pass through here: a connection names where its credentials
 * live (`setup`), and the API never accepts their values. Another organization's connection, sync
 * or record answers exactly like a missing one.
 */
export function registerInvoicingRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly gateway: InvoicingGateway;
    readonly registry: IntegrationRegistry;
    /** Absent: a sync cannot be started or resumed (503); nothing pretends to be queued. */
    readonly scheduler?: InvoicingSyncScheduler;
    readonly now?: () => Date;
  },
): void {
  const { gateway, registry, scheduler, now = () => new Date() } = dependencies;
  const base = '/v1/organizations/:organizationId/invoicing';
  const connections = `${base}/connections`;
  const one = `${connections}/:connectionId`;
  const idOf = (c: Context<AuthEnv>) => c.req.param('connectionId') ?? '';
  const jobIdOf = (c: Context<AuthEnv>) => c.req.param('jobId') ?? '';

  /** Queues the sync's first run. Again on a retry with the same key: the lease keeps one run. */
  const queue = async (c: Context<AuthEnv>, job: InvoicingSyncJob): Promise<Response> => {
    if (job.status === 'queued' && scheduler !== undefined) {
      try {
        await scheduler.schedule({ organizationId: job.organizationId, jobId: job.id }, now());
      } catch {
        c.get('logger').warn('invoicing.sync_not_queued', { jobId: job.id });
        return c.json({ error: 'invoicing_scheduler_unavailable', sync: toSyncView(job) }, 503);
      }
    }
    return c.json(toSyncView(job), 202);
  };

  app.get(
    `${base}/providers`,
    withPermission('channel.read', dependencies, async (c) =>
      c.json({ providers: registry.listInvoicing().map(toProviderView) }),
    ),
  );

  app.get(
    connections,
    withPermission('channel.read', dependencies, (c, tenant) =>
      answer(c, async () => ({
        connections: (await gateway.listConnections(tenant)).map(toConnectionView),
      })),
    ),
  );

  app.post(
    connections,
    withPermission('channel.create', dependencies, async (c, tenant) => {
      const body = await jsonOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(
        c,
        async () => {
          const created = await gateway.createConnection(tenant, {
            provider: body.provider,
            displayName: body.displayName,
            account: body.account,
            jurisdiction: body.jurisdiction,
          });
          return { ...toConnectionView(created), setup: setupOf(created) };
        },
        201,
      );
    }),
  );

  app.get(
    one,
    withPermission('channel.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const connection = await gateway.getConnection(tenant, idOf(c));
        return { ...toConnectionView(connection), setup: setupOf(connection) };
      }),
    ),
  );

  /** `{ displayName }` renames it: the only change made this way. */
  app.patch(
    one,
    withPermission('channel.update', dependencies, async (c, tenant) => {
      const body = await jsonOf(c);
      if (body === undefined || Object.keys(body).join() !== 'displayName') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () =>
        toConnectionView(await gateway.rename(tenant, idOf(c), body.displayName)),
      );
    }),
  );

  for (const [action, permission, run] of [
    ['connect', 'channel.update', gateway.connect],
    ['pause', 'channel.update', gateway.pause],
    ['disconnect', 'channel.disconnect', gateway.disconnect],
  ] as const) {
    app.post(
      `${one}/${action}`,
      withPermission(permission, dependencies, (c, tenant) =>
        answer(c, async () => toConnectionView(await run(tenant, idOf(c)))),
      ),
    );
  }

  app.delete(
    one,
    withPermission('channel.delete', dependencies, (c, tenant) =>
      answer(c, async () => toConnectionView(await gateway.revoke(tenant, idOf(c)))),
    ),
  );

  /** `{ recordType, idempotencyKey, full? }`: queues a sync. The same key answers the same sync. */
  app.post(
    `${one}/syncs`,
    withPermission('invoicing.sync', dependencies, async (c, tenant) => {
      const body = await jsonOf(c);
      if (body === undefined || (body.full !== undefined && typeof body.full !== 'boolean')) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      if (scheduler === undefined) return c.json({ error: 'invoicing_scheduler_unavailable' }, 503);
      return answerWith(c, async () =>
        queue(
          c,
          await gateway.startSync(tenant, {
            connectionId: idOf(c),
            recordType: body.recordType,
            idempotencyKey: body.idempotencyKey,
            ...(body.full === true ? { full: true } : {}),
          }),
        ),
      );
    }),
  );

  /**
   * One exported file as the raw body, e.g. a UBL XML invoice: `?format=ubl_xml&recordType=document`.
   * Read and kept inside the request; the same file imports once.
   */
  app.post(
    `${one}/imports`,
    withPermission('invoicing.sync', dependencies, async (c, tenant) => {
      const content = new Uint8Array(await c.req.arrayBuffer());
      if (content.byteLength > MAX_REQUEST_BODY_BYTES) {
        return c.json({ error: 'payload_too_large' }, 413);
      }
      return answer(
        c,
        async () =>
          toSyncView(
            await gateway.importFile(tenant, {
              connectionId: idOf(c),
              format: c.req.query('format'),
              recordType: c.req.query('recordType'),
              content,
            }),
          ),
        201,
      );
    }),
  );

  app.get(
    `${base}/syncs`,
    withPermission('invoicing.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const connectionId = c.req.query('connectionId');
        const from = c.req.query('from');
        return {
          syncs: (
            await gateway.listSyncs(tenant, {
              ...(connectionId === undefined ? {} : { connectionId }),
              ...(from === undefined ? {} : { from }),
            })
          ).map(toSyncView),
        };
      }),
    ),
  );

  app.get(
    `${base}/syncs/:jobId`,
    withPermission('invoicing.read', dependencies, (c, tenant) =>
      answer(c, async () => toSyncView(await gateway.getSync(tenant, jobIdOf(c)))),
    ),
  );

  /** Starts a sync from where an incomplete one stopped. */
  app.post(
    `${base}/syncs/:jobId/resume`,
    withPermission('invoicing.sync', dependencies, async (c, tenant) => {
      if (scheduler === undefined) return c.json({ error: 'invoicing_scheduler_unavailable' }, 503);
      return answerWith(c, async () => queue(c, await gateway.resumeSync(tenant, jobIdOf(c))));
    }),
  );

  app.get(
    `${base}/records`,
    withPermission('invoicing.read', dependencies, async (c, tenant) => {
      const connectionId = c.req.query('connectionId');
      const cursor = c.req.query('cursor');
      const size = c.req.query('pageSize');
      const pageSize = size === undefined ? undefined : Number(size);
      if (pageSize !== undefined && !Number.isSafeInteger(pageSize)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () => {
        const page = await gateway.listRecords(tenant, {
          recordType: c.req.query('recordType'),
          ...(connectionId === undefined ? {} : { connectionId }),
          ...(pageSize === undefined ? {} : { pageSize }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { records: page.items.map(toRecordView), nextCursor: page.nextCursor ?? null };
      });
    }),
  );
}

const STATUS = {
  unresolved_tenant: 403,
  organization_inactive: 403,
  permission_denied: 403,
  requires_user: 403,
  invalid_connection: 400,
  invalid_payload: 400,
  invalid_file: 400,
  capability_missing: 400,
  file_too_large: 413,
  connection_not_found: 404,
  sync_not_found: 404,
  record_not_found: 404,
  connection_revoked: 409,
  connection_disabled: 409,
  invalid_transition: 409,
  sync_in_progress: 409,
  sync_not_resumable: 409,
  limit_reached: 409,
  category_not_allowed: 403,
  entitlements_unavailable: 403,
  secret_unavailable: 503,
} as const;

async function jsonOf(c: Context<AuthEnv>): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The gateway's refusals as answers: a code and, for a refused field, its name; never a value. */
function refusal(c: Context<AuthEnv>, error: unknown): Response {
  if (isIntegrationError(error) && Object.hasOwn(STATUS, error.code)) {
    const code = error.code as keyof typeof STATUS;
    const field =
      ['invalid_connection', 'invalid_payload', 'invalid_file', 'capability_missing'].includes(
        code,
      ) && error.detail
        ? { field: error.detail }
        : {};
    return c.json({ error: code, ...field }, STATUS[code]);
  }
  throw error;
}

async function answer(
  c: Context<AuthEnv>,
  work: () => Promise<unknown>,
  status: 200 | 201 = 200,
): Promise<Response> {
  try {
    return c.json(await work(), status);
  } catch (error) {
    return refusal(c, error);
  }
}

async function answerWith(c: Context<AuthEnv>, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return refusal(c, error);
  }
}

function toProviderView(adapter: InvoicingAdapter) {
  return {
    provider: adapter.provider,
    category: adapter.category,
    jurisdictions: adapter.jurisdictions,
    capabilities: adapter.capabilities,
    credentialKinds: adapter.credentialKinds,
  };
}

/** A connection without its secret references: they name where credentials live. */
export function toConnectionView(c: InvoicingConnection) {
  return {
    id: c.id,
    provider: c.provider,
    category: c.category,
    jurisdiction: c.jurisdiction,
    status: c.status,
    statusReason: c.statusReason ?? null,
    displayName: c.displayName,
    account: c.account,
    capabilities: c.capabilities,
    syncState: c.syncState,
    lastValidatedAt: c.lastValidatedAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * What a person needs to finish setting a connection up, outside MelonOffice: the names of the
 * secrets to create in the project's Secret Manager (never their values). The project is not shown.
 */
function setupOf(c: InvoicingConnection) {
  return {
    secretIds: Object.fromEntries(
      Object.entries(c.secrets).map(([kind, ref]) => [kind, ref.split('/')[3] ?? '']),
    ),
  };
}

/** A sync as a person sees it: no lease, no cursor (both are the worker's). */
export function toSyncView(j: InvoicingSyncJob) {
  return {
    id: j.id,
    connectionId: j.connectionId,
    provider: j.provider,
    recordType: j.recordType,
    trigger: j.trigger,
    status: j.status,
    incompleteReason: j.incompleteReason ?? null,
    errorCode: j.errorCode ?? null,
    resumable:
      j.status === 'incomplete' &&
      j.incompleteReason !== 'records_rejected' &&
      j.cursor !== undefined,
    attempts: j.attempts,
    nextAttemptAt: j.nextAttemptAt ?? null,
    counts: j.counts,
    rejections: j.rejections,
    fileDigest: j.fileDigest ?? null,
    createdAt: j.createdAt,
    startedAt: j.startedAt ?? null,
    finishedAt: j.finishedAt ?? null,
    updatedAt: j.updatedAt,
  };
}

function toRecordView(stored: StoredInvoicingRecord) {
  const record: InvoicingParty | FiscalDocument | InvoicingPayment = stored.record;
  return { recordType: stored.recordType, ...record };
}
