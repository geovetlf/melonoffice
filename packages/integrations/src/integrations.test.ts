import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  createConversationIngress,
  InMemoryConversationRepository,
} from '@melonoffice/conversations';
import { openWallet } from '@melonoffice/credits';
import type {
  ChannelConnection,
  ChannelConnectionId,
  InitialBilling,
  IsoTimestamp,
  Organization,
  OrganizationId,
  SecretRef,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { defaultValues, type EntitlementService } from '@melonoffice/entitlements';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createChannelConnectionService,
  InMemoryChannelConnectionRepository,
} from './connections.js';
import { IntegrationError } from './errors.js';
import { createIntegrationEngine } from './engine.js';
import { createIntegrationRegistry } from './registry.js';
import {
  createSecretManagerStore,
  InMemorySecretStore,
  isSecretRef,
  METADATA_TOKEN_URL,
  secretRefFor,
  secretRefsFor,
} from './secrets.js';
import {
  createWhatsAppAdapter,
  SIGNATURE_HEADER,
  WHATSAPP_CAPABILITIES,
  WHATSAPP_PROVIDER,
} from './whatsapp.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const PROJECT = 'melonoffice-test';
const PHONE_NUMBER_ID = '106540352242922';
// Test values only: stand-ins for what Secret Manager would hold.
const APP_SECRET = 'test-app-secret-value';
const ACCESS_TOKEN = 'test-access-token-value';
const VERIFY_TOKEN = 'test-verify-token-value';

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

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

const headers = (body: string, secret = APP_SECRET) =>
  new Headers({ [SIGNATURE_HEADER]: sign(body, secret), 'content-type': 'application/json' });

function payload(
  overrides: {
    phoneNumberId?: string;
    messages?: unknown[];
    statuses?: unknown[];
  } = {},
): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: 'Ana' }, wa_id: '15551234567' }],
              ...(overrides.statuses === undefined
                ? {
                    messages: overrides.messages ?? [
                      {
                        from: '15551234567',
                        id: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx',
                        timestamp: '1790510340',
                        type: 'text',
                        text: { body: 'Hola, quiero información' },
                      },
                    ],
                  }
                : { statuses: overrides.statuses }),
            },
          },
        ],
      },
    ],
  });
}

const connectionOf = (
  organizationId: OrganizationId,
  overrides: Partial<ChannelConnection> = {},
): ChannelConnection => ({
  id: CONNECTION,
  organizationId,
  provider: WHATSAPP_PROVIDER,
  category: 'messaging',
  channel: 'whatsapp',
  status: 'connected',
  displayName: 'Ventas',
  account: { phoneNumberId: PHONE_NUMBER_ID },
  capabilities: WHATSAPP_CAPABILITIES,
  secrets: secretRefsFor(PROJECT, CONNECTION),
  createdAt: T0.toISOString() as IsoTimestamp,
  createdBy: ALICE,
  updatedAt: T0.toISOString() as IsoTimestamp,
  updatedBy: ALICE,
  revision: 1,
  ...overrides,
});

