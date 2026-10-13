import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import type {
  InitialBilling,
  IntegrationProviderId,
  InvoicingConnection,
  InvoicingSyncJob,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { defaultValues, type EntitlementService } from '@melonoffice/entitlements';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntegrationError } from '../errors.js';
import { createIntegrationRegistry } from '../registry.js';
import {
  InMemorySecretStore,
  invoicingSecretRefFor,
  isInvoicingSecretRef,
  isSecretRef,
} from '../secrets.js';
import { checkInvoicingAdapter, type NormalizedInvoicingRecord } from './contract.js';
import { checkInvoicingAdapterContract } from './contract-suite.js';
import { createInvoicingDouble, DOUBLE_TOKEN, signDoubleWebhook } from './double.js';
import { createInvoicingGateway, type InvoicingLimits } from './gateway.js';
import { estimateCost, usageOf } from './metrics.js';
import { sumAmounts } from './model.js';
import { isValidRuc, peConsultaStatus, peDocumentType } from './pe/sunat.js';
import { InMemoryInvoicingRepository } from './store.js';

const T0 = Date.parse('2026-10-13T00:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const PROJECT = 'melonoffice-test';
// Test values only: stand-ins for what Secret Manager would hold.
const WEBHOOK_SECRET = 'test-webhook-secret-value';

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

const original = (id: string, extra = '') => ({
  format: 'provider_json',
  content: JSON.stringify({ id, extra }),
});

const invoice = (
  n: number,
  overrides: Partial<Extract<NormalizedInvoicingRecord, { recordType: 'document' }>> = {},
): NormalizedInvoicingRecord => ({
  recordType: 'document',
  externalId: `F001-${String(n).padStart(4, '0')}`,
  original: original(`F001-${n}`, JSON.stringify(overrides)),
  direction: 'issued',
  type: 'invoice',
  sourceType: '01',
  series: 'F001',
  number: String(n),
  issueDate: '2026-10-01',
  issuer: { taxId: { scheme: 'PE:RUC', value: '20131312955' }, legalName: 'Emisor SAC' },
  counterparty: { taxId: { scheme: 'PE:RUC', value: '20100176450' }, legalName: 'Cliente SA' },
  currency: 'PEN',
  netTotal: { value: '100.00', currency: 'PEN' },
  taxTotal: { value: '18.00', currency: 'PEN' },
  total: { value: '118.00', currency: 'PEN' },
  lines: [
    {
      position: 1,
      description: 'Servicio',
      quantity: '1',
      unitPrice: { value: '100.0000000001', currency: 'PEN' },
      net: { value: '100.00', currency: 'PEN' },
      tax: { value: '18.00', currency: 'PEN' },
      taxCategory: '10',
    },
  ],
  relations: [],
  authorityStatus: 'accepted',
  authorityStatusCode: 'sunat_cp:1',
  voidStatus: 'none',
  ...overrides,
});

const payment = (
  id: string,
  status: 'recorded' | 'confirmed' | 'reversed',
  amount: string,
  doc: string,
): NormalizedInvoicingRecord => ({
  recordType: 'payment',
  externalId: id,
  original: original(id, status),
  status,
  amount: { value: amount, currency: 'PEN' },
  paidOn: '2026-10-05',
  appliesTo: [{ externalId: doc, amount: { value: amount, currency: 'PEN' } }],
});

async function world(
  options: {
    limit?: number | 'unlimited';
    categories?: string[];
    channelSlots?: number;
    limits?: Partial<InvoicingLimits>;
  } = {},
) {
  let clock = T0;
  const now = () => new Date(clock);
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(now, audit);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const double = createInvoicingDouble();
  const registry = createIntegrationRegistry([], { invoicing: [double.adapter] });
  const repository = new InMemoryInvoicingRepository(audit);
  const secrets = new InMemorySecretStore(isInvoicingSecretRef);
  const entitlements: Pick<EntitlementService, 'entitlementsOf'> = {
    entitlementsOf: async (tenant) => ({
      status: 'active',
      organizationId: tenant.organizationId as OrganizationId,
      plan: { id: 'test-plan', version: 1 },
      values: {
        ...defaultValues(),
        'integrations.categoriesAllowed': options.categories ?? ['invoicing'],
        'integrations.connectionsMax': options.limit ?? 2,
      },
    }),
  };
  let ids = 0;
  const gateway = createInvoicingGateway({
    repository,
    registry,
    secrets,
    organizations: tenancy,
    authorization: createAuthorizationService(),
    entitlements,
    channelSlotsUsed: async () => options.channelSlots ?? 0,
    secretProjectId: PROJECT,
    limits: {
      pagesPerRun: 2,
      pageSize: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      ...options.limits,
    },
    now,
    random: () => 1,
    newId: () => `eeeeeeee-eeee-4eee-8eee-${String(++ids).padStart(12, '0')}`,
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const putSecrets = (connectionId: string, token = DOUBLE_TOKEN) => {
    secrets.put(invoicingSecretRefFor(PROJECT, connectionId, 'api_token'), token);
    secrets.put(invoicingSecretRefFor(PROJECT, connectionId, 'webhook_secret'), WEBHOOK_SECRET);
  };
  /** A connected connection of organization A. */
  const connected = async (token = DOUBLE_TOKEN): Promise<InvoicingConnection> => {
    const c = await gateway.createConnection(tenantA, {
      provider: 'double_invoicing',
      displayName: 'Facturación',
      account: { taxId: '20131312955' },
      jurisdiction: 'PE',
    });
    putSecrets(c.id, token);
    return gateway.connect(tenantA, c.id);
  };
  /** Runs a sync until it ends, moving the clock to each retry. */
  const runToEnd = async (job: InvoicingSyncJob, maxRuns = 20): Promise<InvoicingSyncJob> => {
    let current = job;
    for (let i = 0; i < maxRuns; i += 1) {
      if (current.nextAttemptAt !== undefined) {
        clock = Math.max(clock, Date.parse(current.nextAttemptAt));
      }
      const result = await gateway.runSync(current.organizationId, current.id, 'worker-1');
      current = result.job;
      if (!result.again) return current;
    }
    return current;
  };
  return {
    audit,
    double,
    gateway,
    repository,
    secrets,
    tenantA,
    tenantB,
    orgA: a.organization.id,
    orgB: b.organization.id,
    connected,
    runToEnd,
    tick: (ms: number) => {
      clock += ms;
    },
    giaA: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
  };
}

const auditOf = (w: Awaited<ReturnType<typeof world>>) =>
  w.audit.query({
    organizationId: w.orgA,
    actions: [
      'channel.invoicing_connection_created',
      'channel.invoicing_connection_checked',
      'channel.invoicing_connection_changed',
      'channel.invoicing_sync_started',
      'channel.invoicing_sync_finished',
    ],
    from: new Date(0),
    to: new Date(T0 + 365 * 86_400_000),
    limit: 500,
  });

describe('contract', () => {
  it('the double passes the contract suite', async () => {
    const { adapter, put } = createInvoicingDouble();
    for (let n = 1; n <= 5; n += 1) put(invoice(n), n);
    put(payment('P-1', 'confirmed', '118.00', 'F001-0001'), 6);
    put(
      {
        recordType: 'party',
        externalId: 'C-1',
        original: original('C-1'),
        legalName: 'Cliente SA',
        roles: ['customer'],
        taxId: { scheme: 'PE:RUC', value: '20100176450' },
      },
      7,
    );
    const body = JSON.stringify({ id: 'evt-1', types: ['document'] });
    const problems = await checkInvoicingAdapterContract(adapter, {
      connection: {} as InvoicingConnection,
      credentials: { values: { api_token: DOUBLE_TOKEN } },
      refusedCredentials: { values: { api_token: 'wrong' } },
      account: { taxId: '20131312955' },
      webhook: {
        rawBody: body,
        headers: signDoubleWebhook(body, WEBHOOK_SECRET),
        secret: WEBHOOK_SECRET,
      },
    });
    expect(problems).toEqual([]);
  });

  it('the suite finds what a wrong adapter does', async () => {
    const { adapter, put } = createInvoicingDouble();
    put(invoice(1, { total: { value: '1.5e3', currency: 'PEN' } }), 1);
    const loose = { ...adapter, checkAccount: (v: unknown) => v as Record<string, string> };
    const problems = await checkInvoicingAdapterContract(loose, {
      connection: {} as InvoicingConnection,
      credentials: { values: { api_token: DOUBLE_TOKEN } },
      refusedCredentials: { values: { api_token: 'wrong' } },
      account: { taxId: '20131312955' },
    });
    expect(problems).toContain('checkAccount accepts password');
    expect(problems).toContain('checkAccount accepts claveSol');
    expect(problems).toContain('document: invalid record (total)');
  });

  it('refuses an adapter that could write, or declares writing', () => {
    const { adapter } = createInvoicingDouble();
    const issuing = { ...adapter, issueDocument: async () => undefined };
    expect(() => checkInvoicingAdapter(issuing)).toThrow(/unknown member issueDocument/);
    const declares = {
      ...adapter,
      capabilities: { ...adapter.capabilities, write: ['void'] as unknown as [] },
    };
    expect(() => checkInvoicingAdapter(declares)).toThrow(/capabilities/);
    expect(() => createIntegrationRegistry([], { invoicing: [issuing] })).toThrow();
  });

  it('refuses webhooks without a way to verify them, and one provider id twice', () => {
    const { adapter } = createInvoicingDouble();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { verifyWebhook: _v, ...unsigned } = adapter;
    expect(() => checkInvoicingAdapter(unsigned)).toThrow(/webhooks/);
    expect(() => createIntegrationRegistry([], { invoicing: [adapter, adapter] })).toThrow(
      /registered twice/,
    );
  });

  it('reaches an invoicing adapter only through the gateway', () => {
    const src = __dirname;
    const callers = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => !['gateway.ts', 'contract.ts', 'contract-suite.ts', 'double.ts'].includes(f))
      .filter((f) =>
        /\.(listPage|validateConnection|verifyWebhook|parseWebhook|readFile|revokeAccess)\(/.test(
          readFileSync(join(src, f), 'utf8'),
        ),
      );
    expect(callers).toEqual([]);
    const parent = readdirSync(join(src, '..'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) =>
        /findInvoicing\(|listInvoicing\(/.test(readFileSync(join(src, '..', f), 'utf8')),
      )
      .filter((f) => f !== 'registry.ts');
    expect(parent).toEqual([]);
  });

  it('the contract offers no way to issue, void or send', () => {
    const text = readFileSync(join(__dirname, 'contract.ts'), 'utf8');
    const methods = [...text.matchAll(/^ {2}(\w+)\??\(/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(
      [
        'accountIdOf',
        'checkAccount',
        'listPage',
        'parseWebhook',
        'readFile',
        'revokeAccess',
        'validateConnection',
        'verifyWebhook',
      ].sort(),
    );
  });
});

describe('connections', () => {
  it('creates one with secret references only, and connects it', async () => {
    const w = await world();
    const created = await w.gateway.createConnection(w.tenantA, {
      provider: 'double_invoicing',
      displayName: 'Facturación',
      account: { taxId: '20131312955' },
      jurisdiction: 'PE',
    });
    expect(created).toMatchObject({ status: 'created', category: 'invoicing', jurisdiction: 'PE' });
    expect(created.secrets.api_token).toBe(
      `projects/${PROJECT}/secrets/invoicing-${created.id}-api-token/versions/latest`,
    );
    expect(Object.values(created.secrets).every(isInvoicingSecretRef)).toBe(true);
    // An invoicing reference is never a channel reference, and the channel reader refuses it.
    expect(isSecretRef(created.secrets.api_token)).toBe(false);
    await expect(
      new InMemorySecretStore().read(created.secrets.api_token as never),
    ).rejects.toThrow('secret_not_found');
    // No secret: the check fails with the store's code, nothing is read.
    const unchecked = await w.gateway.connect(w.tenantA, created.id);
    expect(unchecked).toMatchObject({ status: 'error', statusReason: 'secret_not_found' });
    w.secrets.put(invoicingSecretRefFor(PROJECT, created.id, 'api_token'), DOUBLE_TOKEN);
    w.secrets.put(invoicingSecretRefFor(PROJECT, created.id, 'webhook_secret'), WEBHOOK_SECRET);
    expect(await w.gateway.connect(w.tenantA, created.id)).toMatchObject({ status: 'connected' });
    const events = await auditOf(w);
    expect(JSON.stringify(events)).not.toContain(DOUBLE_TOKEN);
    expect(JSON.stringify(events)).not.toContain(WEBHOOK_SECRET);
  });

  it('never takes a secret through the API', async () => {
    const w = await world();
    for (const account of [
      { taxId: '20131312955', claveSol: 'x' },
      { taxId: '20131312955', password: 'x' },
      { taxId: '20131312955', usuarioSol: 'x' },
      { taxId: '20131312955', apiToken: 'x' },
    ]) {
      await expect(
        w.gateway.createConnection(w.tenantA, {
          provider: 'double_invoicing',
          displayName: 'F',
          account,
          jurisdiction: 'PE',
        }),
      ).rejects.toThrow('invalid_connection: account.secret');
    }
  });

  it('refuses a provider error as an error status with its code', async () => {
    const w = await world();
    expect(await w.connected('wrong-token')).toMatchObject({
      status: 'error',
      statusReason: 'unauthorized',
    });
  });

  it('asks the plan, counting channel connections in the same limit', async () => {
    const input = {
      provider: 'double_invoicing',
      displayName: 'F',
      account: { taxId: '20131312955' },
      jurisdiction: 'PE',
    };
    const notAllowed = await world({ categories: ['messaging'] });
    await expect(notAllowed.gateway.createConnection(notAllowed.tenantA, input)).rejects.toThrow(
      'category_not_allowed',
    );
    const full = await world({ limit: 1, channelSlots: 1 });
    await expect(full.gateway.createConnection(full.tenantA, input)).rejects.toThrow(
      'limit_reached',
    );
    const w = await world();
    await w.gateway.createConnection(w.tenantA, input);
    await expect(w.gateway.createConnection(w.tenantA, input)).rejects.toThrow('account.duplicate');
    await expect(
      w.gateway.createConnection(w.tenantA, { ...input, jurisdiction: 'CL' }),
    ).rejects.toThrow('jurisdiction');
  });

  it('is a person’s act, under the connection permissions', async () => {
    const w = await world();
    await expect(
      w.gateway.createConnection(w.giaA, {
        provider: 'double_invoicing',
        displayName: 'F',
        account: { taxId: '20131312955' },
        jurisdiction: 'PE',
      }),
    ).rejects.toThrow('requires_user');
    const c = await w.connected();
    await expect(
      w.gateway.startSync(w.giaA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    ).rejects.toThrow('requires_user');
  });

  it('keeps organizations apart', async () => {
    const w = await world();
    const c = await w.connected();
    w.double.put(invoice(1), 1);
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    );
    await expect(w.gateway.getConnection(w.tenantB, c.id)).rejects.toThrow('connection_not_found');
    expect(await w.gateway.listConnections(w.tenantB)).toEqual([]);
    await expect(
      w.gateway.startSync(w.tenantB, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000002',
      }),
    ).rejects.toThrow('connection_not_found');
    expect((await w.gateway.listRecords(w.tenantB, { recordType: 'document' })).items).toEqual([]);
    expect(await w.gateway.listSyncs(w.tenantB)).toEqual([]);
    const [job] = await w.gateway.listSyncs(w.tenantA);
    await expect(w.gateway.getSync(w.tenantB, (job as InvoicingSyncJob).id)).rejects.toThrow(
      'sync_not_found',
    );
    // The worker's entry names the organization: another one's id finds nothing.
    await expect(
      w.gateway.runSync(w.orgB, (job as InvoicingSyncJob).id, 'worker-1'),
    ).rejects.toThrow('sync_not_found');
    expect((await w.gateway.listRecords(w.tenantA, { recordType: 'document' })).items).toHaveLength(
      1,
    );
  });
});

describe('syncs', () => {
  it('reads every page across runs, then only what changed', async () => {
    const w = await world();
    const c = await w.connected();
    for (let n = 1; n <= 5; n += 1) w.double.put(invoice(n), n);
    const job = await w.gateway.startSync(w.tenantA, {
      connectionId: c.id,
      recordType: 'document',
      idempotencyKey: 'key-00000001',
    });
    // Two pages per run, two records per page: the first run gives its lease back.
    const first = await w.gateway.runSync(w.orgA, job.id, 'worker-1');
    expect(first).toMatchObject({ again: true, job: { status: 'queued', cursor: 'o:4' } });
    const done = await w.runToEnd(first.job);
    expect(done).toMatchObject({
      status: 'completed',
      counts: { pagesRead: 3, recordsSeen: 5, created: 5, rejected: 0 },
    });
    expect(done.cursor).toBeUndefined();
    expect((await w.gateway.getConnection(w.tenantA, c.id)).syncState.document).toMatchObject({
      watermark: '5',
      lastSyncJobId: job.id,
    });

    // Incremental: one changed (voided), one new; the others are not read again.
    w.double.put(invoice(2, { voidStatus: 'voided', authorityStatusCode: 'sunat_cp:2' }), 6);
    w.double.put(invoice(6), 7);
    const next = await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000002',
      }),
    );
    expect(next).toMatchObject({
      status: 'completed',
      since: '5',
      counts: { recordsSeen: 2, created: 1, updated: 1 },
    });

    // Full: everything read again; unchanged originals are not new revisions.
    const full = await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000003',
        full: true,
      }),
    );
    expect(full.counts).toMatchObject({ recordsSeen: 6, unchanged: 6, created: 0, updated: 0 });
  });

  it('starts one sync per key, and one at a time per record type', async () => {
    const w = await world();
    const c = await w.connected();
    const input = { connectionId: c.id, recordType: 'document', idempotencyKey: 'key-00000001' };
    const a = await w.gateway.startSync(w.tenantA, input);
    expect(await w.gateway.startSync(w.tenantA, input)).toEqual(a);
    await expect(
      w.gateway.startSync(w.tenantA, { ...input, idempotencyKey: 'key-00000002' }),
    ).rejects.toThrow('sync_in_progress');
    await expect(
      w.gateway.startSync(w.tenantA, { ...input, idempotencyKey: 'bad key!' }),
    ).rejects.toThrow('idempotencyKey');
    // A running sync is not taken by a second worker while its lease holds.
    w.double.put(invoice(1), 1);
    w.double.put(invoice(2), 2);
    w.double.put(invoice(3), 3);
    w.double.put(invoice(4), 4);
    w.double.put(invoice(5), 5);
    const run = await w.gateway.runSync(w.orgA, a.id, 'worker-1');
    expect(run.job.status).toBe('queued');
    expect((await w.gateway.listSyncs(w.tenantA)).length).toBe(1);
  });

  it('waits and retries when the provider is unavailable, keeping its place', async () => {
    const w = await world();
    const c = await w.connected();
    for (let n = 1; n <= 3; n += 1) w.double.put(invoice(n), n);
    const job = await w.gateway.startSync(w.tenantA, {
      connectionId: c.id,
      recordType: 'document',
      idempotencyKey: 'key-00000001',
    });
    w.double.failNext(2, 'provider_unavailable', 'rate_limited', 5_000);
    const first = await w.gateway.runSync(w.orgA, job.id, 'worker-1');
    expect(first.job).toMatchObject({ status: 'queued', attempts: 1, errorCode: 'rate_limited' });
    // Not before its time: never earlier than the provider's Retry-After.
    expect(Date.parse(first.job.nextAttemptAt as string) - T0).toBe(5_000);
    await expect(w.gateway.runSync(w.orgA, job.id, 'worker-1')).rejects.toThrow('sync_in_progress');
    expect(await w.runToEnd(first.job)).toMatchObject({
      status: 'completed',
      counts: { created: 3 },
    });
  });

  it('ends incomplete when retries run out, and resumes where it stopped', async () => {
    const w = await world({ limits: { maxAttempts: 2 } });
    const c = await w.connected();
    for (let n = 1; n <= 5; n += 1) w.double.put(invoice(n), n);
    const job = await w.gateway.startSync(w.tenantA, {
      connectionId: c.id,
      recordType: 'document',
      idempotencyKey: 'key-00000001',
    });
    const first = await w.gateway.runSync(w.orgA, job.id, 'worker-1');
    expect(first.job.cursor).toBe('o:4');
    w.double.failNext(5, 'provider_unavailable', 'no_answer');
    const stopped = await w.runToEnd(first.job);
    expect(stopped).toMatchObject({
      status: 'incomplete',
      incompleteReason: 'retries_exhausted',
      cursor: 'o:4',
      counts: { created: 4 },
    });
    // The watermark did not move: nothing after the stop is skipped.
    expect((await w.gateway.getConnection(w.tenantA, c.id)).syncState.document).toBeUndefined();
    w.double.failNext(0, 'provider_unavailable', 'no_answer');
    const resumed = await w.gateway.resumeSync(w.tenantA, stopped.id);
    expect(resumed).toMatchObject({ cursor: 'o:4', idempotencyKey: `resume:${stopped.id}` });
    expect(await w.gateway.resumeSync(w.tenantA, stopped.id)).toEqual(resumed);
    expect(await w.runToEnd(resumed)).toMatchObject({
      status: 'completed',
      counts: { recordsSeen: 1, created: 1 },
    });
    expect((await w.gateway.getConnection(w.tenantA, c.id)).syncState.document?.watermark).toBe(
      '5',
    );
  });

  it('ends incomplete at the page limit of a sync', async () => {
    const w = await world({ limits: { pagesPerSync: 2 } });
    const c = await w.connected();
    for (let n = 1; n <= 5; n += 1) w.double.put(invoice(n), n);
    const done = await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    );
    expect(done).toMatchObject({ status: 'incomplete', incompleteReason: 'pages_remaining' });
    expect(done.cursor).toBe('o:4');
  });

  it('refuses bad records one by one and says the sync is incomplete', async () => {
    const w = await world();
    const c = await w.connected();
    w.double.put(invoice(1), 1);
    w.double.put(invoice(2, { total: { value: '118.00', currency: 'USD' } }), 2);
    w.double.put(invoice(3, { issueDate: '2026-02-30' }), 3);
    const done = await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    );
    expect(done).toMatchObject({
      status: 'incomplete',
      incompleteReason: 'records_rejected',
      counts: { created: 1, rejected: 2 },
      rejections: [
        { externalId: 'F001-0002', code: 'total.currency' },
        { externalId: 'F001-0003', code: 'issueDate' },
      ],
    });
    // Every page was read, so its watermark moved; a refused record is not resumable by cursor.
    await expect(w.gateway.resumeSync(w.tenantA, done.id)).rejects.toThrow('sync_not_resumable');
  });

  it('fails when the provider refuses the credentials', async () => {
    const w = await world();
    const c = await w.connected();
    w.double.failNext(1, 'provider_rejected', 'unauthorized');
    const done = await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    );
    expect(done).toMatchObject({ status: 'failed', errorCode: 'unauthorized' });
  });

  it('stops syncs when the connection is turned off, revokes access, and keeps what was read', async () => {
    const w = await world();
    const c = await w.connected();
    for (let n = 1; n <= 5; n += 1) w.double.put(invoice(n), n);
    const job = await w.gateway.startSync(w.tenantA, {
      connectionId: c.id,
      recordType: 'document',
      idempotencyKey: 'key-00000001',
    });
    await w.gateway.runSync(w.orgA, job.id, 'worker-1');
    const off = await w.gateway.disconnect(w.tenantA, c.id);
    expect(off.status).toBe('disconnected');
    expect(w.double.calls.revoke).toBe(1);
    const stopped = await w.gateway.getSync(w.tenantA, job.id);
    expect(stopped).toMatchObject({ status: 'incomplete', incompleteReason: 'connection_stopped' });
    expect(await w.gateway.runSync(w.orgA, job.id, 'worker-1')).toMatchObject({ again: false });
    expect((await w.gateway.listRecords(w.tenantA, { recordType: 'document' })).items).toHaveLength(
      4,
    );
    await expect(
      w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000002',
      }),
    ).rejects.toThrow('connection_disabled');
    const revoked = await w.gateway.revoke(w.tenantA, c.id);
    expect(revoked.status).toBe('revoked');
    await expect(w.gateway.connect(w.tenantA, c.id)).rejects.toThrow('connection_revoked');
  });

  it('refuses a record type the provider does not declare', async () => {
    const w = await world();
    const c = await w.connected();
    await expect(
      w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'invoice',
        idempotencyKey: 'key-00000001',
      }),
    ).rejects.toThrow('recordType');
  });
});

