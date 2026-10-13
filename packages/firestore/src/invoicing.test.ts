import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import type {
  InitialBilling,
  InvoicingCapabilities,
  InvoicingSyncJob,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { defaultValues, type EntitlementService } from '@melonoffice/entitlements';
import {
  createIntegrationRegistry,
  createInvoicingGateway,
  InMemorySecretStore,
  IntegrationError,
  invoicingSecretRefFor,
  isInvoicingSecretRef,
  type InvoicingAdapter,
  type NormalizedInvoicingRecord,
} from '@melonoffice/integrations';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS } from './audit.js';
import {
  FirestoreInvoicingRepository,
  INVOICING_PAYMENT_LINKS,
  INVOICING_SYNC_LOCKS,
} from './invoicing.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const T0 = Date.parse('2026-10-13T00:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const PROJECT = 'melonoffice-test';
// A stand-in for what Secret Manager would hold.
const TOKEN = 'test-token-value';

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

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const document = (n: number, total = '118.00'): NormalizedInvoicingRecord => ({
  recordType: 'document',
  externalId: `F001-${n}`,
  original: { format: 'provider_json', content: JSON.stringify({ n, total }) },
  direction: 'issued',
  type: 'invoice',
  sourceType: '01',
  series: 'F001',
  number: String(n),
  issueDate: '2026-10-01',
  issuer: { taxId: { scheme: 'PE:RUC', value: '20131312955' }, legalName: 'Emisor SAC' },
  currency: 'PEN',
  netTotal: { value: '100.00', currency: 'PEN' },
  taxTotal: { value: '18.00', currency: 'PEN' },
  total: { value: total, currency: 'PEN' },
  lines: [],
  relations: [],
  authorityStatus: 'not_reported',
  voidStatus: 'none',
});

const payment = (
  id: string,
  amount: string,
  docs: readonly string[],
): NormalizedInvoicingRecord => ({
  recordType: 'payment',
  externalId: id,
  original: { format: 'provider_json', content: JSON.stringify({ id, amount, docs }) },
  status: 'confirmed',
  amount: { value: amount, currency: 'PEN' },
  paidOn: '2026-10-05',
  appliesTo: docs.map((externalId) => ({
    externalId,
    amount: { value: amount, currency: 'PEN' },
  })),
});

/** A provider that lists what the test puts in it, page by page. */
function provider() {
  const records: NormalizedInvoicingRecord[] = [];
  const capabilities: InvoicingCapabilities = {
    records: ['document', 'payment'],
    listing: true,
    incrementalSync: false,
    webhooks: false,
    fileImport: ['provider_csv'],
    authorityStatus: false,
    paymentConfirmation: true,
    revokeOnDisconnect: false,
    maxPageSize: 100,
    write: [],
  };
  const adapter: InvoicingAdapter = {
    provider: 'test_invoicing' as InvoicingAdapter['provider'],
    category: 'invoicing',
    jurisdictions: ['PE'],
    capabilities,
    credentialKinds: ['api_token'],
    checkAccount: (value) => {
      const taxId = (value as { taxId?: unknown }).taxId;
      if (typeof taxId !== 'string') throw new IntegrationError('invalid_connection', 'account');
      return { taxId };
    },
    accountIdOf: (account) => String(account.taxId),
    validateConnection: async (_c, credentials) =>
      credentials.values.api_token === TOKEN
        ? { status: 'valid' }
        : { status: 'invalid', code: 'unauthorized' },
    listPage: async (_c, _credentials, request) => {
      const all = records.filter((r) => r.recordType === request.recordType);
      const offset = request.cursor === undefined ? 0 : Number(request.cursor);
      const page = all.slice(offset, offset + request.pageSize);
      return {
        records: page,
        ...(offset + request.pageSize < all.length
          ? { nextCursor: String(offset + request.pageSize) }
          : {}),
        bytes: page.length,
      };
    },
    readFile: (_format, content) => ({
      records: JSON.parse(Buffer.from(content).toString('utf8')) as NormalizedInvoicingRecord[],
      bytes: content.byteLength,
    }),
  };
  return { adapter, records };
}