async function codeOf(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof IntegrationError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function world(limit: number | 'unlimited' | 'unavailable' = 1) {
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(() => T0, audit);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  const connections = new InMemoryChannelConnectionRepository(audit);
  const secrets = new InMemorySecretStore();
  const refs = secretRefsFor(PROJECT, CONNECTION);
  secrets.put(refs.app_secret, APP_SECRET);
  secrets.put(refs.access_token, ACCESS_TOKEN);
  secrets.put(refs.verify_token, VERIFY_TOKEN);
  const conversations = new InMemoryConversationRepository(audit);
  const lines: string[] = [];
  const logger = createLogger({ service: 'test', sink: (line) => lines.push(line) });
  const registry = createIntegrationRegistry([createWhatsAppAdapter()]);
  const ingress = createIntegrationEngine({
    registry,
    connections,
    secrets,
    inbound: createConversationIngress({ repository: conversations, now: () => T0 }),
    logger,
  });
  const entitlements: Pick<EntitlementService, 'entitlementsOf'> = {
    entitlementsOf: async (tenant) =>
      limit === 'unavailable'
        ? { status: 'unavailable', reason: 'plan_missing' }
        : {
            status: 'active',
            organizationId: tenant.organizationId as OrganizationId,
            plan: { id: 'test-plan', version: 1 },
            values: {
              ...defaultValues(),
              'integrations.categoriesAllowed': ['messaging'],
              'integrations.connectionsMax': limit,
            },
          },
  };
  let ids = 0;
  const service = createChannelConnectionService({
    repository: connections,
    registry,
    organizations: tenancy,
    authorization: createAuthorizationService(),
    entitlements,
    secretProjectId: PROJECT,
    now: () => T0,
    newId: () => `eeeeeeee-eeee-4eee-8eee-${String(++ids).padStart(12, '0')}`,
  });
  return {
    audit,
    tenancy,
    orgA,
    orgB,
    connections,
    secrets,
    conversations,
    ingress,
    registry,
    service,
    entitlements,
    lines,
    tenantA: await resolveTenant(as(ALICE), orgA, tenancy),
    tenantB: await resolveTenant(as(BOB), orgB, tenancy),
  };
}

describe('secret references', () => {
  it('derives them from the connection id, and never holds a value', () => {
    const refs = secretRefsFor(PROJECT, CONNECTION);
    expect(refs.app_secret).toBe(
      `projects/${PROJECT}/secrets/channel-${CONNECTION}-app-secret/versions/latest`,
    );
    expect(Object.values(refs).every(isSecretRef)).toBe(true);
    expect(isSecretRef('projects/x/secrets/other/versions/1')).toBe(false);
    expect(() => secretRefFor('Bad Project', CONNECTION, 'app_secret')).toThrow(IntegrationError);
  });

  it('refuses an unknown reference in memory', async () => {
    const store = new InMemorySecretStore();
    expect(await codeOf(store.read('nope' as SecretRef))).toBe('secret_not_found');
  });
});

describe('Secret Manager store', () => {
  const ref = secretRefFor(PROJECT, CONNECTION, 'app_secret');
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads with the runtime identity and decodes the payload', async () => {
    const call = vi.fn<typeof fetch>(async (url) =>
      String(url) === METADATA_TOKEN_URL
        ? reply(200, { access_token: 'identity-token' })
        : reply(200, { payload: { data: Buffer.from(APP_SECRET).toString('base64') } }),
    );
    const store = createSecretManagerStore({ fetch: call });
    expect(await store.read(ref)).toBe(APP_SECRET);
    const [, access] = call.mock.calls;
    expect(String(access?.[0])).toBe(`https://secretmanager.googleapis.com/v1/${ref}:access`);
    expect(access?.[1]?.headers).toEqual({
      authorization: 'Bearer identity-token',
    });
  });

  it('answers not found or unavailable, never with what it read', async () => {
    const missing = createSecretManagerStore({
      fetch: (async (url: string) =>
        url === METADATA_TOKEN_URL ? reply(200, { access_token: 't' }) : reply(404, {})) as never,
    });
    expect(await codeOf(missing.read(ref))).toBe('secret_not_found');
    const down = createSecretManagerStore({
      fetch: (async () => {
        throw new Error('network down');
      }) as never,
    });
    expect(await codeOf(down.read(ref))).toBe('secret_unavailable');
    const denied = createSecretManagerStore({
      fetch: (async (url: string) =>
        url === METADATA_TOKEN_URL ? reply(200, { access_token: 't' }) : reply(403, {})) as never,
    });
    expect(await codeOf(denied.read(ref))).toBe('secret_unavailable');
    expect(await codeOf(missing.read('not-a-ref' as SecretRef))).toBe('secret_not_found');
  });
});