describe('fiscal statuses and payments', () => {
  it('keeps issued, accepted, voided and paid apart, counting only confirmed payments', async () => {
    const w = await world();
    const c = await w.connected();
    w.double.put(invoice(1), 1);
    w.double.put(invoice(2, { authorityStatus: 'rejected', authorityStatusCode: 'sunat_cp:4' }), 2);
    w.double.put(invoice(3, { voidStatus: 'voided', authorityStatusCode: 'sunat_cp:2' }), 3);
    w.double.put(payment('P-1', 'confirmed', '50.00', 'F001-0001'), 4);
    w.double.put(payment('P-2', 'recorded', '68.00', 'F001-0001'), 5);
    for (const recordType of ['document', 'payment'] as const) {
      await w.runToEnd(
        await w.gateway.startSync(w.tenantA, {
          connectionId: c.id,
          recordType,
          idempotencyKey: `key-${recordType}-1`,
        }),
      );
    }
    const docs = (await w.gateway.listRecords(w.tenantA, { recordType: 'document' })).items.map(
      (s) => (s.recordType === 'document' ? s.record : undefined),
    );
    const byNumber = Object.fromEntries(docs.map((d) => [d?.number, d]));
    expect(byNumber['1']).toMatchObject({
      authorityStatus: 'accepted',
      voidStatus: 'none',
      confirmedPaid: { value: '50', currency: 'PEN' },
    });
    expect(byNumber['2']).toMatchObject({ authorityStatus: 'rejected', voidStatus: 'none' });
    expect(byNumber['3']).toMatchObject({ authorityStatus: 'accepted', voidStatus: 'voided' });
    // The original is traced by digest, never copied into the record.
    expect(byNumber['1']?.source).toMatchObject({
      provider: 'double_invoicing',
      externalId: 'F001-0001',
      originalFormat: 'provider_json',
    });
    expect(byNumber['1']?.source.originalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(byNumber['1'])).not.toContain('"content"');
    // Amounts stay exact strings.
    expect(byNumber['1']?.lines[0]?.unitPrice?.value).toBe('100.0000000001');

    // The recorded payment is confirmed later: the document's paid total follows.
    w.double.put(payment('P-2', 'confirmed', '68.00', 'F001-0001'), 6);
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'payment',
        idempotencyKey: 'key-payment-2',
      }),
    );
    const [paid] = (await w.gateway.listRecords(w.tenantA, { recordType: 'document', pageSize: 1 }))
      .items;
    expect(paid?.recordType === 'document' && paid.record.confirmedPaid.value).toBe('118');
  });

  it('adds amounts exactly', () => {
    expect(
      sumAmounts(
        [
          { value: '0.1', currency: 'PEN' },
          { value: '0.2', currency: 'PEN' },
          { value: '-0.3', currency: 'PEN' },
        ],
        'PEN',
      ).value,
    ).toBe('0');
    expect(() => sumAmounts([{ value: '1', currency: 'USD' }], 'PEN')).toThrow();
  });
});

