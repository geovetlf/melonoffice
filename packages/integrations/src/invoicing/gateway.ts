import {
  actorOf,
  buildAuditEvent,
  type AuditActor,
  type AuditEvent,
  type AuditEventInput,
} from '@melonoffice/audit';
import type {
  ChannelConnectionStatus,
  FiscalDocument,
  InvoicingConnection,
  InvoicingConnectionId,
  InvoicingFileFormat,
  InvoicingIncompleteReason,
  InvoicingParty,
  InvoicingPayment,
  InvoicingRecordId,
  InvoicingRecordType,
  InvoicingSource,
  InvoicingSyncCounts,
  InvoicingSyncJob,
  InvoicingSyncJobId,
  InvoicingSyncTrigger,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { EntitlementService } from '@melonoffice/entitlements';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import type { ConnectionCheck } from '../adapter.js';
import { backoffDelay } from '../delivery.js';
import { IntegrationError, isIntegrationError } from '../errors.js';
import { acceptsInbound, canTransition, occupiesSlot } from '../lifecycle.js';
import type { IntegrationRegistry } from '../registry.js';
import { invoicingSecretRefFor, type SecretStore } from '../secrets.js';
import {
  isInvoicingFileFormat,
  isInvoicingRecordType,
  type InvoicingAdapter,
  type InvoicingCredentials,
  type InvoicingPage,
  type NormalizedInvoicingRecord,
} from './contract.js';
import {
  checkNormalizedRecord,
  digestOf,
  isFinalSync,
  isInvoicingId,
  MAX_REJECTIONS,
  sumAmounts,
} from './model.js';
import type { InvoicingRepository, StoredInvoicingRecord, UpsertOutcome } from './store.js';

/**
 * The Billing Integration Gateway (ADR-0193): the one way MelonOffice reads an organization's own
 * invoicing system, and the only caller of an invoicing adapter. It is part of the Integration
 * Engine (ADR-0044): same registry, lifecycle, secret store, error codes, audit trail and
 * permissions for connections (`channel.*`), plus `invoicing.read` and `invoicing.sync`.
 *
 * Read only: it lists, verifies webhooks, imports files and keeps normalized copies. Nothing
 * here issues, voids or changes a fiscal document at a provider or an authority.
 *
 * Every operation is scoped to the tenant's organization; a webhook's organization is taken from
 * the stored connection, never from the request.
 */

export interface InvoicingLimits {
  /** Pages one run reads before giving its lease back (the worker's time bound). */
  readonly pagesPerRun: number;
  /** Pages one sync reads in total before it ends `incomplete` (`pages_remaining`). */
  readonly pagesPerSync: number;
  readonly pageSize: number;
  /** Provider failures in a row before a sync ends `incomplete` (`retries_exhausted`). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly callTimeoutMs: number;
  readonly leaseMs: number;
  readonly maxFileBytes: number;
}

export const DEFAULT_INVOICING_LIMITS: InvoicingLimits = Object.freeze({
  pagesPerRun: 10,
  pagesPerSync: 1000,
  pageSize: 100,
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  callTimeoutMs: 20_000,
  leaseMs: 5 * 60_000,
  maxFileBytes: 10 * 1024 * 1024,
});

export interface NewInvoicingConnectionInput {
  readonly provider: unknown;
  readonly displayName: unknown;
  readonly account: unknown;
  /** ISO 3166-1 alpha-2; must be one its adapter reads. */
  readonly jurisdiction: unknown;
}

export interface StartSyncInput {
  readonly connectionId: unknown;
  readonly recordType: unknown;
  /** The caller's key: the same key starts the same sync once. */
  readonly idempotencyKey: unknown;
  /** Read everything instead of what changed since the last complete sync. */
  readonly full?: boolean;
}

export interface ImportFileInput {
  readonly connectionId: unknown;
  readonly format: unknown;
  readonly recordType: unknown;
  readonly content: Uint8Array;
}

/** What a run did: the sync as it stands after it. */
export interface RunResult {
  readonly job: InvoicingSyncJob;
  /** Whether the sync wants another run (more pages, or a retry at `nextAttemptAt`). */
  readonly again: boolean;
}

export interface InvoicingGateway {
  listConnections(tenant: TenantContext): Promise<readonly InvoicingConnection[]>;
  getConnection(tenant: TenantContext, id: string): Promise<InvoicingConnection>;
  createConnection(
    tenant: TenantContext,
    input: NewInvoicingConnectionInput,
  ): Promise<InvoicingConnection>;
  /** Checks the credentials with the provider: `connected`, or `error` with its code. */
  connect(tenant: TenantContext, id: string): Promise<InvoicingConnection>;
  rename(tenant: TenantContext, id: string, displayName: unknown): Promise<InvoicingConnection>;
  pause(tenant: TenantContext, id: string): Promise<InvoicingConnection>;
  /**
   * Turns it off: running syncs end `incomplete` (`connection_stopped`), webhooks are refused,
   * and when its provider can, the access it granted is revoked. Synced records are kept.
   */
  disconnect(tenant: TenantContext, id: string): Promise<InvoicingConnection>;
  /** Deletes it for good (`revoked`). Its secrets are deleted by an operator. */
  revoke(tenant: TenantContext, id: string): Promise<InvoicingConnection>;

  startSync(tenant: TenantContext, input: StartSyncInput): Promise<InvoicingSyncJob>;
  /** Starts a sync from where an incomplete one stopped (its cursor and watermark). */
  resumeSync(tenant: TenantContext, jobId: string): Promise<InvoicingSyncJob>;
  /**
   * Runs a sync for a while: what the job system calls (phase 2). Takes the sync's lease, reads
   * up to `pagesPerRun` pages, and gives the lease back.
   */
  runSync(
    organizationId: OrganizationId,
    jobId: InvoicingSyncJobId,
    workerId: string,
  ): Promise<RunResult>;
  /**
   * A provider's webhook. Verified with the connection's `webhook_secret`, then only used as a
   * hint: it starts incremental syncs, once per provider event. Its content is never stored.
   */
  receiveWebhook(
    connectionId: string,
    rawBody: string,
    headers: Headers,
  ): Promise<{ readonly accepted: boolean; readonly jobs: readonly InvoicingSyncJob[] }>;
  /** Imports an exported file through the connection's adapter. The same file imports once. */
  importFile(tenant: TenantContext, input: ImportFileInput): Promise<InvoicingSyncJob>;

  getSync(tenant: TenantContext, jobId: string): Promise<InvoicingSyncJob>;
  listSyncs(
    tenant: TenantContext,
    filter?: { readonly connectionId?: string; readonly from?: string },
  ): Promise<readonly InvoicingSyncJob[]>;
  listRecords(
    tenant: TenantContext,
    filter: {
      readonly recordType: unknown;
      readonly connectionId?: string;
      readonly pageSize?: number;
      readonly cursor?: string;
    },
  ): Promise<{ readonly items: readonly StoredInvoicingRecord[]; readonly nextCursor?: string }>;
}

export interface InvoicingGatewayOptions {
  readonly repository: InvoicingRepository;
  readonly registry: IntegrationRegistry;
  /** Reads `invoicing-*` secrets only (`accepts: isInvoicingSecretRef`). */
  readonly secrets: SecretStore;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly entitlements: Pick<EntitlementService, 'entitlementsOf'>;
  /**
   * The organization's channel connections that take a plan slot, so that one
   * `integrations.connectionsMax` counts every connection. Unset: none are counted (tests).
   */
  readonly channelSlotsUsed?: (organizationId: OrganizationId) => Promise<number>;
  /**
   * Where connections' secrets live. Unset: connections to a provider that needs credentials can
   * be listed and turned off, but not created (`secret_unavailable`).
   */
  readonly secretProjectId?: string;
  readonly limits?: Partial<InvoicingLimits>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly random?: () => number;
  readonly requestId?: string;
}

const MAX_NAME_LENGTH = 80;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const COUNTRY = /^[A-Z]{2}$/;
const AUDIT_CODE = /^[a-z][a-z_]{0,63}$/;
/** A secret never comes through the API: any field named like one is refused outright. */
const SECRET_LIKE = /pass|clave|secret|token|key|pwd|pin|credential|sol_user|usuario/i;

const EMPTY_COUNTS: InvoicingSyncCounts = Object.freeze({
  pagesRead: 0,
  providerCalls: 0,
  recordsSeen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  rejected: 0,
  bytesRead: 0,
});

const auditCode = (code: string | undefined, fallback: string): string =>
  code !== undefined && AUDIT_CODE.test(code) ? code : fallback;

function checkName(value: unknown): string {
  if (typeof value !== 'string') throw new IntegrationError('invalid_connection', 'displayName');
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new IntegrationError('invalid_connection', 'displayName');
  }
  return name;
}