async function world() {
  const db = emulatorFirestore();
  const clock = T0;
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
  const { adapter, records } = provider();
  const repository = new FirestoreInvoicingRepository(db);
  const secrets = new InMemorySecretStore(isInvoicingSecretRef);
  const entitlements: Pick<EntitlementService, 'entitlementsOf'> = {
    entitlementsOf: async (tenant) => ({
      status: 'active',
      organizationId: tenant.organizationId as OrganizationId,
      plan: { id: 'test-plan', version: 1 },
      values: {
        ...defaultValues(),
        'integrations.categoriesAllowed': ['invoicing'],
        'integrations.connectionsMax': 3,
      },
    }),
  };
  let ids = 0;
  const gateway = createInvoicingGateway({
    repository,
    registry: createIntegrationRegistry([], { invoicing: [adapter] }),
    secrets,
    organizations: tenancy,
    authorization: createAuthorizationService(),
    entitlements,
    secretProjectId: PROJECT,
    limits: { pagesPerRun: 2, pageSize: 2 },
    now,
    random: () => 1,
    newId: () => `eeeeeeee-eeee-4eee-8eee-${String(++ids).padStart(12, '0')}`,
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const connected = async (taxId = '20131312955') => {
    const c = await gateway.createConnection(tenantA, {
      provider: 'test_invoicing',
      displayName: 'Facturación',
      account: { taxId },
      jurisdiction: 'PE',
    });
    secrets.put(invoicingSecretRefFor(PROJECT, c.id, 'api_token'), TOKEN);
    return gateway.connect(tenantA, c.id);
  };
  const runToEnd = async (job: InvoicingSyncJob) => {
    let current = job;
    for (let i = 0; i < 20; i += 1) {
      const result = await gateway.runSync(current.organizationId, current.id, 'worker-1');
      current = result.job;
      if (!result.again) return current;
    }
    return current;
  };
  return {
    db,
    repository,
    gateway,
    records,
    tenantA,
    tenantB,
    orgA: a.organization.id,
    orgB: b.organization.id,
    connected,
    runToEnd,
  };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof IntegrationError ? error.code : String(error);
  }
};

describe.runIf(emulatorHost)('FirestoreInvoicingRepository (ADR-0193, emulator)', () => {
  it('keeps connections per organization, audited in the same write', async () => {
    const w = await world();
    const c = await w.connected();
    expect(c.status).toBe('connected');
    expect(await w.repository.findConnection(w.orgA, c.id)).toEqual(c);
    expect(await w.repository.findConnection(w.orgB, c.id)).toBeUndefined();
    expect(await w.repository.listConnections(w.orgB)).toEqual([]);
    expect(await codeOf(w.gateway.getConnection(w.tenantB, c.id))).toBe('connection_not_found');
    expect(await codeOf(w.gateway.rename(w.tenantB, c.id, 'Otra'))).toBe('connection_not_found');
    const audit = await w.db.collection(AUDIT_LOGS).where('organizationId', '==', w.orgA).get();
    expect(audit.docs.map((d) => d.data().action).sort()).toEqual([
      'channel.invoicing_connection_changed',
      'channel.invoicing_connection_checked',
      'channel.invoicing_connection_created',
    ]);
    // Only references: no secret value is ever stored.
    const raw = JSON.stringify(
      (await w.db.collection('invoicingConnections').get()).docs[0]?.data(),
    );
    expect(raw).not.toContain(TOKEN);
  });

  it('runs a sync to the end, page by page, and keeps the records', async () => {
    const w = await world();
    const c = await w.connected();
    for (let n = 1; n <= 5; n += 1) w.records.push(document(n));
    const job = await w.gateway.startSync(w.tenantA, {
      connectionId: c.id,
      recordType: 'document',
      idempotencyKey: 'key-0001',
    });
    const done = await w.runToEnd(job);
    expect(done).toMatchObject({
      status: 'completed',
      counts: { created: 5, pagesRead: 3, rejected: 0 },
    });
    // The lock is gone once the sync ended.
    expect((await w.db.collection(INVOICING_SYNC_LOCKS).get()).size).toBe(0);
    const first = await w.gateway.listRecords(w.tenantA, { recordType: 'document', pageSize: 2 });
    expect(first.items).toHaveLength(2);
    const second = await w.gateway.listRecords(w.tenantA, {
      recordType: 'document',
      pageSize: 10,
      cursor: first.nextCursor as string,
    });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeUndefined();
    expect((await w.gateway.listRecords(w.tenantB, { recordType: 'document' })).items).toEqual([]);
    // A cursor from another organization's range is refused, never followed.
    expect(
      await codeOf(
        w.gateway.listRecords(w.tenantB, {
          recordType: 'document',
          cursor: first.nextCursor as string,
        }),
      ),
    ).toBe('invalid_payload');
    // Reading again changes nothing.
    const again = await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'key-0002',
      }),
    );
    expect(again.counts).toMatchObject({ created: 0, unchanged: 5 });
    expect((await w.gateway.listSyncs(w.tenantA)).map((j) => j.idempotencyKey)).toEqual([
      'manual:key-0001',
      'manual:key-0002',
    ]);
    expect(await w.gateway.listSyncs(w.tenantB)).toEqual([]);
  });

  it('starts one sync per key and runs one per record type', async () => {
    const w = await world();
    const c = await w.connected();
    const start = (key: string, recordType: 'document' | 'payment' = 'document') =>
      w.gateway.startSync(w.tenantA, { connectionId: c.id, recordType, idempotencyKey: key });
    const job = await start('key-0001');
    expect(await start('key-0001')).toEqual(job);
    expect(await codeOf(start('key-0002'))).toBe('sync_in_progress');
    // Another record type is another lock.
    expect((await start('key-0003', 'payment')).recordType).toBe('payment');
    // Past the gateway's own check, the lock still refuses a second sync.
    const [x, y] = await Promise.allSettled([
      w.repository.createJobOnce({
        job: { ...job, id: 'eeeeeeee-eeee-4eee-8eee-0000000000a1', idempotencyKey: 'manual:x' },
        events: [],
      } as never),
      w.repository.createJobOnce({
        job: { ...job, id: 'eeeeeeee-eeee-4eee-8eee-0000000000a2', idempotencyKey: 'manual:y' },
        events: [],
      } as never),
    ]);
    expect([x.status, y.status]).toEqual(['rejected', 'rejected']);
    expect(await w.repository.activeJob(w.orgA, c.id, 'document')).toEqual(job);
    expect(await w.repository.activeJob(w.orgB, c.id, 'document')).toBeUndefined();
    // Turning the connection off ends it, and the lock with it.
    await w.gateway.pause(w.tenantA, c.id);
    expect(await w.repository.activeJob(w.orgA, c.id, 'document')).toBeUndefined();
    expect((await w.db.collection(INVOICING_SYNC_LOCKS).get()).size).toBe(0);
  });

  it('lets one of two racing syncs start once the lock is free', async () => {
    const w = await world();
    const c = await w.connected();
    const results = await Promise.allSettled(
      ['race-000a', 'race-000b', 'race-000c'].map((key) =>
        w.gateway.startSync(w.tenantA, {
          connectionId: c.id,
          recordType: 'document',
          idempotencyKey: key,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect(((r as PromiseRejectedResult).reason as IntegrationError).code).toBe(
        'sync_in_progress',
      );
    }
  });

  it("recomputes a document's confirmed total from the payments linked to it", async () => {
    const w = await world();
    const c = await w.connected();
    w.records.push(document(1), document(2));
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'docs-0001',
      }),
    );
    const file = (records: NormalizedInvoicingRecord[]) =>
      w.gateway.importFile(w.tenantA, {
        connectionId: c.id,
        format: 'provider_csv',
        recordType: 'payment',
        content: new TextEncoder().encode(JSON.stringify(records)),
      });
    // A file import runs beside a sync: it takes no lock.
    const running = await w.gateway.startSync(w.tenantA, {
      connectionId: c.id,
      recordType: 'payment',
      idempotencyKey: 'pays-0001',
    });
    expect((await file([payment('P-1', '50.00', ['F001-1', 'F001-2'])])).status).toBe('completed');
    expect(await w.repository.activeJob(w.orgA, c.id, 'payment')).toEqual(running);
    const paid = async (externalId: string) => {
      const stored = await w.repository.findRecord(w.orgA, {
        connectionId: c.id,
        recordType: 'document',
        externalId,
      });
      return stored?.recordType === 'document' ? stored.record.confirmedPaid.value : undefined;
    };
    expect([await paid('F001-1'), await paid('F001-2')]).toEqual(['50', '50']);
    // The payment now applies to one document only: the other's link and total follow.
    await file([payment('P-1', '60.00', ['F001-1'])]);
    expect([await paid('F001-1'), await paid('F001-2')]).toEqual(['60', '0']);
    expect(await w.repository.paymentsFor(w.orgA, c.id, 'F001-2')).toEqual([]);
    expect(await w.repository.paymentsFor(w.orgB, c.id, 'F001-1')).toEqual([]);
    const links = await w.db.collection(INVOICING_PAYMENT_LINKS).get();
    expect(links.docs.every((d) => d.id.startsWith(`${w.orgA}:`))).toBe(true);
  });

  it('never reads a record of another organization', async () => {
    const w = await world();
    const c = await w.connected();
    w.records.push(document(1));
    await w.runToEnd(
      await w.gateway.startSync(w.tenantA, {
        connectionId: c.id,
        recordType: 'document',
        idempotencyKey: 'docs-0001',
      }),
    );
    const key = { connectionId: c.id, recordType: 'document' as const, externalId: 'F001-1' };
    expect(await w.repository.findRecord(w.orgA, key)).toBeDefined();
    expect(await w.repository.findRecord(w.orgB, key)).toBeUndefined();
    const stored = await w.repository.findRecord(w.orgA, key);
    // Writing it under another organization is refused.
    expect(await codeOf(w.repository.upsertRecord(w.orgB, () => stored as never, key))).toBe(
      'invalid_payload',
    );
  });
});