describe('webhooks', () => {
  it('starts an incremental sync once per verified event, and stores nothing from it', async () => {
    const w = await world();
    const c = await w.connected();
    const body = JSON.stringify({ id: 'evt-1', types: ['document', 'payment', 'nonsense'] });
    await expect(
      w.gateway.receiveWebhook(c.id, body, signDoubleWebhook(body, 'another-secret')),
    ).rejects.toThrow('invalid_signature');
    const first = await w.gateway.receiveWebhook(
      c.id,
      body,
      signDoubleWebhook(body, WEBHOOK_SECRET),
    );
    expect(first.accepted).toBe(true);
    expect(first.jobs.map((j) => [j.recordType, j.trigger, j.initiatedBy])).toEqual([
      ['document', 'webhook', ALICE],
      ['payment', 'webhook', ALICE],
    ]);
    // The same event again while its syncs run: nothing new.
    const again = await w.gateway.receiveWebhook(
      c.id,
      body,
      signDoubleWebhook(body, WEBHOOK_SECRET),
    );
    expect(again.jobs).toEqual([]);
    for (const job of first.jobs) await w.runToEnd(job);
    // After they ended, the same event id still starts nothing new: its key is spent.
    const late = await w.gateway.receiveWebhook(
      c.id,
      body,
      signDoubleWebhook(body, WEBHOOK_SECRET),
    );
    expect(late.jobs.map((j) => j.id)).toEqual(first.jobs.map((j) => j.id));
    expect((await w.gateway.listSyncs(w.tenantA)).length).toBe(2);
  });

  it('refuses webhooks for unknown, turned off or malformed connections', async () => {
    const w = await world();
    const c = await w.connected();
    const body = JSON.stringify({ id: 'evt-1', types: ['document'] });
    const headers = signDoubleWebhook(body, WEBHOOK_SECRET);
    expect(await w.gateway.receiveWebhook('not-an-id', body, headers)).toEqual({
      accepted: false,
      jobs: [],
    });
    await w.gateway.pause(w.tenantA, c.id);
    expect(await w.gateway.receiveWebhook(c.id, body, headers)).toEqual({
      accepted: true,
      jobs: [],
    });
    await w.gateway.disconnect(w.tenantA, c.id);
    expect(await w.gateway.receiveWebhook(c.id, body, headers)).toEqual({
      accepted: false,
      jobs: [],
    });
  });
});

