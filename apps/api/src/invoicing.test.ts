import { createBillingService } from '@melonoffice/billing';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { createEntitlementService, type EntitlementOverride } from '@melonoffice/entitlements';
import { createPeUblAdapter } from '@melonoffice/integrations';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The Billing Integration Gateway through the API (ADR-0193): the plan's limits shared with the
 * channels, each change under its own permission, UBL XML files imported once, and nothing of
 * another organization ever answered. Read only: no route issues or changes a document.
 */

const OURS = '20131312955';
const CUSTOMER = '20100176450';

interface Json {
  readonly [key: string]: unknown;
}

/** A synthetic UBL 2.1 invoice built to SUNAT's structure: not a real document. */
const invoice = (number: number, supplier = OURS) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>F001-${number}</cbc:ID>
  <cbc:IssueDate>2026-10-01</cbc:IssueDate>
  <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="6">${supplier}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>Emisor S.A.C.</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="6">${CUSTOMER}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>Cliente S.A.</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="PEN">100.00</cbc:LineExtensionAmount>
    <cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PEN">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Servicio</cbc:Description></cac:Item>
  </cac:InvoiceLine>
</Invoice>`;

describe.each(STORES)('invoicing with storage in %s', (_name, createStores) => {
  async function setup(
    options: {
      permissions?: readonly string[];
      scheduler?: 'none' | 'failing';
      /** As a server with `INVOICING_ENABLED` off: no invoicing part at all. */
      off?: boolean;
    } = {},
  ) {
    const stores: Stores = createStores();
    const overrides = new Map<string, EntitlementOverride[]>();
    const entitlements = createEntitlementService({
      organizations: stores.tenancy,
      plans: createBillingService({ billing: stores.billing, organizations: stores.tenancy }),
      overrides: { overridesOf: async (id) => overrides.get(id) ?? [] },
    });
    const authorization =
      options.permissions === undefined
        ? undefined
        : createAuthorizationService({
            owner: ROLES.owner.filter(
              (p) =>
                !(p.startsWith('channel.') || p.startsWith('invoicing.')) ||
                options.permissions?.includes(p),
            ),
          } as never);
    const queued: { task: unknown; at: Date }[] = [];
    const ctx = setupApp(
      stores,
      authorization,
      entitlements,
      undefined,
      undefined,
      options.off
        ? {}
        : {
            invoicing: {
              adapters: [createPeUblAdapter()],
              ...(options.scheduler === 'none'
                ? {}
                : {
                    scheduler: {
                      schedule: async (task, at) => {
                        if (options.scheduler === 'failing') throw new Error('queue down');
                        queued.push({ task, at });
                      },
                    },
                  }),
            },
          },
    );
    const aliceId = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const request = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Json };
    };
    const send = (token: string, method: string, path: string, body?: unknown) =>
      request(token, path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    const createOrg = async (token: string, name: string) =>
      (await send(token, 'POST', '/v1/organizations', { name })).body.organization as {
        id: OrganizationId;
      };
    const orgA = (await createOrg('token-alice', 'A')).id;
    const orgB = (await createOrg('token-bob', 'B')).id;
    const base = (org: string) => `/v1/organizations/${org}/invoicing`;
    /** The organization's audited override (ADR-0044): invoicing, and `max` connections. */
    const allow = (org: OrganizationId, max: number, categories = ['invoicing']) =>
      overrides.set(org, [
        {
          key: 'integrations.categoriesAllowed',
          value: categories,
          reason: 'Local test',
          approvedBy: aliceId,
        },
        {
          key: 'integrations.connectionsMax',
          value: max,
          reason: 'Local test',
          approvedBy: aliceId,
        },
      ]);
    const upload = (token: string, org: string, id: string, xml: string, query = '') =>
      request(
        token,
        `${base(org)}/connections/${id}/imports?format=ubl_xml&recordType=document${query}`,
        { method: 'POST', headers: { 'content-type': 'application/xml' }, body: xml },
      );
    const newConnection = {
      provider: 'pe_ubl_files',
      displayName: 'Facturas XML',
      account: { taxId: OURS },
      jurisdiction: 'PE',
    };
    /** A connected file connection of A. */
    const connected = async () => {
      const created = await send('token-alice', 'POST', `${base(orgA)}/connections`, newConnection);
      const id = created.body.id as string;
      await send('token-alice', 'POST', `${base(orgA)}/connections/${id}/connect`);
      return id;
    };
    return {
      ...ctx,
      stores,
      orgA,
      orgB,
      base,
      send,
      request,
      allow,
      upload,
      newConnection,
      connected,
      queued,
    };
  }

  it('answers 503 on every route and keeps nothing while INVOICING_ENABLED is off', async () => {
    const t = await setup({ off: true });
    // Even an organization whose plan allows invoicing gets nothing.
    t.allow(t.orgA, 5);
    const id = 'eeeeeeee-eeee-4eee-8eee-000000000001';
    const routes: [string, string][] = [
      ['GET', '/providers'],
      ['GET', '/connections'],
      ['POST', '/connections'],
      ['GET', `/connections/${id}`],
      ['PATCH', `/connections/${id}`],
      ['DELETE', `/connections/${id}`],
      ['POST', `/connections/${id}/connect`],
      ['POST', `/connections/${id}/pause`],
      ['POST', `/connections/${id}/disconnect`],
      ['POST', `/connections/${id}/syncs`],
      ['POST', `/connections/${id}/imports?format=ubl_xml&recordType=document`],
      ['GET', '/syncs'],
      ['GET', `/syncs/${id}`],
      ['POST', `/syncs/${id}/resume`],
      ['GET', '/records?recordType=document'],
      ['GET', ''],
    ];
    for (const [method, path] of routes) {
      const response = await t.send(
        'token-alice',
        method,
        `${t.base(t.orgA)}${path}`,
        method === 'GET' || method === 'DELETE' ? undefined : t.newConnection,
      );
      expect([method, path, response.status, response.body]).toEqual([
        method,
        path,
        503,
        { error: 'invoicing_not_configured' },
      ]);
    }
    // A file sent anyway is not read or kept.
    expect((await t.upload('token-alice', t.orgA, id, invoice(1))).status).toBe(503);
    expect(await t.stores.invoicing.listConnections(t.orgA)).toEqual([]);
    // Someone of another organization gets the same answer: it is off for everyone.
    expect((await t.send('token-bob', 'GET', `${t.base(t.orgA)}/connections`)).status).toBe(503);
  });

  it("keeps the plan's limits, shared with the channels", async () => {
    const t = await setup();
    const path = `${t.base(t.orgA)}/connections`;
    // The plan has no invoicing: nothing without an override.
    expect(await t.send('token-alice', 'POST', path, t.newConnection)).toEqual({
      status: 403,
      body: { error: 'category_not_allowed' },
    });
    t.allow(t.orgA, 1, ['invoicing', 'messaging']);
    const created = await t.send('token-alice', 'POST', path, t.newConnection);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      provider: 'pe_ubl_files',
      category: 'invoicing',
      status: 'created',
      account: { taxId: OURS },
      capabilities: { listing: false, fileImport: ['ubl_xml'], write: [] },
      setup: { secretIds: {} },
    });
    // The one slot is taken: a WhatsApp connection is past the same limit.
    expect(
      await t.send('token-alice', 'POST', `/v1/organizations/${t.orgA}/channel-connections`, {
        provider: 'meta_whatsapp_cloud',
        displayName: 'Ventas',
        account: { phoneNumberId: '106540352242922' },
      }),
    ).toEqual({ status: 409, body: { error: 'limit_reached' } });
    // B gets nothing from A's override.
    expect(
      (await t.send('token-bob', 'POST', `${t.base(t.orgB)}/connections`, t.newConnection)).status,
    ).toBe(403);
  });

  it('refuses a secret, an unknown provider or a bad RUC as account data', async () => {
    const t = await setup();
    t.allow(t.orgA, 2);
    const path = `${t.base(t.orgA)}/connections`;
    for (const account of [
      { taxId: OURS, claveSol: 'x' },
      { taxId: OURS, usuarioSol: 'x' },
    ]) {
      expect(await t.send('token-alice', 'POST', path, { ...t.newConnection, account })).toEqual({
        status: 400,
        body: { error: 'invalid_connection', field: 'account.secret' },
      });
    }
    expect(
      await t.send('token-alice', 'POST', path, {
        ...t.newConnection,
        account: { taxId: '20131312956' },
      }),
    ).toEqual({ status: 400, body: { error: 'invalid_connection', field: 'account.taxId' } });
    expect(
      (await t.send('token-alice', 'POST', path, { ...t.newConnection, provider: 'nubefact' }))
        .body,
    ).toEqual({ error: 'invalid_connection', field: 'provider' });
    const providers = await t.request('token-alice', `${t.base(t.orgA)}/providers`);
    expect(providers.body.providers).toEqual([
      expect.objectContaining({
        provider: 'pe_ubl_files',
        jurisdictions: ['PE'],
        credentialKinds: [],
      }),
    ]);
  });

  it('imports a UBL file once and lists what it read, for its organization only', async () => {
    const t = await setup();
    t.allow(t.orgA, 1);
    const id = await t.connected();
    const first = await t.upload('token-alice', t.orgA, id, invoice(123));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      trigger: 'file_import',
      status: 'completed',
      counts: { created: 1, rejected: 0 },
      resumable: false,
    });
    expect(first.body.fileDigest).toMatch(/^[0-9a-f]{64}$/);
    // The same file again: the same import, nothing read twice.
    expect((await t.upload('token-alice', t.orgA, id, invoice(123))).body).toEqual(first.body);
    // A file of another company is refused as a whole, with its reason.
    const other = await t.upload('token-alice', t.orgA, id, invoice(9, '20100047218'));
    expect(other.body).toMatchObject({ status: 'failed', errorCode: 'not_this_account' });
    const records = await t.request('token-alice', `${t.base(t.orgA)}/records?recordType=document`);
    expect(records.body.records).toEqual([
      expect.objectContaining({
        recordType: 'document',
        direction: 'issued',
        number: '123',
        total: { value: '118.00', currency: 'PEN' },
        authorityStatus: 'not_reported',
        confirmedPaid: { value: '0', currency: 'PEN' },
        source: expect.objectContaining({
          externalId: `${OURS}-01-F001-123`,
          originalFormat: 'ubl_2_1_xml',
        }),
      }),
    ]);
    expect(JSON.stringify(records.body)).not.toContain('<cbc:');
    const syncs = await t.request('token-alice', `${t.base(t.orgA)}/syncs`);
    expect((syncs.body.syncs as unknown[]).length).toBe(2);
    // B sees none of it, and A's connection answers B like a missing one.
    expect(
      (await t.request('token-bob', `${t.base(t.orgB)}/records?recordType=document`)).body,
    ).toEqual({
      records: [],
      nextCursor: null,
    });
    expect((await t.request('token-bob', `${t.base(t.orgB)}/syncs`)).body).toEqual({ syncs: [] });
    expect((await t.upload('token-bob', t.orgB, id, invoice(5))).status).toBe(404);
    expect((await t.request('token-bob', `${t.base(t.orgA)}/syncs`)).status).toBe(403);
  });

  it('refuses unsafe or malformed files with a stable code', async () => {
    const t = await setup();
    t.allow(t.orgA, 1);
    const id = await t.connected();
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`;
    expect((await t.upload('token-alice', t.orgA, id, xxe)).body).toMatchObject({
      status: 'failed',
      errorCode: 'doctype',
    });
    expect(
      (
        await t.request(
          'token-alice',
          `${t.base(t.orgA)}/connections/${id}/imports?format=provider_csv&recordType=document`,
          { method: 'POST', body: invoice(1) },
        )
      ).body,
    ).toEqual({ error: 'capability_missing', field: 'provider_csv' });
    expect(
      (
        await t.request(
          'token-alice',
          `${t.base(t.orgA)}/connections/${id}/imports?format=ubl_xml&recordType=document`,
          {
            method: 'POST',
            body: '',
          },
        )
      ).body,
    ).toEqual({ error: 'invalid_file', field: 'empty' });
    // Past the request limit, before anything is read.
    const big = `<a>${'x'.repeat(1024 * 1024 + 1)}</a>`;
    expect((await t.upload('token-alice', t.orgA, id, big)).status).toBe(413);
  });

  it('has no sync for a file provider, and never pretends to queue one', async () => {
    const t = await setup();
    t.allow(t.orgA, 1);
    const id = await t.connected();
    const start = (key: string) =>
      t.send('token-alice', 'POST', `${t.base(t.orgA)}/connections/${id}/syncs`, {
        recordType: 'document',
        idempotencyKey: key,
      });
    expect(await start('key-00000001')).toEqual({
      status: 400,
      body: { error: 'capability_missing', field: 'listing' },
    });
    expect(t.queued).toEqual([]);
    const without = await setup({ scheduler: 'none' });
    without.allow(without.orgA, 1);
    const other = await without.connected();
    expect(
      await without.send(
        'token-alice',
        'POST',
        `${without.base(without.orgA)}/connections/${other}/syncs`,
        {
          recordType: 'document',
          idempotencyKey: 'key-00000001',
        },
      ),
    ).toEqual({ status: 503, body: { error: 'invoicing_scheduler_unavailable' } });
  });

  it('puts each change behind its own permission', async () => {
    const t = await setup({ permissions: ['channel.read', 'channel.create', 'channel.update'] });
    t.allow(t.orgA, 1);
    const id = await t.connected();
    expect((await t.upload('token-alice', t.orgA, id, invoice(1))).status).toBe(403);
    expect(
      (await t.request('token-alice', `${t.base(t.orgA)}/records?recordType=document`)).status,
    ).toBe(403);
    expect(
      (await t.send('token-alice', 'POST', `${t.base(t.orgA)}/connections/${id}/disconnect`))
        .status,
    ).toBe(403);
    expect(
      (await t.send('token-alice', 'DELETE', `${t.base(t.orgA)}/connections/${id}`)).status,
    ).toBe(403);
    expect(
      (
        await t.send('token-alice', 'PATCH', `${t.base(t.orgA)}/connections/${id}`, {
          displayName: 'Compras',
        })
      ).body,
    ).toMatchObject({ displayName: 'Compras' });
  });

  it('turns a connection off and keeps what it read', async () => {
    const t = await setup();
    t.allow(t.orgA, 1);
    const id = await t.connected();
    await t.upload('token-alice', t.orgA, id, invoice(1));
    expect(
      (await t.send('token-alice', 'POST', `${t.base(t.orgA)}/connections/${id}/disconnect`)).body,
    ).toMatchObject({
      status: 'disconnected',
    });
    expect((await t.upload('token-alice', t.orgA, id, invoice(2))).body).toEqual({
      error: 'connection_disabled',
    });
    expect(
      (
        (await t.request('token-alice', `${t.base(t.orgA)}/records?recordType=document`)).body
          .records as unknown[]
      ).length,
    ).toBe(1);
    expect(
      (await t.send('token-alice', 'DELETE', `${t.base(t.orgA)}/connections/${id}`)).body,
    ).toMatchObject({
      status: 'revoked',
    });
  });
});