export function createInvoicingGateway(options: InvoicingGatewayOptions): InvoicingGateway {
  const {
    repository,
    registry,
    secrets,
    organizations,
    authorization,
    entitlements,
    channelSlotsUsed,
    secretProjectId,
    now = () => new Date(),
    newId = () => randomUUID(),
    random = Math.random,
    requestId,
  } = options;
  const limits: InvoicingLimits = Object.freeze({ ...DEFAULT_INVOICING_LIMITS, ...options.limits });
  const iso = (at: Date) => at.toISOString() as IsoTimestamp;

  const event = (input: Omit<AuditEventInput, 'source' | 'requestId'>, at: Date): AuditEvent =>
    buildAuditEvent(
      { ...input, source: 'api', ...(requestId === undefined ? {} : { requestId }) },
      at,
    );

  async function organizationOf(
    tenant: TenantContext,
    permission: string,
    direct: boolean,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new IntegrationError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new IntegrationError('permission_denied');
    }
    // Connecting, changing and syncing are a person's own acts: never GIA, never the runtime.
    if (direct && tenant.actor !== 'user') throw new IntegrationError('requires_user');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new IntegrationError('organization_inactive');
    }
    return organization.id;
  }

  const userOf = (tenant: TenantContext) => (tenant as { readonly userId: UserId }).userId;
  const actorFor = (tenant: TenantContext): AuditActor => actorOf(tenant as never);
  const runtimeFor = (userId: UserId): AuditActor => actorOf({ actor: 'runtime', userId } as never);

  function adapterOf(connection: InvoicingConnection): InvoicingAdapter {
    const adapter = registry.findInvoicing(connection.provider);
    if (adapter === undefined) throw new IntegrationError('provider_unavailable', 'not_registered');
    return adapter;
  }

  async function credentialsOf(
    connection: InvoicingConnection,
    adapter: InvoicingAdapter,
  ): Promise<InvoicingCredentials> {
    const values: Record<string, string> = {};
    for (const kind of adapter.credentialKinds) {
      const ref = connection.secrets[kind];
      if (ref === undefined) throw new IntegrationError('secret_not_found');
      values[kind] = await secrets.read(ref);
    }
    return Object.freeze({ values: Object.freeze(values) });
  }

  async function checkPlan(
    tenant: TenantContext,
    organizationId: OrganizationId,
    excluding?: InvoicingConnectionId,
  ): Promise<void> {
    const plan = await entitlements.entitlementsOf(tenant);
    if (plan.status !== 'active') throw new IntegrationError('entitlements_unavailable');
    if (!plan.values['integrations.categoriesAllowed'].includes('invoicing')) {
      throw new IntegrationError('category_not_allowed');
    }
    const limit = plan.values['integrations.connectionsMax'];
    const ours = (await repository.listConnections(organizationId)).filter(
      (c) => c.id !== excluding && occupiesSlot(c),
    ).length;
    const channels = channelSlotsUsed === undefined ? 0 : await channelSlotsUsed(organizationId);
    if (limit !== 'unlimited' && ours + channels + 1 > limit) {
      throw new IntegrationError('limit_reached');
    }
  }

  const connectionEvent = (
    actor: AuditActor,
    c: InvoicingConnection,
    action:
      | 'channel.invoicing_connection_created'
      | 'channel.invoicing_connection_checked'
      | 'channel.invoicing_connection_changed',
    at: Date,
    result: 'success' | 'failure' = 'success',
    reason: string = c.status,
  ) =>
    event(
      {
        action,
        result,
        actor,
        organizationId: c.organizationId,
        target: { type: 'invoicing_connection', id: c.id },
        reference: `provider:${c.provider}`,
        reason: auditCode(reason, 'provider_rejected'),
      },
      at,
    );

  /** One change to a connection of the tenant's organization, by the person, audited with it. */
  async function change(
    tenant: TenantContext,
    permission: string,
    id: string,
    apply: (
      current: InvoicingConnection,
      at: Date,
    ) => {
      readonly next: Partial<
        Pick<InvoicingConnection, 'status' | 'displayName' | 'lastValidatedAt' | 'capabilities'>
      > & { readonly statusReason?: string | undefined };
      readonly action:
        'channel.invoicing_connection_checked' | 'channel.invoicing_connection_changed';
      readonly result?: 'success' | 'failure';
      readonly reason?: string;
    },
  ): Promise<InvoicingConnection> {
    const organizationId = await organizationOf(tenant, permission, true);
    if (!isInvoicingId(id)) throw new IntegrationError('connection_not_found');
    const userId = userOf(tenant);
    return repository.updateConnection(organizationId, id as InvoicingConnectionId, (current) => {
      const at = now();
      const { next, action, result, reason } = apply(current, at);
      const status = next.status ?? current.status;
      if (status !== current.status && !canTransition(current.status, status)) {
        throw new IntegrationError('invalid_transition', `${current.status}->${status}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { statusReason: _dropped, ...rest } = current;
      const { statusReason: asked, ...fields } = next;
      const statusReason = 'statusReason' in next ? asked : current.statusReason;
      const connection: InvoicingConnection = Object.freeze({
        ...rest,
        ...fields,
        status,
        ...(status === 'error' && statusReason !== undefined ? { statusReason } : {}),
        updatedAt: iso(at),
        updatedBy: userId,
        revision: current.revision + 1,
      });
      return {
        connection,
        events: [connectionEvent(actorFor(tenant), connection, action, at, result, reason)],
      };
    });
  }

  /** Ends every sync of a connection that has not ended: it stopped being usable. */
  async function stopSyncs(connection: InvoicingConnection, actor: AuditActor): Promise<void> {
    const jobs = await repository.listJobs(connection.organizationId, {
      connectionId: connection.id,
    });
    for (const job of jobs.filter((j) => !isFinalSync(j))) {
      await finish(job, 'incomplete', actor, { incompleteReason: 'connection_stopped' });
    }
  }

  const moveTo =
    (status: ChannelConnectionStatus) =>
    (current: InvoicingConnection): ReturnType<Parameters<typeof change>[3]> => {
      if (current.status === status) throw new IntegrationError('invalid_transition', status);
      return {
        next: { status, statusReason: undefined },
        action: 'channel.invoicing_connection_changed',
      };
    };

  // Syncs ----------------------------------------------------------------------------------------

  function syncEvent(
    job: InvoicingSyncJob,
    actor: AuditActor,
    action: 'channel.invoicing_sync_started' | 'channel.invoicing_sync_finished',
    at: Date,
    result: 'success' | 'failure',
    reason: string,
  ): AuditEvent {
    return event(
      {
        action,
        result,
        actor,
        organizationId: job.organizationId,
        target: { type: 'invoicing_sync', id: job.id },
        reference: `provider:${job.provider}`,
        reason: auditCode(reason, 'failed'),
      },
      at,
    );
  }

  async function createJob(
    connection: InvoicingConnection,
    input: {
      readonly recordType: InvoicingRecordType;
      readonly trigger: InvoicingSyncTrigger;
      readonly idempotencyKey: string;
      readonly initiatedBy: UserId;
      readonly actor: AuditActor;
      readonly since?: string;
      readonly cursor?: string;
      readonly fileDigest?: string;
      readonly status?: 'queued' | 'running';
    },
  ): Promise<{ job: InvoicingSyncJob; created: boolean }> {
    const at = now();
    const id = newId();
    if (!isInvoicingId(id)) throw new IntegrationError('invalid_connection', 'id');
    const job: InvoicingSyncJob = Object.freeze({
      id: id as InvoicingSyncJobId,
      organizationId: connection.organizationId,
      connectionId: connection.id,
      provider: connection.provider,
      recordType: input.recordType,
      trigger: input.trigger,
      idempotencyKey: input.idempotencyKey,
      initiatedBy: input.initiatedBy,
      status: input.status ?? 'queued',
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.fileDigest === undefined ? {} : { fileDigest: input.fileDigest }),
      attempts: 0,
      counts: EMPTY_COUNTS,
      rejections: [],
      createdAt: iso(at),
      ...(input.status === 'running' ? { startedAt: iso(at) } : {}),
      updatedAt: iso(at),
      revision: 1,
    });
    return repository.createJobOnce({
      job,
      events: [
        syncEvent(job, input.actor, 'channel.invoicing_sync_started', at, 'success', input.trigger),
      ],
    });
  }

  async function finish(
    job: InvoicingSyncJob,
    status: 'completed' | 'incomplete' | 'failed',
    actor: AuditActor,
    extra: {
      readonly incompleteReason?: InvoicingIncompleteReason;
      readonly errorCode?: string;
      readonly counts?: InvoicingSyncCounts;
      readonly rejections?: InvoicingSyncJob['rejections'];
      readonly cursor?: string;
    } = {},
  ): Promise<InvoicingSyncJob> {
    return repository.updateJob(job.organizationId, job.id, (current) => {
      if (isFinalSync(current)) throw new IntegrationError('invalid_transition', current.status);
      const at = now();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { leaseId: _l, leaseUntil: _u, nextAttemptAt: _n, cursor: _c, ...rest } = current;
      const cursor = 'cursor' in extra ? extra.cursor : current.cursor;
      const next: InvoicingSyncJob = Object.freeze({
        ...rest,
        status,
        ...(extra.incompleteReason === undefined
          ? {}
          : { incompleteReason: extra.incompleteReason }),
        ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
        // A stopped sync keeps where it stopped, so it can resume there.
        ...(status !== 'completed' && cursor !== undefined ? { cursor } : {}),
        counts: extra.counts ?? current.counts,
        rejections: extra.rejections ?? current.rejections,
        finishedAt: iso(at),
        updatedAt: iso(at),
        revision: current.revision + 1,
      });
      const reason =
        status === 'completed'
          ? 'completed'
          : status === 'incomplete'
            ? (extra.incompleteReason ?? 'incomplete')
            : auditCode(extra.errorCode, 'failed');
      return {
        job: next,
        events: [
          syncEvent(
            next,
            actor,
            'channel.invoicing_sync_finished',
            at,
            status === 'failed' ? 'failure' : 'success',
            reason,
          ),
        ],
      };
    });
  }

  /** Builds the stored form of one normalized record, or keeps the stored one when unchanged. */
  function buildRecord(
    connection: InvoicingConnection,
    job: InvoicingSyncJob,
    record: NormalizedInvoicingRecord,
    existing: StoredInvoicingRecord | undefined,
    at: Date,
  ): StoredInvoicingRecord {
    const digest = digestOf(record.original.content);
    if (existing !== undefined && existing.record.source.originalDigest === digest) return existing;
    const source: InvoicingSource = Object.freeze({
      connectionId: connection.id,
      provider: connection.provider,
      externalId: record.externalId,
      originalFormat: record.original.format,
      originalDigest: digest,
      originalBytes: Buffer.byteLength(record.original.content),
      syncJobId: job.id,
      readAt: iso(at),
    });
    const id = (existing?.record.id ?? newId()) as InvoicingRecordId;
    const revision = (existing?.record.revision ?? 0) + 1;
    const organizationId = connection.organizationId;
    // The adapter's copy of the original is not kept (ADR-0193): only its digest, format and size.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { original: _o, externalId: _e, recordType: _t, ...fields } = record;
    if (record.recordType === 'party') {
      const party: InvoicingParty = Object.freeze({
        ...(fields as Omit<typeof record, 'original' | 'externalId' | 'recordType'>),
        id,
        organizationId,
        source,
        revision,
      });
      return { recordType: 'party', record: party };
    }
    if (record.recordType === 'payment') {
      const payment: InvoicingPayment = Object.freeze({
        ...(fields as Omit<typeof record, 'original' | 'externalId' | 'recordType'>),
        id,
        organizationId,
        source,
        revision,
      });
      return { recordType: 'payment', record: payment };
    }
    const previous = existing?.recordType === 'document' ? existing.record : undefined;
    const document: FiscalDocument = Object.freeze({
      ...(fields as Omit<typeof record, 'original' | 'externalId' | 'recordType'>),
      id,
      organizationId,
      jurisdiction: connection.jurisdiction,
      // Recomputed from confirmed payments, never taken from the document.
      confirmedPaid: previous?.confirmedPaid ?? { value: '0', currency: record.currency },
      ...(record.authorityStatus === 'not_reported' ? {} : { authorityCheckedAt: iso(at) }),
      source,
      revision,
    });
    return { recordType: 'document', record: document };
  }

  /** Recomputes a document's confirmed total from the confirmed payments that apply to it. */
  async function refreshConfirmedPaid(
    connection: InvoicingConnection,
    documentExternalId: string,
  ): Promise<void> {
    const key = {
      connectionId: connection.id,
      recordType: 'document' as const,
      externalId: documentExternalId,
    };
    const stored = await repository.findRecord(connection.organizationId, key);
    if (stored?.recordType !== 'document') return;
    const doc = stored.record;
    const payments = await repository.paymentsFor(
      connection.organizationId,
      connection.id,
      documentExternalId,
    );
    const applied = payments
      .filter((p) => p.status === 'confirmed')
      .flatMap((p) => p.appliesTo.filter((a) => a.externalId === documentExternalId))
      .map((a) => a.amount)
      .filter((a) => a.currency === doc.currency);
    const confirmedPaid = sumAmounts(applied, doc.currency);
    if (confirmedPaid.value === doc.confirmedPaid.value) return;
    await repository.upsertRecord(
      connection.organizationId,
      () => ({
        recordType: 'document',
        record: Object.freeze({ ...doc, confirmedPaid, revision: doc.revision + 1 }),
      }),
      key,
    );
  }

  /** Keeps one page: each record checked, stored or refused. Returns the new counts. */
  async function keepPage(
    connection: InvoicingConnection,
    job: InvoicingSyncJob,
    page: InvoicingPage,
    counts: InvoicingSyncCounts,
    rejections: InvoicingSyncJob['rejections'][number][],
  ): Promise<InvoicingSyncCounts> {
    let { created, updated, unchanged, rejected, recordsSeen } = counts;
    const touchedDocuments = new Set<string>();
    for (const record of page.records) {
      recordsSeen += 1;
      try {
        checkNormalizedRecord(record, job.recordType);
      } catch (error) {
        rejected += 1;
        if (rejections.length < MAX_REJECTIONS) {
          rejections.push({
            recordType: job.recordType,
            externalId:
              typeof record?.externalId === 'string' && record.externalId.length <= 128
                ? record.externalId
                : 'unknown',
            code: isIntegrationError(error) ? (error.detail ?? error.code) : 'invalid_payload',
          });
        }
        continue;
      }
      const at = now();
      let previous: StoredInvoicingRecord | undefined;
      const { outcome }: { outcome: UpsertOutcome } = await repository.upsertRecord(
        connection.organizationId,
        (existing) => {
          previous = existing;
          return buildRecord(connection, job, record, existing, at);
        },
        { connectionId: connection.id, recordType: job.recordType, externalId: record.externalId },
      );
      if (outcome === 'created') created += 1;
      else if (outcome === 'updated') updated += 1;
      else unchanged += 1;
      if (record.recordType === 'payment' && outcome !== 'unchanged') {
        for (const a of record.appliesTo) touchedDocuments.add(a.externalId);
        // A document the payment no longer applies to loses its share too.
        const before = previous as StoredInvoicingRecord | undefined;
        if (before?.recordType === 'payment') {
          for (const a of before.record.appliesTo) touchedDocuments.add(a.externalId);
        }
      }
      if (record.recordType === 'document' && outcome !== 'unchanged') {
        touchedDocuments.add(record.externalId);
      }
    }
    for (const externalId of touchedDocuments) await refreshConfirmedPaid(connection, externalId);
    return {
      ...counts,
      recordsSeen,
      created,
      updated,
      unchanged,
      rejected,
      bytesRead: counts.bytesRead + page.bytes,
    };
  }

  /** Moves a record type's watermark: only after a sync read every page. */
  async function advanceWatermark(
    connection: InvoicingConnection,
    job: InvoicingSyncJob,
    watermark: string | undefined,
  ): Promise<void> {
    await repository.updateConnection(connection.organizationId, connection.id, (current) => {
      const at = now();
      const state = current.syncState[job.recordType] ?? {};
      const connection2: InvoicingConnection = Object.freeze({
        ...current,
        syncState: Object.freeze({
          ...current.syncState,
          [job.recordType]: Object.freeze({
            ...state,
            ...(watermark === undefined ? {} : { watermark }),
            lastCompleteAt: iso(at),
            lastSyncJobId: job.id,
          }),
        }),
        updatedAt: iso(at),
        revision: current.revision + 1,
      });
      return { connection: connection2, events: [] };
    });
  }

  async function connectionForSync(
    tenant: TenantContext,
    id: unknown,
    permission: string,
  ): Promise<InvoicingConnection> {
    const organizationId = await organizationOf(tenant, permission, true);
    const connection = isInvoicingId(id)
      ? await repository.findConnection(organizationId, id as InvoicingConnectionId)
      : undefined;
    if (connection === undefined) throw new IntegrationError('connection_not_found');
    if (connection.status === 'revoked') throw new IntegrationError('connection_revoked');
    if (connection.status !== 'connected') throw new IntegrationError('connection_disabled');
    return connection;
  }

  return {
    async listConnections(tenant) {
      const organizationId = await organizationOf(tenant, 'channel.read', false);
      return repository.listConnections(organizationId);
    },

    async getConnection(tenant, id) {
      const organizationId = await organizationOf(tenant, 'channel.read', false);
      const connection = isInvoicingId(id)
        ? await repository.findConnection(organizationId, id as InvoicingConnectionId)
        : undefined;
      if (connection === undefined) throw new IntegrationError('connection_not_found');
      return connection;
    },

    async createConnection(tenant, input) {
      const organizationId = await organizationOf(tenant, 'channel.create', true);
      const adapter =
        typeof input.provider === 'string' ? registry.findInvoicing(input.provider) : undefined;
      if (adapter === undefined) throw new IntegrationError('invalid_connection', 'provider');
      // A provider read with credentials needs somewhere to keep them; a file import does not.
      if (secretProjectId === undefined && adapter.credentialKinds.length > 0) {
        throw new IntegrationError('secret_unavailable');
      }
      const displayName = checkName(input.displayName);
      if (typeof input.jurisdiction !== 'string' || !COUNTRY.test(input.jurisdiction)) {
        throw new IntegrationError('invalid_connection', 'jurisdiction');
      }
      if (!adapter.jurisdictions.includes(input.jurisdiction)) {
        throw new IntegrationError('invalid_connection', 'jurisdiction');
      }
      // Defense in depth: a secret is never accepted here, whatever the adapter would allow.
      if (
        typeof input.account === 'object' &&
        input.account !== null &&
        Object.keys(input.account).some((k) => SECRET_LIKE.test(k))
      ) {
        throw new IntegrationError('invalid_connection', 'account.secret');
      }
      const account = adapter.checkAccount(input.account);
      const accountId = adapter.accountIdOf(account);
      const existing = await repository.listConnections(organizationId);
      if (
        existing.some(
          (c) =>
            c.provider === adapter.provider &&
            c.status !== 'revoked' &&
            adapter.accountIdOf(c.account) === accountId,
        )
      ) {
        throw new IntegrationError('invalid_connection', 'account.duplicate');
      }
      await checkPlan(tenant, organizationId);
      const at = now();
      const id = newId();
      if (!isInvoicingId(id)) throw new IntegrationError('invalid_connection', 'id');
      const userId = userOf(tenant);
      const connection: InvoicingConnection = Object.freeze({
        id: id as InvoicingConnectionId,
        organizationId,
        provider: adapter.provider,
        category: 'invoicing',
        jurisdiction: input.jurisdiction,
        status: 'created',
        displayName,
        account,
        capabilities: adapter.capabilities,
        secrets: Object.freeze(
          Object.fromEntries(
            adapter.credentialKinds.map((kind) => [
              kind,
              invoicingSecretRefFor(secretProjectId as string, id, kind),
            ]),
          ),
        ),
        syncState: Object.freeze({}),
        createdAt: iso(at),
        createdBy: userId,
        updatedAt: iso(at),
        updatedBy: userId,
        revision: 1,
      });
      await repository.createConnection({
        connection,
        events: [
          connectionEvent(actorFor(tenant), connection, 'channel.invoicing_connection_created', at),
        ],
      });
      return connection;
    },

    async connect(tenant, id) {
      const organizationId = await organizationOf(tenant, 'channel.update', true);
      const current = isInvoicingId(id)
        ? await repository.findConnection(organizationId, id as InvoicingConnectionId)
        : undefined;
      if (current === undefined) throw new IntegrationError('connection_not_found');
      if (current.status === 'revoked') throw new IntegrationError('connection_revoked');
      if (current.status === 'disconnected') await checkPlan(tenant, organizationId, current.id);
      const connecting = await change(tenant, 'channel.update', id, () => ({
        next: { status: 'connecting', statusReason: undefined },
        action: 'channel.invoicing_connection_changed',
      }));
      let check: ConnectionCheck;
      try {
        const adapter = adapterOf(connecting);
        check = await adapter.validateConnection(
          connecting,
          await credentialsOf(connecting, adapter),
        );
      } catch (error) {
        check = {
          status: 'unavailable',
          code: isIntegrationError(error) ? error.code : 'provider_unavailable',
        };
      }
      return change(tenant, 'channel.update', id, (latest, at) => {
        if (latest.status !== 'connecting' || latest.revision !== connecting.revision) {
          throw new IntegrationError('invalid_transition', 'concurrent_change');
        }
        const adapter = registry.findInvoicing(latest.provider);
        return check.status === 'valid'
          ? {
              next: {
                status: 'connected',
                statusReason: undefined,
                lastValidatedAt: iso(at),
                ...(adapter === undefined ? {} : { capabilities: adapter.capabilities }),
              },
              action: 'channel.invoicing_connection_checked',
              reason: 'connected',
            }
          : {
              next: { status: 'error', statusReason: auditCode(check.code, 'provider_rejected') },
              action: 'channel.invoicing_connection_checked',
              result: 'failure',
              reason: check.code,
            };
      });
    },

    rename(tenant, id, displayName) {
      const name = checkName(displayName);
      return change(tenant, 'channel.update', id, (current) => {
        if (current.status === 'revoked') throw new IntegrationError('connection_revoked');
        return {
          next: { displayName: name },
          action: 'channel.invoicing_connection_changed',
          reason: 'renamed',
        };
      });
    },

    async pause(tenant, id) {
      const connection = await change(tenant, 'channel.update', id, moveTo('paused'));
      await stopSyncs(connection, actorFor(tenant));
      return connection;
    },

    async disconnect(tenant, id) {
      const connection = await change(tenant, 'channel.disconnect', id, moveTo('disconnected'));
      await stopSyncs(connection, actorFor(tenant));
      const adapter = registry.findInvoicing(connection.provider);
      if (adapter?.capabilities.revokeOnDisconnect === true && adapter.revokeAccess !== undefined) {
        try {
          await adapter.revokeAccess(connection, await credentialsOf(connection, adapter));
        } catch {
          // The connection is off either way; revoking at the provider is best effort, and the
          // owner can revoke there too. Nothing more is read from it.
        }
      }
      return connection;
    },

    async revoke(tenant, id) {
      const connection = await change(tenant, 'channel.delete', id, moveTo('revoked'));
      await stopSyncs(connection, actorFor(tenant));
      return connection;
    },

    async startSync(tenant, input) {
      const connection = await connectionForSync(tenant, input.connectionId, 'invoicing.sync');
      if (!isInvoicingRecordType(input.recordType)) {
        throw new IntegrationError('invalid_payload', 'recordType');
      }
      // A provider read only from exported files has no sync: its files are imported.
      if (!connection.capabilities.listing)
        throw new IntegrationError('capability_missing', 'listing');
      if (!connection.capabilities.records.includes(input.recordType)) {
        throw new IntegrationError('capability_missing', input.recordType);
      }
      if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
        throw new IntegrationError('invalid_payload', 'idempotencyKey');
      }
      const key = `manual:${input.idempotencyKey}`;
      const active = await repository.activeJob(
        connection.organizationId,
        connection.id,
        input.recordType,
      );
      if (active !== undefined) {
        if (active.idempotencyKey === key) return active;
        throw new IntegrationError('sync_in_progress');
      }
      const watermark = connection.syncState[input.recordType]?.watermark;
      const since =
        input.full !== true && connection.capabilities.incrementalSync ? watermark : undefined;
      const { job } = await createJob(connection, {
        recordType: input.recordType,
        trigger: 'manual',
        idempotencyKey: key,
        initiatedBy: userOf(tenant),
        actor: actorFor(tenant),
        ...(since === undefined ? {} : { since }),
      });
      return job;
    },

    async resumeSync(tenant, jobId) {
      const organizationId = await organizationOf(tenant, 'invoicing.sync', true);
      const previous = isInvoicingId(jobId)
        ? await repository.findJob(organizationId, jobId as InvoicingSyncJobId)
        : undefined;
      if (previous === undefined) throw new IntegrationError('sync_not_found');
      if (
        previous.status !== 'incomplete' ||
        previous.incompleteReason === 'records_rejected' ||
        previous.cursor === undefined
      ) {
        throw new IntegrationError('sync_not_resumable');
      }
      const connection = await connectionForSync(tenant, previous.connectionId, 'invoicing.sync');
      const active = await repository.activeJob(organizationId, connection.id, previous.recordType);
      const key = `resume:${previous.id}`;
      if (active !== undefined) {
        if (active.idempotencyKey === key) return active;
        throw new IntegrationError('sync_in_progress');
      }
      const { job } = await createJob(connection, {
        recordType: previous.recordType,
        trigger: previous.trigger === 'file_import' ? 'manual' : previous.trigger,
        idempotencyKey: key,
        initiatedBy: userOf(tenant),
        actor: actorFor(tenant),
        ...(previous.since === undefined ? {} : { since: previous.since }),
        cursor: previous.cursor,
      });
      return job;
    },

    async runSync(organizationId, jobId, workerId) {
      const at = now();
      const leaseId = `${workerId}:${newId()}`;
      let job = await repository.findJob(organizationId, jobId);
      if (job === undefined) throw new IntegrationError('sync_not_found');
      // A file import runs once, inside `importFile`; an ended sync never runs again.
      if (job.trigger === 'file_import' || isFinalSync(job)) return { job, again: false };
      const runtime = runtimeFor(job.initiatedBy);
      // Take the lease: a queued sync whose time has come, or one whose lease ran out.
      job = await repository.updateJob(organizationId, jobId, (current) => {
        const due =
          (current.status === 'queued' &&
            (current.nextAttemptAt === undefined || current.nextAttemptAt <= iso(at))) ||
          (current.status === 'running' &&
            (current.leaseUntil === undefined || current.leaseUntil <= iso(at)));
        if (!due) throw new IntegrationError('sync_in_progress');
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { nextAttemptAt: _n, ...rest } = current;
        return {
          job: Object.freeze({
            ...rest,
            status: 'running',
            leaseId,
            leaseUntil: iso(new Date(at.getTime() + limits.leaseMs)),
            startedAt: current.startedAt ?? iso(at),
            updatedAt: iso(at),
            revision: current.revision + 1,
          }),
          events: [],
        };
      });

      let counts = job.counts;
      const rejections = [...job.rejections];
      let cursor = job.cursor;
      let nextWatermark = job.nextWatermark;
      for (let page = 0; page < limits.pagesPerRun; page += 1) {
        // Ended meanwhile (the connection was turned off): its end stands.
        const latest = await repository.findJob(organizationId, job.id);
        if (latest === undefined || isFinalSync(latest) || latest.leaseId !== leaseId) {
          return { job: latest ?? job, again: false };
        }
        const connection = await repository.findConnection(organizationId, job.connectionId);
        if (connection === undefined || connection.status !== 'connected') {
          return {
            job: await finish(job, 'incomplete', runtime, {
              incompleteReason: 'connection_stopped',
              counts,
              rejections,
              ...(cursor === undefined ? {} : { cursor }),
            }),
            again: false,
          };
        }
        if (counts.pagesRead >= limits.pagesPerSync) {
          return {
            job: await finish(job, 'incomplete', runtime, {
              incompleteReason: 'pages_remaining',
              counts,
              rejections,
              ...(cursor === undefined ? {} : { cursor }),
            }),
            again: false,
          };
        }
        let result: InvoicingPage;
        try {
          const adapter = adapterOf(connection);
          if (adapter.listPage === undefined) {
            throw new IntegrationError('provider_rejected', 'listing_not_supported');
          }
          counts = { ...counts, providerCalls: counts.providerCalls + 1 };
          result = await adapter.listPage(connection, await credentialsOf(connection, adapter), {
            recordType: job.recordType,
            ...(cursor === undefined ? {} : { cursor }),
            ...(job.since === undefined ? {} : { since: job.since }),
            pageSize: Math.min(limits.pageSize, connection.capabilities.maxPageSize),
            timeoutMs: limits.callTimeoutMs,
          });
        } catch (error) {
          const code = isIntegrationError(error) ? error.code : 'provider_unavailable';
          const detail = isIntegrationError(error) ? error.detail : undefined;
          if (code === 'provider_unavailable' || code === 'secret_unavailable') {
            const attempts = job.attempts + 1;
            if (attempts >= limits.maxAttempts) {
              return {
                job: await finish(job, 'incomplete', runtime, {
                  incompleteReason: 'retries_exhausted',
                  errorCode: auditCode(detail, code),
                  counts,
                  rejections,
                  ...(cursor === undefined ? {} : { cursor }),
                }),
                again: false,
              };
            }
            const wait = backoffDelay(
              {
                maxAttempts: limits.maxAttempts,
                baseDelayMs: limits.baseDelayMs,
                maxDelayMs: limits.maxDelayMs,
                totalBudgetMs: Number.MAX_SAFE_INTEGER,
                minAttemptMs: 0,
              },
              attempts,
              random,
              isIntegrationError(error) ? error.retryAfterMs : undefined,
            );
            const later = now();
            job = await repository.updateJob(organizationId, job.id, (current) => {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { leaseId: _l, leaseUntil: _u, cursor: _c, ...rest } = current;
              return {
                job: Object.freeze({
                  ...rest,
                  status: 'queued',
                  attempts,
                  errorCode: auditCode(detail, code),
                  nextAttemptAt: iso(new Date(later.getTime() + wait)),
                  counts,
                  rejections,
                  ...(cursor === undefined ? {} : { cursor }),
                  updatedAt: iso(later),
                  revision: current.revision + 1,
                }),
                events: [],
              };
            });
            return { job, again: true };
          }
          // Refused: credentials, account or request. Nothing more can be read until a person
          // checks the connection again.
          return {
            job: await finish(job, 'failed', runtime, {
              errorCode: auditCode(detail, code),
              counts,
              rejections,
              ...(cursor === undefined ? {} : { cursor }),
            }),
            again: false,
          };
        }
        counts = await keepPage(
          connection,
          job,
          result,
          { ...counts, pagesRead: counts.pagesRead + 1 },
          rejections,
        );
        cursor = result.nextCursor;
        if (result.watermark !== undefined) nextWatermark = result.watermark;
        if (cursor === undefined) {
          // Every page read: the watermark moves, even if some records were refused (they are
          // listed on the sync, and a full sync reads them again).
          await advanceWatermark(connection, job, nextWatermark);
          return {
            job: await finish(job, counts.rejected === 0 ? 'completed' : 'incomplete', runtime, {
              ...(counts.rejected === 0 ? {} : { incompleteReason: 'records_rejected' as const }),
              counts,
              rejections,
            }),
            again: false,
          };
        }
        // Progress is kept page by page, so a lost worker loses at most one page of work.
        const progress = now();
        job = await repository.updateJob(organizationId, job.id, (current) => {
          if (current.leaseId !== leaseId) throw new IntegrationError('sync_in_progress');
          return {
            job: Object.freeze({
              ...current,
              attempts: 0,
              counts,
              rejections: [...rejections],
              cursor: cursor as string,
              ...(nextWatermark === undefined ? {} : { nextWatermark }),
              leaseUntil: iso(new Date(progress.getTime() + limits.leaseMs)),
              updatedAt: iso(progress),
              revision: current.revision + 1,
            }),
            events: [],
          };
        });
      }
      // This run's share is done: give the lease back for the next run.
      const released = now();
      job = await repository.updateJob(organizationId, job.id, (current) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { leaseId: _l, leaseUntil: _u, ...rest } = current;
        return {
          job: Object.freeze({
            ...rest,
            status: 'queued',
            nextAttemptAt: iso(released),
            updatedAt: iso(released),
            revision: current.revision + 1,
          }),
          events: [],
        };
      });
      return { job, again: true };
    },

    async receiveWebhook(connectionId, rawBody, headers) {
      const refused = { accepted: false, jobs: [] } as const;
      if (!isInvoicingId(connectionId)) return refused;
      const connection = await repository.findConnectionForWebhook(
        connectionId as InvoicingConnectionId,
      );
      if (
        connection === undefined ||
        !acceptsInbound(connection) ||
        !connection.capabilities.webhooks
      ) {
        return refused;
      }
      const adapter = registry.findInvoicing(connection.provider);
      if (adapter?.verifyWebhook === undefined || adapter.parseWebhook === undefined) {
        return refused;
      }
      const ref = connection.secrets.webhook_secret;
      if (ref === undefined) return refused;
      let secret: string;
      try {
        secret = await secrets.read(ref);
      } catch {
        throw new IntegrationError('secret_unavailable');
      }
      if (!adapter.verifyWebhook(rawBody, headers, secret)) {
        throw new IntegrationError('invalid_signature');
      }
      const hint = adapter.parseWebhook(rawBody);
      if (typeof hint.eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(hint.eventId)) {
        throw new IntegrationError('invalid_payload', 'eventId');
      }
      // Paused or in error: the event is acknowledged, nothing is read until it is connected.
      if (connection.status !== 'connected') return { accepted: true, jobs: [] };
      const jobs: InvoicingSyncJob[] = [];
      for (const recordType of new Set(hint.recordTypes)) {
        if (!connection.capabilities.records.includes(recordType)) continue;
        const key = `webhook:${hint.eventId}:${recordType}`;
        const active = await repository.activeJob(
          connection.organizationId,
          connection.id,
          recordType,
        );
        // A sync already under way reads the change too; the event adds nothing.
        if (active !== undefined) continue;
        const since = connection.capabilities.incrementalSync
          ? connection.syncState[recordType]?.watermark
          : undefined;
        try {
          const { job } = await createJob(connection, {
            recordType,
            trigger: 'webhook',
            idempotencyKey: key,
            initiatedBy: connection.createdBy,
            actor: runtimeFor(connection.createdBy),
            ...(since === undefined ? {} : { since }),
          });
          jobs.push(job);
        } catch (error) {
          // Another sync started meanwhile: it reads the change too.
          if (isIntegrationError(error) && error.code === 'sync_in_progress') continue;
          throw error;
        }
      }
      return { accepted: true, jobs };
    },

    async importFile(tenant, input) {
      const connection = await connectionForSync(tenant, input.connectionId, 'invoicing.sync');
      if (!isInvoicingFileFormat(input.format)) {
        throw new IntegrationError('invalid_file', 'format');
      }
      const format: InvoicingFileFormat = input.format;
      if (!connection.capabilities.fileImport.includes(format)) {
        throw new IntegrationError('capability_missing', format);
      }
      if (!isInvoicingRecordType(input.recordType)) {
        throw new IntegrationError('invalid_payload', 'recordType');
      }
      const recordType: InvoicingRecordType = input.recordType;
      if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0) {
        throw new IntegrationError('invalid_file', 'empty');
      }
      if (input.content.byteLength > limits.maxFileBytes) {
        throw new IntegrationError('file_too_large');
      }
      const adapter = adapterOf(connection);
      if (adapter.readFile === undefined) throw new IntegrationError('capability_missing', format);
      const fileDigest = digestOf(input.content);
      const { job, created } = await createJob(connection, {
        recordType,
        trigger: 'file_import',
        idempotencyKey: `file:${recordType}:${fileDigest}`,
        initiatedBy: userOf(tenant),
        actor: actorFor(tenant),
        fileDigest,
        status: 'running',
      });
      // The same file again: the import it already made.
      if (!created) return job;
      let page: InvoicingPage;
      try {
        page = adapter.readFile(format, input.content, connection.account);
      } catch (error) {
        return finish(job, 'failed', actorFor(tenant), {
          errorCode: auditCode(
            isIntegrationError(error) ? error.detail : undefined,
            'invalid_file',
          ),
        });
      }
      const rejections: InvoicingSyncJob['rejections'][number][] = [];
      const counts = await keepPage(
        connection,
        job,
        { ...page, bytes: input.content.byteLength },
        { ...EMPTY_COUNTS, pagesRead: 1 },
        rejections,
      );
      return finish(job, counts.rejected === 0 ? 'completed' : 'incomplete', actorFor(tenant), {
        ...(counts.rejected === 0 ? {} : { incompleteReason: 'records_rejected' as const }),
        counts,
        rejections,
      });
    },

    async getSync(tenant, jobId) {
      const organizationId = await organizationOf(tenant, 'invoicing.read', false);
      const job = isInvoicingId(jobId)
        ? await repository.findJob(organizationId, jobId as InvoicingSyncJobId)
        : undefined;
      if (job === undefined) throw new IntegrationError('sync_not_found');
      return job;
    },

    async listSyncs(tenant, filter = {}) {
      const organizationId = await organizationOf(tenant, 'invoicing.read', false);
      if (filter.connectionId !== undefined && !isInvoicingId(filter.connectionId)) return [];
      return repository.listJobs(organizationId, {
        ...(filter.connectionId === undefined
          ? {}
          : { connectionId: filter.connectionId as InvoicingConnectionId }),
        ...(filter.from === undefined ? {} : { from: filter.from }),
      });
    },

    async listRecords(tenant, filter) {
      const organizationId = await organizationOf(tenant, 'invoicing.read', false);
      if (!isInvoicingRecordType(filter.recordType)) {
        throw new IntegrationError('invalid_payload', 'recordType');
      }
      if (filter.connectionId !== undefined && !isInvoicingId(filter.connectionId)) {
        return { items: [] };
      }
      return repository.listRecords(organizationId, {
        recordType: filter.recordType,
        ...(filter.connectionId === undefined
          ? {}
          : { connectionId: filter.connectionId as InvoicingConnectionId }),
        pageSize: filter.pageSize ?? 50,
        ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      });
    },
  };
}