describe('file import', () => {
  it('imports a file once, through its adapter, within the size limit', async () => {
    const w = await world({ limits: { maxFileBytes: 4096 } });
    const c = await w.connected();
    const content = Buffer.from(JSON.stringify([invoice(1), invoice(2)]));
    const job = await w.gateway.importFile(w.tenantA, {
      connectionId: c.id,
      format: 'provider_csv',
      recordType: 'document',
      content,
    });
    expect(job).toMatchObject({
      status: 'completed',
      trigger: 'file_import',
      counts: { created: 2, bytesRead: content.byteLength },
    });
    expect(job.fileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await w.gateway.importFile(w.tenantA, {
        connectionId: c.id,
        format: 'provider_csv',
        recordType: 'document',
        content,
      }),
    ).toEqual(job);
    await expect(
      w.gateway.importFile(w.tenantA, {
        connectionId: c.id,
        format: 'ubl_xml',
        recordType: 'document',
        content,
      }),
    ).rejects.toThrow('capability_missing');
    await expect(
      w.gateway.importFile(w.tenantA, {
        connectionId: c.id,
        format: 'provider_csv',
        recordType: 'document',
        content: new Uint8Array(4097),
      }),
    ).rejects.toThrow('file_too_large');
    const unreadable = await w.gateway.importFile(w.tenantA, {
      connectionId: c.id,
      format: 'provider_csv',
      recordType: 'document',
      content: Buffer.from('not json'),
    });
    expect(unreadable).toMatchObject({ status: 'failed', errorCode: 'unreadable' });
    // A file import is never run as an API sync.
    expect(await w.gateway.runSync(w.orgA, job.id, 'worker-1')).toMatchObject({ again: false });
  });
});

