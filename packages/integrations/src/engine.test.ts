import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  createConversationIngress,
  InMemoryConversationRepository,
} from '@melonoffice/conversations';
import { openWallet } from '@melonoffice/credits';
import type {
  ChannelConnection,
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { defaultValues, type EntitlementService } from '@melonoffice/entitlements';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { readdirSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapter.js';
import {
  createChannelConnectionService,
  InMemoryChannelConnectionRepository,
} from './connections.js';
import { createIntegrationEngine } from './engine.js';
import { IntegrationError } from './errors.js';
import {
  acceptsInbound,
  canTransition,
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  isOperational,
} from './lifecycle.js';
import { createIntegrationRegistry } from './registry.js';
import { InMemorySecretStore, secretRefsFor } from './secrets.js';
import {
  createWhatsAppAdapter,
  SIGNATURE_HEADER,
  WHATSAPP_CAPABILITIES,
  WHATSAPP_PROVIDER,
  WHATSAPP_SERVICE_WINDOW_MS,
} from './whatsapp.js';

/**
 * The Integration Engine (CV-6C, ADR-0044): the provider registry, the connection lifecycle, the
 * one path to an adapter in both directions, tenant isolation, idempotency and the plan's limits.
 */

const T0 = new Date('2026-09-28T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const PROJECT = 'melonoffice-test';
const PHONE_A = '106540352242922';
const PHONE_B = '206540352242922';
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

function inboundBody(phoneNumberId: string, id = 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx') {
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
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Ana' }, wa_id: '15551234567' }],
              messages: [
                {
                  from: '15551234567',
                  id,
                  timestamp: String(Math.floor(T0.getTime() / 1000) - 60),
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
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof IntegrationError) return error.code;
    throw error;
  }
  return 'accepted';
}

interface Graph {
  readonly calls: { url: string; init: RequestInit }[];
  answer: (url: string) => Response;
}

async function world(
  options: {
    readonly categories?: readonly string[];
    readonly limit?: number | 'unlimited';
    readonly permissions?: readonly string[];
  } = {},
) {
  let clock = T0;
  const now = () => clock;
  const store = new InMemoryAuditStore();
  const audit = createAuditService(store, now);
  const tenancy = new InMemoryTenancyStore(now, store);
  const create = { billing: BILLING, credits: openWallet };
  const orgA = (await createOrganization(as(ALICE), { name: 'A' }, tenancy, create)).organization
    .id;
  const orgB = (await createOrganization(as(BOB), { name: 'B' }, tenancy, create)).organization.id;
  const connections = new InMemoryChannelConnectionRepository(store);
  const secrets = new InMemorySecretStore();
  const conversations = new InMemoryConversationRepository(store);
  const lines: string[] = [];
  const logger = createLogger({ service: 'test', sink: (line) => lines.push(line) });
  const graph: Graph = {
    calls: [],
    answer: (url) =>
      url.includes('/messages')
        ? new Response(JSON.stringify({ messages: [{ id: `wamid.out${graph.calls.length}` }] }))
        : new Response(JSON.stringify({ id: url.includes(PHONE_B) ? PHONE_B : PHONE_A })),
  };
  const whatsapp = createWhatsAppAdapter({
    graphApiVersion: 'v23.0',
    fetch: vi.fn<typeof fetch>(async (url, init) => {
      graph.calls.push({ url: String(url), init: init ?? {} });
      return graph.answer(String(url));
    }),
  });
  const registry = createIntegrationRegistry([whatsapp]);
  const engine = createIntegrationEngine({
    registry,
    connections,
    secrets,
    inbound: createConversationIngress({ repository: conversations, now }),
    audit,
    logger,
    now,
  });
  const entitlements: Pick<EntitlementService, 'entitlementsOf'> = {
    entitlementsOf: async (tenant) => ({
      status: 'active',
      organizationId: tenant.organizationId as OrganizationId,
      plan: { id: 'test-plan', version: 1 },
      values: {
        ...defaultValues(),
        'integrations.categoriesAllowed': [...(options.categories ?? ['messaging'])],
        'integrations.connectionsMax': options.limit ?? 1,
      },
    }),
  };
  let ids = 0;
  const service = createChannelConnectionService({
    repository: connections,
    registry,
    organizations: tenancy,
    authorization: createAuthorizationService(
      options.permissions === undefined ? undefined : ({ owner: options.permissions } as never),
    ),
    entitlements,
    checker: engine,
    secretProjectId: PROJECT,
    now,
    newId: () => `eeeeeeee-eeee-4eee-8eee-${String(++ids).padStart(12, '0')}`,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  /** A connection made through the service, its secrets stored, checked with the provider. */
  const connected = async (
    tenant = tenantA,
    phoneNumberId = tenant === tenantA ? PHONE_A : PHONE_B,
  ): Promise<ChannelConnection> => {
    const created = await service.create(tenant, {
      provider: WHATSAPP_PROVIDER,
      displayName: 'Ventas',
      account: { phoneNumberId },
    });
    secrets.put(created.secrets.app_secret, APP_SECRET);
    secrets.put(created.secrets.access_token, ACCESS_TOKEN);
    secrets.put(created.secrets.verify_token, VERIFY_TOKEN);
    return service.connect(tenant, created.id);
  };
  const deliver = (
    connection: ChannelConnection,
    body = inboundBody(connection.account.phoneNumberId),
  ) =>
    engine.deliver(
      'whatsapp',
      connection.id,
      body,
      new Headers({ [SIGNATURE_HEADER]: sign(body), 'content-type': 'application/json' }),
    );
  return {
    store,
    tenancy,
    orgA,
    orgB,
    tenantA,
    tenantB,
    connections,
    secrets,
    conversations,
    registry,
    engine,
    service,
    graph,
    lines,
    connected,
    deliver,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** A text to the conversation the connection's contact started. */
async function sendIn(w: World, organizationId: OrganizationId, connection: ChannelConnection) {
  const [conversation] = await w.conversations.listConversations(connection.organizationId);
  if (conversation === undefined) throw new Error('no conversation');
  return w.engine.send({
    organizationId,
    connectionId: connection.id,
    channel: 'whatsapp',
    conversation,
    message: { to: '15551234567', text: 'Hola Ana' },
    actor: { actor: 'user', userId: ALICE },
  });
}

describe('provider registry', () => {
  it('holds the WhatsApp adapter as a channel adapter of an official provider', () => {
    const adapter: ChannelAdapter = createWhatsAppAdapter();
    const registry = createIntegrationRegistry([adapter]);
    expect(registry.find(WHATSAPP_PROVIDER)).toBe(adapter);
    expect(registry.forChannel('whatsapp')).toBe(adapter);
    expect(adapter).toMatchObject({
      provider: 'meta_whatsapp_cloud',
      category: 'messaging',
      channel: 'whatsapp',
      capabilities: WHATSAPP_CAPABILITIES,
    });
    for (const method of [
      'checkAccount',
      'accountIdOf',
      'verifySignature',
      'handshake',
      'normalizeInbound',
      'normalizeOutbound',
      'send',
      'validateConnection',
      'healthCheck',
    ] as const) {
      expect(typeof adapter[method]).toBe('function');
    }
    expect(registry.find('meta_whatsapp_proxy')).toBeUndefined();
  });

  it('refuses a provider twice, a channel twice or a malformed provider id', () => {
    const a = createWhatsAppAdapter();
    expect(() => createIntegrationRegistry([a, a])).toThrow(/twice/);
    expect(() =>
      createIntegrationRegistry([a, { ...a, provider: 'other_whatsapp' as never }]),
    ).toThrow(/channel served twice/);
    expect(() => createIntegrationRegistry([{ ...a, provider: 'Bad Id' as never }])).toThrow();
  });

  it('normalizes an outbound text to the official request body, and refuses a bad one', () => {
    const adapter = createWhatsAppAdapter();
    expect(adapter.normalizeOutbound({ to: '15551234567', text: 'Hola' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'Hola', preview_url: false },
    });
    expect(() => adapter.normalizeOutbound({ to: '+1 555', text: 'Hola' })).toThrow(
      IntegrationError,
    );
    expect(() => adapter.normalizeOutbound({ to: '15551234567', text: '' })).toThrow(
      IntegrationError,
    );
  });
});

describe('connection lifecycle', () => {
  it('allows only the declared transitions, and revoked is final', () => {
    expect(CONNECTION_TRANSITIONS.revoked).toEqual([]);
    for (const from of CONNECTION_STATUSES) {
      expect(canTransition(from, 'connected')).toBe(from === 'connecting');
    }
    expect(CONNECTION_STATUSES.filter(isOperationalStatus)).toEqual(['connected']);
    expect(CONNECTION_STATUSES.filter((status) => acceptsInbound({ status }))).toEqual([
      'connected',
      'paused',
      'error',
    ]);
  });

  it('is created, checked with the provider and connected, audited at each step', async () => {
    const w = await world();
    const connection = await w.connected();
    expect(connection).toMatchObject({
      status: 'connected',
      lastValidatedAt: T0.toISOString(),
      revision: 3,
      updatedBy: ALICE,
    });
    // The check reads the phone number's own node with the token: nothing is sent.
    expect(w.graph.calls.map((c) => c.url)).toEqual([
      `https://graph.facebook.com/v23.0/${PHONE_A}?fields=id`,
    ]);
    expect(w.graph.calls[0]?.init.method).toBeUndefined();
    const actions = w.store
      .events()
      .filter((e) => e.action.startsWith('channel.'))
      .map((e) => [e.action, e.reason]);
    expect(actions).toEqual([
      ['channel.connection_created', 'created'],
      ['channel.connection_updated', 'connecting'],
      ['channel.connection_checked', 'connected'],
    ]);
  });

  it('goes to error with the provider code when the credentials are refused or missing', async () => {
    const w = await world({ limit: 3 });
    w.graph.answer = () => new Response('{"error":{"code":190}}', { status: 401 });
    const refused = await w.connected();
    expect(refused).toMatchObject({ status: 'error', statusReason: 'channel_unauthorized' });
    const [failure] = w.store.events().filter((e) => e.action === 'channel.connection_checked');
    expect(failure).toMatchObject({ result: 'failure', reason: 'channel_unauthorized' });

    const created = await w.service.create(w.tenantA, {
      provider: WHATSAPP_PROVIDER,
      displayName: 'Soporte',
      account: { phoneNumberId: '306540352242922' },
    });
    expect(await w.service.connect(w.tenantA, created.id)).toMatchObject({
      status: 'error',
      statusReason: 'secret_not_found',
    });

    w.graph.answer = () => {
      throw new Error('offline');
    };
    expect(await w.service.connect(w.tenantA, refused.id)).toMatchObject({
      status: 'error',
      statusReason: 'no_answer',
    });
  });

  it('is paused, disconnected and deleted by a person, and never reused once deleted', async () => {
    const w = await world();
    const connection = await w.connected();
    await w.deliver(connection);
    expect((await w.service.pause(w.tenantA, connection.id)).status).toBe('paused');
    expect(await sendIn(w, w.orgA, connection)).toEqual({
      status: 'refused',
      code: 'channel_not_available',
    });
    // A paused connection still stores what contacts write.
    const again = await w.deliver(connection, inboundBody(PHONE_A, 'wamid.second'));
    expect(again.body).toMatchObject({ received: 1 });
    expect((await w.service.connect(w.tenantA, connection.id)).status).toBe('connected');
    expect((await w.service.disconnect(w.tenantA, connection.id)).status).toBe('disconnected');
    expect((await w.deliver(connection)).status).toBe(403);
    expect((await w.service.revoke(w.tenantA, connection.id)).status).toBe('revoked');
    expect(await codeOf(w.service.connect(w.tenantA, connection.id))).toBe('connection_revoked');
    expect(await codeOf(w.service.rename(w.tenantA, connection.id, 'Otra'))).toBe(
      'connection_revoked',
    );
    expect(
      w.store
        .events()
        .filter((e) =>
          [
            'channel.connection_paused',
            'channel.connection_disconnected',
            'channel.connection_revoked',
          ].includes(e.action),
        ),
    ).toHaveLength(3);
  });

  it('goes to error when the provider refuses its credentials during a send', async () => {
    const w = await world();
    const connection = await w.connected();
    await w.deliver(connection);
    w.graph.answer = () => new Response('{"error":{"code":190}}', { status: 401 });
    const result = await sendIn(w, w.orgA, connection);
    expect(result.status).toBe('failed');
    expect(await w.connections.find(w.orgA, connection.id)).toMatchObject({
      status: 'error',
      statusReason: 'channel_unauthorized',
    });
    const [event] = w.store.events().filter((e) => e.action === 'channel.connection_failed');
    expect(event).toMatchObject({ result: 'failure', reason: 'channel_unauthorized' });
    // Nothing more is sent until a person checks it again.
    expect(await sendIn(w, w.orgA, connection)).toEqual({
      status: 'refused',
      code: 'channel_not_available',
    });
  });
});

function isOperationalStatus(status: ChannelConnection['status']): boolean {
  return isOperational({ status });
}

describe('permissions and plan', () => {
  it('needs a separate permission to read, create, change, disconnect and delete', async () => {
    const owner = await world({ limit: 5 });
    const connection = await owner.connected();
    const only = async (permission: string) => {
      const w = await world({ limit: 5, permissions: [permission] });
      const create = await codeOf(
        w.service.create(w.tenantA, {
          provider: WHATSAPP_PROVIDER,
          displayName: 'X',
          account: { phoneNumberId: '406540352242922' },
        }),
      );
      // The owner's connected connection, as if it were this organization's.
      const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as ChannelConnection['id'];
      w.connections.put({
        ...connection,
        id,
        organizationId: w.orgA,
        secrets: secretRefsFor(PROJECT, id),
      });
      return {
        read: await codeOf(w.service.list(w.tenantA)),
        create,
        update: await codeOf(w.service.pause(w.tenantA, id)),
        disconnect: await codeOf(w.service.disconnect(w.tenantA, id)),
        delete: await codeOf(w.service.revoke(w.tenantA, id)),
      };
    };
    expect(await only('channel.read')).toEqual({
      read: 'accepted',
      create: 'permission_denied',
      update: 'permission_denied',
      disconnect: 'permission_denied',
      delete: 'permission_denied',
    });
    expect((await only('channel.create')).create).toBe('accepted');
    expect(await only('channel.update')).toMatchObject({
      update: 'accepted',
      disconnect: 'permission_denied',
      delete: 'permission_denied',
    });
    expect(await only('channel.disconnect')).toMatchObject({
      update: 'permission_denied',
      disconnect: 'accepted',
      delete: 'permission_denied',
    });
    expect(await only('channel.delete')).toMatchObject({
      update: 'permission_denied',
      disconnect: 'permission_denied',
      delete: 'accepted',
    });
  });

  it("is bounded by the plan's categories and connection limit; a free slot can be reused", async () => {
    const none = await world({ categories: [] });
    expect(
      await codeOf(
        none.service.create(none.tenantA, {
          provider: WHATSAPP_PROVIDER,
          displayName: 'Ventas',
          account: { phoneNumberId: PHONE_A },
        }),
      ),
    ).toBe('category_not_allowed');

    const w = await world({ limit: 1 });
    const first = await w.connected();
    const second = {
      provider: WHATSAPP_PROVIDER,
      displayName: 'Soporte',
      account: { phoneNumberId: '306540352242922' },
    };
    expect(await codeOf(w.service.create(w.tenantA, second))).toBe('limit_reached');
    await w.service.disconnect(w.tenantA, first.id);
    const made = await w.service.create(w.tenantA, second);
    // Connecting the first one again would take a second slot: refused.
    expect(await codeOf(w.service.connect(w.tenantA, first.id))).toBe('limit_reached');
    expect(made.status).toBe('created');
  });
});

describe('tenant isolation', () => {
  it("never lets one organization see, change or send through another's connection", async () => {
    const w = await world();
    const a = await w.connected(w.tenantA);
    const b = await w.connected(w.tenantB);
    expect(await codeOf(w.service.get(w.tenantA, b.id))).toBe('connection_not_found');
    expect(await codeOf(w.service.pause(w.tenantA, b.id))).toBe('connection_not_found');
    expect(await codeOf(w.service.revoke(w.tenantA, b.id))).toBe('connection_not_found');
    expect((await w.service.list(w.tenantA)).map((c) => c.id)).toEqual([a.id]);
    await w.deliver(b);
    const calls = w.graph.calls.length;
    // Organization A asking to send through B's connection: not found, nothing sent.
    expect(await sendIn(w, w.orgA, b)).toEqual({
      status: 'refused',
      code: 'channel_not_available',
    });
    expect(
      await w.engine.availability({
        organizationId: w.orgA,
        connectionId: b.id,
        channel: 'whatsapp',
      }),
    ).toBe('channel_not_available');
    expect(w.graph.calls).toHaveLength(calls);
    expect((await w.service.get(w.tenantB, b.id)).status).toBe('connected');
  });

  it("takes the organization from the connection, and refuses another account's events", async () => {
    const w = await world();
    const a = await w.connected(w.tenantA);
    await w.connected(w.tenantB);
    // B's phone number sent to A's webhook: refused, nothing stored anywhere.
    const answer = await w.deliver(a, inboundBody(PHONE_B));
    expect(answer).toEqual({ status: 403, body: { error: 'account_mismatch' } });
    expect(await w.conversations.listConversations(w.orgA)).toEqual([]);
    expect(await w.conversations.listConversations(w.orgB)).toEqual([]);
    await w.deliver(a);
    const [conversation] = await w.conversations.listConversations(w.orgA);
    expect(conversation).toMatchObject({ organizationId: w.orgA, connectionId: a.id });
    expect(await w.conversations.listConversations(w.orgB)).toEqual([]);
  });
});

describe('inbound', () => {
  it('stores a repeated event once, and records it received once', async () => {
    const w = await world();
    const connection = await w.connected();
    const first = await w.deliver(connection);
    const again = await w.deliver(connection);
    expect(first.body).toEqual({ received: 1, duplicates: 0, statuses: 0 });
    expect(again.body).toEqual({ received: 0, duplicates: 1, statuses: 0 });
    const received = w.store.events().filter((e) => e.action === 'conversation.message_received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      actor: { type: 'anonymous' },
      organizationId: w.orgA,
      reason: 'whatsapp',
    });
  });

  it('refuses a delivery before the connection was checked, but answers its handshake', async () => {
    const w = await world();
    const created = await w.service.create(w.tenantA, {
      provider: WHATSAPP_PROVIDER,
      displayName: 'Ventas',
      account: { phoneNumberId: PHONE_A },
    });
    w.secrets.put(created.secrets.app_secret, APP_SECRET);
    w.secrets.put(created.secrets.verify_token, VERIFY_TOKEN);
    expect((await w.deliver(created)).status).toBe(403);
    const query = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '42',
    });
    expect(await w.engine.handshake('whatsapp', created.id, query)).toEqual({
      status: 200,
      body: '42',
    });
    expect((await w.engine.deliver('whatsapp', created.id, '{}', new Headers())).status).toBe(403);
  });
});

describe('outbound', () => {
  it('sends through the official Graph API only for an operational, capable connection in its window', async () => {
    const w = await world();
    const connection = await w.connected();
    await w.deliver(connection);
    expect(await sendIn(w, w.orgA, connection)).toMatchObject({ status: 'sent' });
    const send = w.graph.calls.at(-1);
    expect(send?.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_A}/messages`);

    // The WhatsApp service window: 24 hours after the contact's last message, then nothing.
    w.advance(WHATSAPP_SERVICE_WINDOW_MS);
    const calls = w.graph.calls.length;
    expect(await sendIn(w, w.orgA, connection)).toEqual({
      status: 'refused',
      code: 'outside_messaging_window',
    });
    expect(w.graph.calls).toHaveLength(calls);
  });

  it('refuses what the connection cannot do, before any provider call', async () => {
    const w = await world();
    const connection = await w.connected();
    await w.deliver(connection);
    w.connections.put({
      ...connection,
      capabilities: { ...connection.capabilities, outboundText: false },
    });
    const calls = w.graph.calls.length;
    expect(await sendIn(w, w.orgA, connection)).toEqual({
      status: 'refused',
      code: 'capability_not_available',
    });
    w.connections.put({ ...connection, provider: 'unknown_provider' as never });
    expect(await sendIn(w, w.orgA, connection)).toEqual({
      status: 'refused',
      code: 'channel_not_available',
    });
    expect(w.graph.calls).toHaveLength(calls);
  });

  it('stops at the last check before the provider, and never logs a secret or the text', async () => {
    const w = await world();
    const connection = await w.connected();
    await w.deliver(connection);
    const [conversation] = await w.conversations.listConversations(w.orgA);
    const calls = w.graph.calls.length;
    const result = await w.engine.send({
      organizationId: w.orgA,
      connectionId: connection.id,
      channel: 'whatsapp',
      conversation: conversation as never,
      message: { to: '15551234567', text: 'Hola Ana' },
      actor: { actor: 'runtime', userId: ALICE },
      lastCheck: async () => 'conversation_handled_by_human',
    });
    expect(result).toEqual({ status: 'refused', code: 'conversation_handled_by_human' });
    expect(w.graph.calls).toHaveLength(calls);
    const logged = w.lines.join('\n');
    for (const secret of [
      APP_SECRET,
      ACCESS_TOKEN,
      VERIFY_TOKEN,
      'Hola Ana',
      'quiero información',
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(JSON.stringify(w.store.events())).not.toContain(ACCESS_TOKEN);
  });
});

describe('architecture', () => {
  it('reaches an adapter only through the Integration Engine', () => {
    const src = join(__dirname);
    const callers = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => !['engine.ts', 'whatsapp.ts', 'adapter.ts'].includes(f))
      .filter((f) =>
        /\.(send|normalizeInbound|verifySignature|handshake|validateConnection|healthCheck)\(/.test(
          readFileSync(join(src, f), 'utf8').replace(/engine\.(send|handshake)\(/g, ''),
        ),
      );
    expect(callers).toEqual([]);
  });
});