describe('WhatsApp adapter', () => {
  const adapter = createWhatsAppAdapter();

  it('verifies the signature over the exact raw body, constant-time', () => {
    const body = payload();
    expect(adapter.verifySignature(body, headers(body), APP_SECRET)).toBe(true);
    expect(adapter.verifySignature(`${body} `, headers(body), APP_SECRET)).toBe(false);
    expect(adapter.verifySignature(body, headers(body, 'other'), APP_SECRET)).toBe(false);
    expect(adapter.verifySignature(body, new Headers(), APP_SECRET)).toBe(false);
    expect(
      adapter.verifySignature(body, new Headers({ [SIGNATURE_HEADER]: 'sha256=zz' }), APP_SECRET),
    ).toBe(false);
    expect(adapter.verifySignature(body, headers(body, ''), '')).toBe(false);
  });

  it('answers the subscription handshake only with the right token', () => {
    const query = (token: string, mode = 'subscribe', challenge = '1158201444') =>
      new URLSearchParams({
        'hub.mode': mode,
        'hub.verify_token': token,
        'hub.challenge': challenge,
      });
    expect(adapter.handshake(query(VERIFY_TOKEN), VERIFY_TOKEN)).toBe('1158201444');
    expect(adapter.handshake(query('wrong'), VERIFY_TOKEN)).toBeUndefined();
    expect(adapter.handshake(query(VERIFY_TOKEN, 'unsubscribe'), VERIFY_TOKEN)).toBeUndefined();
    expect(adapter.handshake(query(VERIFY_TOKEN, 'subscribe', '<script>'), VERIFY_TOKEN)).toBe(
      undefined,
    );
  });

  it('normalizes text, media, location and delivery statuses', () => {
    const [text] = adapter.normalizeInbound(payload());
    expect(text?.accountId).toBe(PHONE_NUMBER_ID);
    expect(text?.messages[0]).toMatchObject({
      channel: 'whatsapp',
      externalMessageId: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx',
      from: { externalId: '15551234567', displayName: 'Ana', phone: '+15551234567' },
      type: 'text',
      text: 'Hola, quiero información',
      sentAt: new Date(1790510340 * 1000).toISOString(),
    });
    const [media] = adapter.normalizeInbound(
      payload({
        messages: [
          {
            from: '15551234567',
            id: 'wamid.image',
            timestamp: '1790510340',
            type: 'image',
            image: { id: '1234567890', mime_type: 'image/jpeg', caption: 'foto' },
          },
          { from: '15551234567', id: 'wamid.loc', timestamp: '1790510341', type: 'location' },
          { from: '15551234567', id: 'wamid.poll', timestamp: '1790510342', type: 'poll' },
        ],
      }),
    );
    expect(media?.messages.map((m) => m.type)).toEqual(['image', 'location', 'unsupported']);
    expect(media?.messages[0]).toMatchObject({
      text: 'foto',
      attachments: [{ providerMediaId: '1234567890', mimeType: 'image/jpeg' }],
    });
    const [statuses] = adapter.normalizeInbound(
      payload({
        statuses: [
          { id: 'wamid.out', status: 'delivered', timestamp: '1790510350' },
          {
            id: 'wamid.out',
            status: 'failed',
            timestamp: '1790510351',
            errors: [{ code: 131047 }],
          },
          { id: 'wamid.out', status: 'deleted', timestamp: '1790510352' },
        ],
      }),
    );
    expect(statuses?.statuses.map((s) => s.status)).toEqual(['delivered', 'failed']);
    expect(statuses?.statuses[1]?.failureCode).toBe('whatsapp_131047');
  });

  it('ignores changes that are not messages', () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'account_update', value: {} }] }],
    });
    expect(adapter.normalizeInbound(body)).toEqual([]);
  });

  it.each([
    ['not json', '{'],
    ['another object', JSON.stringify({ object: 'page', entry: [] })],
    [
      'no metadata',
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: {} }] }],
      }),
    ],
    [
      'a bad sender',
      payload({
        messages: [
          { from: 'x', id: 'wamid.a', timestamp: '1790510340', type: 'text', text: { body: 'a' } },
        ],
      }),
    ],
    [
      'an empty text',
      payload({
        messages: [
          {
            from: '15551234567',
            id: 'wamid.a',
            timestamp: '1790510340',
            type: 'text',
            text: { body: '' },
          },
        ],
      }),
    ],
    [
      'a bad timestamp',
      payload({
        messages: [
          {
            from: '15551234567',
            id: 'wamid.a',
            timestamp: 'now',
            type: 'text',
            text: { body: 'a' },
          },
        ],
      }),
    ],
    [
      'too many events',
      payload({
        messages: Array.from({ length: 101 }, (_, i) => ({
          from: '15551234567',
          id: `wamid.${i}`,
          timestamp: '1790510340',
          type: 'text',
          text: { body: 'a' },
        })),
      }),
    ],
  ])('refuses %s as invalid_payload', async (_case, body) => {
    expect(await codeOf(() => adapter.normalizeInbound(body))).toBe('invalid_payload');
  });

  describe('send', () => {
    const connection = connectionOf('0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId);
    const message = { to: '15551234567', text: 'Hola' };

    it('posts a text to the official Graph API with the access token', async () => {
      const fetch = vi.fn(
        async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.sent' }] })),
      );
      const sender = createWhatsAppAdapter({ graphApiVersion: 'v23.0', fetch: fetch as never });
      expect(await sender.send(connection, { accessToken: ACCESS_TOKEN }, message)).toEqual({
        externalMessageId: 'wamid.sent',
      });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`);
      expect(init.headers).toMatchObject({ authorization: `Bearer ${ACCESS_TOKEN}` });
      expect(JSON.parse(init.body as string)).toMatchObject({
        messaging_product: 'whatsapp',
        to: '15551234567',
        type: 'text',
        text: { body: 'Hola' },
      });
    });

    it('never guesses an API version, and maps provider answers to stable codes', async () => {
      expect(
        await codeOf(
          createWhatsAppAdapter().send(connection, { accessToken: ACCESS_TOKEN }, message),
        ),
      ).toBe('provider_unavailable');
      const answering = (status: number) =>
        createWhatsAppAdapter({
          graphApiVersion: 'v23.0',
          fetch: (async () => new Response('{}', { status })) as never,
        });
      expect(
        await codeOf(answering(429).send(connection, { accessToken: ACCESS_TOKEN }, message)),
      ).toBe('provider_unavailable');
      expect(
        await codeOf(answering(503).send(connection, { accessToken: ACCESS_TOKEN }, message)),
      ).toBe('provider_unavailable');
      expect(
        await codeOf(answering(400).send(connection, { accessToken: ACCESS_TOKEN }, message)),
      ).toBe('provider_rejected');
      expect(
        await codeOf(answering(200).send(connection, { accessToken: ACCESS_TOKEN }, message)),
      ).toBe('provider_unavailable');
      expect(
        await codeOf(
          answering(200).send(connection, { accessToken: ACCESS_TOKEN }, { to: 'x', text: 'Hola' }),
        ),
      ).toBe('invalid_outbound');
    });

    it('keeps the token out of every error', async () => {
      const sender = createWhatsAppAdapter({
        graphApiVersion: 'v23.0',
        fetch: (async () => new Response('{}', { status: 401 })) as never,
      });
      const error = await sender
        .send(connection, { accessToken: ACCESS_TOKEN }, message)
        .catch((e: unknown) => e);
      expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
      expect(String(error)).not.toContain(ACCESS_TOKEN);
    });
  });
});

describe('webhook ingress', () => {
  it('receives, verifies, persists and acknowledges a valid delivery', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = payload();
    const answer = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    expect(answer).toEqual({ status: 200, body: { received: 1, duplicates: 0, statuses: 0 } });
    const [conversation] = await w.conversations.listConversations(w.orgA);
    expect(conversation?.organizationId).toBe(w.orgA);
    expect(await w.conversations.listConversations(w.orgB)).toEqual([]);
  });

  it('stores a repeated delivery once', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = payload();
    await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    const again = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    expect(again.body).toEqual({ received: 0, duplicates: 1, statuses: 0 });
    const [conversation] = await w.conversations.listConversations(w.orgA);
    expect(await w.conversations.listMessages(w.orgA, conversation?.id as never)).toHaveLength(1);
  });

  it('refuses a bad signature and stores nothing', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = payload();
    const answer = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body, 'forged'));
    expect(answer).toEqual({ status: 401, body: { error: 'invalid_signature' } });
    expect(await w.conversations.listConversations(w.orgA)).toEqual([]);
  });

  it('refuses a signed but invalid payload', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: 'x' });
    const answer = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    expect(answer).toEqual({ status: 400, body: { error: 'invalid_payload' } });
  });

  it('refuses an unknown channel, connection or malformed id', async () => {
    const w = await world();
    const body = payload();
    expect((await w.ingress.deliver('telegram', CONNECTION, body, headers(body))).status).toBe(404);
    expect((await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body))).body).toEqual({
      error: 'connection_not_found',
    });
    expect((await w.ingress.deliver('whatsapp', '../x', body, headers(body))).status).toBe(404);
  });

  it('refuses a disconnected connection', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA, { status: 'disconnected' }));
    const body = payload();
    const answer = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    expect(answer).toEqual({ status: 403, body: { error: 'connection_disabled' } });
  });

  it("refuses events addressed to another account than the connection's", async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = payload({ phoneNumberId: '999999999999' });
    const answer = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    expect(answer).toEqual({ status: 403, body: { error: 'account_mismatch' } });
    expect(await w.conversations.listConversations(w.orgA)).toEqual([]);
  });

  it('answers 503 when the secret cannot be read, without saying why', async () => {
    const w = await world();
    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as ChannelConnectionId;
    w.connections.put(connectionOf(w.orgA, { id: other, secrets: secretRefsFor(PROJECT, other) }));
    const body = payload();
    const answer = await w.ingress.deliver('whatsapp', other, body, headers(body));
    expect(answer).toEqual({ status: 503, body: { error: 'unavailable' } });
  });

  it('applies delivery statuses to known outbound messages only', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = payload({
      statuses: [{ id: 'wamid.unknown', status: 'delivered', timestamp: '1790510350' }],
    });
    const answer = await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    expect(answer.body).toEqual({ received: 0, duplicates: 0, statuses: 0 });
  });

  it('answers the handshake with the verify token only', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const query = (token: string) =>
      new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': token,
        'hub.challenge': '42',
      });
    expect(await w.ingress.handshake('whatsapp', CONNECTION, query(VERIFY_TOKEN))).toEqual({
      status: 200,
      body: '42',
    });
    expect((await w.ingress.handshake('whatsapp', CONNECTION, query('nope'))).status).toBe(403);
  });

  it('never logs a secret, a signature or message content', async () => {
    const w = await world();
    w.connections.put(connectionOf(w.orgA));
    const body = payload();
    await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body));
    await w.ingress.deliver('whatsapp', CONNECTION, body, headers(body, 'forged'));
    await w.ingress.handshake(
      'whatsapp',
      CONNECTION,
      new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'x',
        'hub.challenge': '1',
      }),
    );
    const logged = w.lines.join('\n');
    expect(w.lines.length).toBeGreaterThan(0);
    for (const secret of [APP_SECRET, ACCESS_TOKEN, VERIFY_TOKEN, sign(body), 'Hola, quiero']) {
      expect(logged).not.toContain(secret);
    }
    expect(JSON.stringify(w.audit.events())).not.toContain(APP_SECRET);
  });
});

describe('channel connection service', () => {
  const input = {
    provider: WHATSAPP_PROVIDER,
    displayName: 'Ventas',
    account: { phoneNumberId: PHONE_NUMBER_ID, displayPhoneNumber: '+1 555 078 3881' },
  };

  it('creates a connection with derived references only, audited', async () => {
    const w = await world();
    const created = await w.service.create(w.tenantA, input);
    expect(created.secrets).toEqual(secretRefsFor(PROJECT, created.id));
    expect(created.organizationId).toBe(w.orgA);
    const [event] = w.audit.events().filter((e) => e.action === 'channel.connection_created');
    expect(event).toMatchObject({
      target: { type: 'channel_connection', id: created.id },
      reference: `provider:${WHATSAPP_PROVIDER}`,
      reason: 'created',
    });
    expect(created).toMatchObject({
      status: 'created',
      provider: WHATSAPP_PROVIDER,
      category: 'messaging',
      channel: 'whatsapp',
      capabilities: WHATSAPP_CAPABILITIES,
    });
    expect(await w.service.list(w.tenantB)).toEqual([]);
  });

  it('refuses a token or secret sent as account data', async () => {
    const w = await world();
    expect(
      await codeOf(
        w.service.create(w.tenantA, {
          ...input,
          account: { phoneNumberId: PHONE_NUMBER_ID, accessToken: ACCESS_TOKEN },
        }),
      ),
    ).toBe('invalid_connection');
  });

  it("is bounded by the plan's connection limit (unset = 0 = denied)", async () => {
    const w = await world(0);
    expect(await codeOf(w.service.create(w.tenantA, input))).toBe('limit_reached');
    const u = await world('unavailable');
    expect(await codeOf(u.service.create(u.tenantA, input))).toBe('entitlements_unavailable');
    const one = await world(1);
    await one.service.create(one.tenantA, input);
    expect(
      await codeOf(
        one.service.create(one.tenantA, { ...input, account: { phoneNumberId: '1234567890' } }),
      ),
    ).toBe('limit_reached');
    expect(await codeOf(one.service.create(one.tenantA, input))).toBe('invalid_connection');
  });

  it('only a person acting directly configures channels', async () => {
    const w = await world();
    const gia = await resolveTenant(as(ALICE, 'gia'), w.orgA, w.tenancy);
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(await codeOf(w.service.create(gia, input))).toBe('requires_user');
    expect(await codeOf(w.service.create(runtime, input))).toBe('requires_user');
    const narrow = createChannelConnectionService({
      repository: w.connections,
      registry: w.registry,
      organizations: w.tenancy,
      authorization: createAuthorizationService({ owner: ['channel.read'] } as never),
      entitlements: w.entitlements,
      secretProjectId: PROJECT,
    });
    expect(await codeOf(narrow.create(w.tenantA, input))).toBe('permission_denied');
    expect(await narrow.list(w.tenantA)).toEqual([]);
  });

  it('cannot create without a secret project', async () => {
    const w = await world();
    const unset = createChannelConnectionService({
      repository: w.connections,
      registry: w.registry,
      organizations: w.tenancy,
      authorization: createAuthorizationService(),
      entitlements: w.entitlements,
    });
    expect(await codeOf(unset.create(w.tenantA, input))).toBe('secret_unavailable');
  });

  it("disconnects a connection once, audited, and never another organization's", async () => {
    const w = await world();
    const created = await w.service.create(w.tenantA, input);
    expect(await codeOf(w.service.disconnect(w.tenantB, created.id))).toBe('connection_not_found');
    const off = await w.service.disconnect(w.tenantA, created.id);
    expect(off).toMatchObject({ status: 'disconnected', revision: 2, secrets: created.secrets });
    expect(await codeOf(w.service.disconnect(w.tenantA, created.id))).toBe('invalid_transition');
    expect(
      w.audit.events().filter((e) => e.action === 'channel.connection_disconnected'),
    ).toHaveLength(1);
  });
});