describe('metrics and costs', () => {
  it('counts per organization, provider and connection, and estimates only from sourced unit costs', async () => {
    const w = await world();
    const c = await w.connected();
    for (let n = 1; n <= 3; n += 1) w.double.put(invoice(n), n);
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    );
    w.tick(3_600_000);
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000002',
      }),
    );
    const jobs = await w.gateway.listSyncs(w.tenantA);
    const [usage] = usageOf(jobs, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    expect(usage).toMatchObject({
      organizationId: w.orgA,
      provider: 'double_invoicing' as IntegrationProviderId,
      connectionId: c.id,
      syncs: 2,
      byTrigger: { manual: 2 },
      byStatus: { completed: 2 },
      documentsProcessed: 3,
      created: 3,
      medianMinutesBetweenSyncs: 60,
      syncsPerDay: 24,
    });
    expect(estimateCost(usage as never, ['providerCall', 'documentProcessed'], {})).toEqual({
      status: 'unknown',
      missing: ['providerCall', 'documentProcessed'],
    });
    expect(
      estimateCost(usage as never, ['providerCall'], {
        providerCall: { amount: '0.002', currency: 'USD', source: '' },
      }),
    ).toEqual({ status: 'unknown', missing: ['providerCall'] });
    const estimate = estimateCost(usage as never, ['providerCall', 'documentProcessed'], {
      providerCall: { amount: '0.002', currency: 'USD', source: 'test fixture' },
      documentProcessed: { amount: '0.0001', currency: 'USD', source: 'test fixture' },
    });
    expect(estimate).toMatchObject({
      status: 'estimated',
      total: { value: '0.0063', currency: 'USD' },
    });
  });
});

