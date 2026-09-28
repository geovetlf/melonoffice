import { createBillingService } from '@melonoffice/billing';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { createEntitlementService, type EntitlementOverride } from '@melonoffice/entitlements';
import { WHATSAPP_PROVIDER } from '@melonoffice/integrations';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Connections through the API (CV-6C, ADR-0044): each change with its own permission, the plan's
 * limits intact, an organization's own audited override as the only way past them, and the
 * connection then used end to end by the same webhook and engine as any other.
 */

const PHONE_A = '106540352242922';
// Test values only: stand-ins for what Secret Manager would hold.
const APP_SECRET = 'test-app-secret-value';
const ACCESS_TOKEN = 'test-access-token-value';
const VERIFY_TOKEN = 'test-verify-token-value';

interface Json {
  readonly [key: string]: unknown;
}

const sign = (body: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;

const inbound = (phoneNumberId: string) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Ana' }, wa_id: '15551234567' }],
              messages: [
                {
                  from: '15551234567',
                  id: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx',
                  timestamp: '1790510340',
                  type: 'text',
                  text: { body: 'Hola, quiero información' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

describe.each(STORES)('connections with storage in %s', (_name, createStores) => {
  async function setup(options: { permissions?: readonly string[] } = {}) {
    const stores: Stores = createStores();
    const overrides = new Map<string, EntitlementOverride[]>();
    // The real entitlement service over billing's plan (Emprendedor), with overrides per
    // organization: the plan catalogue itself is not touched.
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
              (p) => !p.startsWith('channel.') || options.permissions?.includes(p),
            ),
          } as never);
    const ctx = setupApp(stores, authorization, entitlements);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const create = async (token: string, name: string) =>
      (
        (await (
          await ctx.app.request(
            '/v1/organizations',
            ctx.as(token, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }),
          )
        ).json()) as { organization: { id: string } }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'MOpruebas');
    const orgB = await create('token-bob', 'B');
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
    const base = (org: string) => `/v1/organizations/${org}/channel-connections`;
    /** The organization's audited override: one WhatsApp connection (ADR-0044). */
    const allowOne = (org: OrganizationId) =>
      overrides.set(org, [
        {
          key: 'integrations.categoriesAllowed',
          value: ['messaging'],
          reason: 'DEV test connection',
          approvedBy: aliceId,
        },
        {
          key: 'integrations.connectionsMax',
          value: 1,
          reason: 'DEV test connection',
          approvedBy: aliceId,
        },
      ]);
    const newConnection = {
      provider: WHATSAPP_PROVIDER,
      displayName: 'Ventas',
      account: { phoneNumberId: PHONE_A },
    };
    return { ...ctx, stores, orgA, orgB, request, send, base, allowOne, newConnection };
  }

  it("keeps the plan's limits: no category, no connection, for anyone without an override", async () => {
    const t = await setup();
    expect(await t.send('token-alice', 'POST', t.base(t.orgA), t.newConnection)).toEqual({
      status: 403,
      body: { error: 'category_not_allowed' },
    });
    t.allowOne(t.orgA);
    expect((await t.send('token-alice', 'POST', t.base(t.orgA), t.newConnection)).status).toBe(201);
    // B, on the same plan, still gets nothing: the override is A's alone.
    expect(await t.send('token-bob', 'POST', t.base(t.orgB), t.newConnection)).toEqual({
      status: 403,
      body: { error: 'category_not_allowed' },
    });
    // A's second connection is past its override.
    expect(
      await t.send('token-alice', 'POST', t.base(t.orgA), {
        ...t.newConnection,
        account: { phoneNumberId: '306540352242922' },
      }),
    ).toEqual({ status: 409, body: { error: 'limit_reached' } });
  });

  it('creates, connects, uses, pauses, disconnects and deletes a connection, audited', async () => {
    const t = await setup();
    t.allowOne(t.orgA);
    const created = await t.send('token-alice', 'POST', t.base(t.orgA), t.newConnection);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({
      provider: 'meta_whatsapp_cloud',
      category: 'messaging',
      channel: 'whatsapp',
      status: 'created',
      setup: {
        secretIds: {
          app_secret: `channel-${id}-app-secret`,
          access_token: `channel-${id}-access-token`,
          verify_token: `channel-${id}-verify-token`,
        },
        webhookPath: `/webhooks/whatsapp/${id}`,
      },
    });
    // Where secrets live is never shown: no project, no resource path.
    expect(JSON.stringify(created.body)).not.toContain('/secrets/');
    expect(JSON.stringify(created.body)).not.toContain('melonoffice-test');

    // The person puts the secrets in Secret Manager, then connects: the provider is asked.
    const refs = (await t.stores.connections.find(t.orgA, id as never))?.secrets;
    if (refs === undefined) throw new Error('not stored');
    t.stores.secrets.put(refs.app_secret, APP_SECRET);
    t.stores.secrets.put(refs.access_token, ACCESS_TOKEN);
    t.stores.secrets.put(refs.verify_token, VERIFY_TOKEN);
    t.meta.answer = async () => new Response(JSON.stringify({ id: PHONE_A }));
    const connected = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/${id}/connect`);
    expect(connected.body).toMatchObject({ status: 'connected', statusReason: null });
    expect(t.meta.calls.at(-1)?.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_A}?fields=id`);

    // Used by the webhook exactly like any connection: the message lands in A.
    const body = inbound(PHONE_A);
    const delivered = await t.app.request(`/webhooks/whatsapp/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(await delivered.json()).toEqual({ received: 1, duplicates: 0, statuses: 0 });
    const inbox = await t.request('token-alice', `/v1/organizations/${t.orgA}/conversations`);
    expect(inbox.body.conversations).toHaveLength(1);

    expect(
      (await t.send('token-alice', 'PATCH', `${t.base(t.orgA)}/${id}`, { displayName: 'Soporte' }))
        .body,
    ).toMatchObject({ displayName: 'Soporte' });
    expect(
      (await t.send('token-alice', 'POST', `${t.base(t.orgA)}/${id}/pause`)).body,
    ).toMatchObject({ status: 'paused' });
    expect(
      (await t.send('token-alice', 'POST', `${t.base(t.orgA)}/${id}/disconnect`)).body,
    ).toMatchObject({ status: 'disconnected' });
    expect((await t.send('token-alice', 'DELETE', `${t.base(t.orgA)}/${id}`)).body).toMatchObject({
      status: 'revoked',
    });
    expect(await t.send('token-alice', 'POST', `${t.base(t.orgA)}/${id}/connect`)).toEqual({
      status: 409,
      body: { error: 'connection_revoked' },
    });
    const actions = (await t.stores.auditEvents())
      .map((e) => e.action)
      .filter((a) => a.startsWith('channel.'));
    expect(actions).toEqual([
      'channel.connection_created',
      'channel.connection_updated',
      'channel.connection_checked',
      'channel.connection_updated',
      'channel.connection_paused',
      'channel.connection_disconnected',
      'channel.connection_revoked',
    ]);
    const stored = await t.stores.storedAudit();
    for (const secret of [APP_SECRET, ACCESS_TOKEN, VERIFY_TOKEN]) {
      expect(stored).not.toContain(secret);
      expect(t.lines.join('\n')).not.toContain(secret);
    }
  });

  it("never shows or changes another organization's connection", async () => {
    const t = await setup();
    t.allowOne(t.orgA);
    const id = (await t.send('token-alice', 'POST', t.base(t.orgA), t.newConnection)).body
      .id as string;
    // Bob is not a member of A: refused by tenancy before anything is read.
    expect((await t.request('token-bob', `${t.base(t.orgA)}/${id}`)).status).toBe(403);
    // In his own organization, A's connection is simply not there.
    expect(await t.request('token-bob', `${t.base(t.orgB)}/${id}`)).toEqual({
      status: 404,
      body: { error: 'connection_not_found' },
    });
    expect(await t.send('token-bob', 'DELETE', `${t.base(t.orgB)}/${id}`)).toEqual({
      status: 404,
      body: { error: 'connection_not_found' },
    });
    expect((await t.request('token-bob', t.base(t.orgB))).body).toEqual({ connections: [] });
  });

  it('needs its own permission for each kind of change', async () => {
    const t = await setup({ permissions: ['channel.read'] });
    t.allowOne(t.orgA);
    expect((await t.request('token-alice', t.base(t.orgA))).status).toBe(200);
    expect(await t.send('token-alice', 'POST', t.base(t.orgA), t.newConnection)).toEqual({
      status: 403,
      body: { error: 'permission_denied' },
    });
    const providers = await t.request(
      'token-alice',
      `/v1/organizations/${t.orgA}/integrations/providers`,
    );
    expect(providers.body).toEqual({
      providers: [
        expect.objectContaining({
          provider: 'meta_whatsapp_cloud',
          category: 'messaging',
          channel: 'whatsapp',
        }),
      ],
    });
  });
});