describe('audit', () => {
  it('records connections and syncs with codes only', async () => {
    const w = await world();
    const c = await w.connected();
    w.double.put(invoice(1), 1);
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    );
    const events = await auditOf(w);
    const actions = events.map((e) => `${e.action}:${e.reason}`).sort();
    expect(actions).toEqual(
      [
        'channel.invoicing_connection_created:created',
        'channel.invoicing_connection_changed:connecting',
        'channel.invoicing_connection_checked:connected',
        'channel.invoicing_sync_started:manual',
        'channel.invoicing_sync_finished:completed',
      ].sort(),
    );
    const finished = events.find((e) => e.action === 'channel.invoicing_sync_finished');
    // The runtime finished it, for the person who started it.
    expect(finished?.actor).toEqual({
      type: 'system',
      id: 'runtime',
      initiatedBy: ALICE,
      via: 'runtime',
    });
    expect(JSON.stringify(events)).not.toContain('Cliente SA');
  });
});

describe('Peru (adapter side)', () => {
  it('checks a RUC', () => {
    expect(isValidRuc('20131312955')).toBe(true);
    expect(isValidRuc('20131312954')).toBe(false);
    expect(isValidRuc('30131312955')).toBe(false);
    expect(isValidRuc('2013131295')).toBe(false);
  });

  it('maps SUNAT codes without guessing', () => {
    expect(peDocumentType('01')).toBe('invoice');
    expect(peDocumentType('07')).toBe('credit_note');
    expect(peDocumentType('09')).toBe('other');
    expect(peConsultaStatus('2')).toEqual({
      authorityStatus: 'accepted',
      voidStatus: 'voided',
      authorityStatusCode: 'sunat_cp:2',
    });
    expect(peConsultaStatus('4').authorityStatus).toBe('rejected');
    expect(peConsultaStatus('0').authorityStatus).toBe('not_found');
    expect(peConsultaStatus('9')).toMatchObject({ authorityStatus: 'not_reported' });
    expect(peConsultaStatus('<x>').authorityStatusCode).toBe('sunat_cp:unknown');
  });
});

describe('errors', () => {
  it('are integration errors with stable codes', () => {
    expect(new IntegrationError('sync_not_resumable').code).toBe('sync_not_resumable');
    expect(String(new IntegrationError('capability_missing', 'payment'))).toContain('payment');
  });
});
