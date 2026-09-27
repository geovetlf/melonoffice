import { DEFAULT_DEPARTMENT_CATALOGUE } from '@melonoffice/departments';
import type {
  ChannelConnection,
  ChannelConnectionId,
  ConversationId,
  IsoTimestamp,
  MessageId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { secretRefsFor } from '@melonoffice/integrations';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import { defaultToolRegistry } from '@melonoffice/tools';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@melonoffice/observability';
import { createApp } from './app.js';
import { MAX_WEBHOOK_BODY_BYTES } from './webhooks.js';
import { setupApp, STORES, type Stores } from './test-api.js';

const PROJECT = 'melonoffice-test';
const CONNECTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const CONNECTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as ChannelConnectionId;
const PHONE_A = '106540352242922';
const PHONE_B = '206540352242922';
// Test values only: stand-ins for what Secret Manager would hold.
const APP_SECRET_A = 'test-app-secret-a';
const APP_SECRET_B = 'test-app-secret-b';
const VERIFY_TOKEN = 'test-verify-token';
const ACCESS_TOKEN = 'test-access-token';
const MISSING = '99999999-9999-4999-8999-999999999999';

interface View {
  organization: { id: string };
}

/** The JSON of an answer, loosely typed for assertions. */
interface Json {
  readonly [key: string]: Json | Json[] | string | number | boolean | null | undefined;
}
interface ConversationJson extends Json {
  readonly id: string;
  readonly contactId: string;
  readonly status: string;
}
interface Answer {
  readonly [key: string]: unknown;
  readonly conversations: ConversationJson[];
  readonly messages: Json[];
  readonly contacts: Json[];
  readonly connections: Json[];
  readonly identities: Json[];
}

const sign = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

function whatsapp(
  phoneNumberId: string,
  message: { id?: string; from?: string; text?: string; timestamp?: string } = {},
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
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Ana' }, wa_id: message.from ?? '15551234567' }],
              messages: [
                {
                  from: message.from ?? '15551234567',
                  id: message.id ?? 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx',
                  timestamp: message.timestamp ?? '1790510340',
                  type: 'text',
                  text: { body: message.text ?? 'Hola, quiero información' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe.each(STORES)('conversations with storage in %s', (_name, createStores) => {
  async function setup(options: { authorization?: AuthorizationService } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(stores, options.authorization);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
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
        ).json()) as View
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'A');
    const orgB = await create('token-bob', 'B');
    // Connections are configured on the server (no client route), with secrets in Secret Manager.
    const connect = async (
      organizationId: OrganizationId,
      id: ChannelConnectionId,
      phoneNumberId: string,
      appSecret: string,
    ) => {
      const connection: ChannelConnection = {
        id,
        organizationId,
        channel: 'whatsapp',
        status: 'active',
        displayName: 'Ventas',
        account: { phoneNumberId },
        secrets: secretRefsFor(PROJECT, id),
        createdAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        createdBy: aliceId,
        updatedAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        revision: 1,
      };
      await stores.putConnection(connection);
      stores.secrets.put(connection.secrets.app_secret, appSecret);
      stores.secrets.put(connection.secrets.verify_token, VERIFY_TOKEN);
      stores.secrets.put(connection.secrets.access_token, ACCESS_TOKEN);
      return connection;
    };
    await connect(orgA, CONNECTION_A, PHONE_A, APP_SECRET_A);
    await connect(orgB, CONNECTION_B, PHONE_B, APP_SECRET_B);
    const deliver = async (
      connectionId: string,
      body: string,
      secret: string,
      headers: Record<string, string> = {},
    ) => {
      const response = await ctx.app.request(`/webhooks/whatsapp/${connectionId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(body, secret),
          ...headers,
        },
        body,
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const request = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Answer };
    };
    const post = (token: string, path: string, body: unknown) =>
      request(token, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const base = (org: string) => `/v1/organizations/${org}`;
    const conversationsOf = async (token = 'token-alice', org: string = orgA) =>
      (await request(token, `${base(org)}/conversations`)).body.conversations;
    /** The first conversation listed, which the test expects to exist. */
    const firstConversation = async (token = 'token-alice', org: string = orgA) => {
      const [first] = await conversationsOf(token, org);
      if (first === undefined) throw new Error('no conversation');
      return first;
    };
    return {
      ...ctx,
      stores,
      aliceId,
      bobId,
      orgA,
      orgB,
      deliver,
      request,
      post,
      base,
      conversationsOf,
      firstConversation,
    };
  }

  describe('webhook', () => {
    it('stores a signed WhatsApp message in the organization of the connection', async () => {
      const t = await setup();
      const answer = await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      expect(answer).toEqual({ status: 200, body: { received: 1, duplicates: 0, statuses: 0 } });
      const conversation = await t.firstConversation();
      expect(conversation).toMatchObject({
        channel: 'whatsapp',
        connectionId: CONNECTION_A,
        status: 'open',
        assigneeId: null,
        departmentId: null,
        lastMessage: { direction: 'inbound', type: 'text', preview: 'Hola, quiero información' },
      });
      expect(await t.conversationsOf('token-bob', t.orgB)).toEqual([]);
    });

    it('stores a duplicate webhook once', async () => {
      const t = await setup();
      const body = whatsapp(PHONE_A);
      await t.deliver(CONNECTION_A, body, APP_SECRET_A);
      const again = await t.deliver(CONNECTION_A, body, APP_SECRET_A);
      expect(again.body).toEqual({ received: 0, duplicates: 1, statuses: 0 });
      const conversation = await t.firstConversation();
      const messages = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${conversation.id}/messages`,
      );
      expect(messages.body.messages).toHaveLength(1);
    });

    it('refuses an invalid signature, payload, channel or connection', async () => {
      const t = await setup();
      const body = whatsapp(PHONE_A);
      expect((await t.deliver(CONNECTION_A, body, 'forged')).status).toBe(401);
      expect((await t.deliver(CONNECTION_A, '{"object":1}', APP_SECRET_A)).status).toBe(400);
      expect((await t.deliver(MISSING, body, APP_SECRET_A)).status).toBe(404);
      expect((await t.deliver('not-a-uuid', body, APP_SECRET_A)).status).toBe(404);
      const response = await t.app.request(`/webhooks/telegram/${CONNECTION_A}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(body, APP_SECRET_A),
        },
        body,
      });
      expect(response.status).toBe(404);
      expect(await t.conversationsOf()).toEqual([]);
    });

    it('never takes the organization from the request', async () => {
      const t = await setup();
      // Signed with A's secret but naming B's account: refused, nothing stored anywhere.
      const crossed = await t.deliver(CONNECTION_A, whatsapp(PHONE_B), APP_SECRET_A);
      expect(crossed).toEqual({ status: 403, body: { error: 'account_mismatch' } });
      // B's connection with A's secret: the signature does not match.
      expect((await t.deliver(CONNECTION_B, whatsapp(PHONE_B), APP_SECRET_A)).status).toBe(401);
      // A query or header naming an organization changes nothing.
      const answer = await t.deliver(
        `${CONNECTION_A}?organizationId=${t.orgB}`,
        whatsapp(PHONE_A),
        APP_SECRET_A,
        { 'x-organization-id': t.orgB },
      );
      expect(answer.status).toBe(200);
      expect(await t.conversationsOf('token-bob', t.orgB)).toEqual([]);
      expect(await t.conversationsOf()).toHaveLength(1);
    });

    it('keeps the same number and provider message id apart across organizations', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const b = await t.deliver(CONNECTION_B, whatsapp(PHONE_B), APP_SECRET_B);
      expect(b.body).toEqual({ received: 1, duplicates: 0, statuses: 0 });
      const a = await t.firstConversation();
      const bConversation = await t.firstConversation('token-bob', t.orgB);
      expect(bConversation.id).not.toBe(a.id);
      expect(bConversation.contactId).not.toBe(a.contactId);
    });

    it('refuses a body that is too large or not JSON', async () => {
      const t = await setup();
      const big = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1);
      expect((await t.deliver(CONNECTION_A, big, APP_SECRET_A)).status).toBe(413);
      const response = await t.app.request(`/webhooks/whatsapp/${CONNECTION_A}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      });
      expect(response.status).toBe(415);
    });

    it('answers the subscription handshake with the verify token only', async () => {
      const t = await setup();
      const handshake = (token: string) =>
        t.app.request(
          `/webhooks/whatsapp/${CONNECTION_A}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
        );
      const ok = await handshake(VERIFY_TOKEN);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('1158201444');
      expect((await handshake('wrong')).status).toBe(403);
    });

    it('needs no user token, and a user token grants nothing', async () => {
      const t = await setup();
      const body = whatsapp(PHONE_A);
      const response = await t.app.request(
        `/webhooks/whatsapp/${CONNECTION_A}`,
        t.as('token-alice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      expect(response.status).toBe(401);
    });

    it('leaks no secret into responses, logs or the audit trail', async () => {
      const t = await setup();
      const body = whatsapp(PHONE_A);
      await t.deliver(CONNECTION_A, body, APP_SECRET_A);
      await t.deliver(CONNECTION_A, body, 'forged');
      await t.app.request(
        `/webhooks/whatsapp/${CONNECTION_A}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      );
      const connections = await t.request('token-alice', `${t.base(t.orgA)}/channel-connections`);
      const everything = [
        t.lines.join('\n'),
        await t.storedAudit(),
        JSON.stringify(connections.body),
      ].join('\n');
      for (const secret of [APP_SECRET_A, VERIFY_TOKEN, ACCESS_TOKEN, sign(body, APP_SECRET_A)]) {
        expect(everything).not.toContain(secret);
      }
      // Not even where the secrets live.
      expect(JSON.stringify(connections.body)).not.toContain('/secrets/');
      expect(connections.body.connections).toEqual([
        expect.objectContaining({ id: CONNECTION_A, status: 'active', channel: 'whatsapp' }),
      ]);
    });
  });

  describe('human inbox', () => {
    it('lists, reads and filters conversations and messages', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      await t.deliver(
        CONNECTION_A,
        whatsapp(PHONE_A, { id: 'wamid.two', from: '15559876543', timestamp: '1790510400' }),
        APP_SECRET_A,
      );
      const list = await t.request('token-alice', `${t.base(t.orgA)}/conversations`);
      expect(list.status).toBe(200);
      expect(list.body.conversations).toHaveLength(2);
      const [newest] = list.body.conversations as [ConversationJson];
      const one = await t.request('token-alice', `${t.base(t.orgA)}/conversations/${newest.id}`);
      expect(one.body.id).toBe(newest.id);
      expect(one.body).not.toHaveProperty('revision');
      const messages = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${newest.id}/messages?limit=10`,
      );
      expect(messages.body.messages[0]).toMatchObject({
        direction: 'inbound',
        sender: { kind: 'contact' },
        text: 'Hola, quiero información',
        status: 'received',
      });
      const filtered = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations?status=open&channel=whatsapp&unassigned=true&contactId=${newest.contactId}`,
      );
      expect(filtered.body.conversations.map((c: ConversationJson) => c.id)).toEqual([newest.id]);
      for (const bad of [
        'status=spam',
        'unknown=1',
        'limit=0',
        'limit=abc',
        'status=open&status=closed',
        'since=yesterday',
      ]) {
        expect(
          (await t.request('token-alice', `${t.base(t.orgA)}/conversations?${bad}`)).status,
        ).toBe(400);
      }
    });

    it('assigns to a member and a department, changes status and tags, audited', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const { id } = await t.firstConversation();
      const path = `${t.base(t.orgA)}/conversations/${id}`;
      const department = `${t.orgA}_${DEFAULT_DEPARTMENT_CATALOGUE.types[0]?.id}`;
      const assigned = await t.post('token-alice', `${path}/assign`, {
        assigneeId: t.aliceId,
        departmentId: department,
      });
      expect(assigned.body).toMatchObject({ assigneeId: t.aliceId, departmentId: department });
      expect(
        (await t.post('token-alice', `${path}/status`, { status: 'closed' })).body.status,
      ).toBe('closed');
      expect((await t.post('token-alice', `${path}/status`, { status: 'pending' })).status).toBe(
        409,
      );
      const tagged = await t.post('token-alice', `${path}/tags`, { add: ['vip', 'lead'] });
      expect(tagged.body.tags).toEqual(['lead', 'vip']);
      const byTag = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations?tag=vip&assigneeId=${t.aliceId}&departmentId=${department}`,
      );
      expect(byTag.body.conversations).toHaveLength(1);
      const actions = (await t.auditEvents()).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'conversation.assigned',
          'conversation.status_changed',
          'conversation.tags_changed',
        ]),
      );
    });

    it('refuses bad bodies, a non-member assignee and an unknown department', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const { id } = await t.firstConversation();
      const path = `${t.base(t.orgA)}/conversations/${id}`;
      expect((await t.post('token-alice', `${path}/assign`, { assigneeId: t.bobId })).status).toBe(
        409,
      );
      expect(
        (await t.post('token-alice', `${path}/assign`, { departmentId: `${t.orgB}_marketing` }))
          .status,
      ).toBe(404);
      expect((await t.post('token-alice', `${path}/assign`, { extra: 1 })).status).toBe(400);
      expect((await t.post('token-alice', `${path}/assign`, { assigneeId: 5 })).status).toBe(400);
      expect((await t.post('token-alice', `${path}/status`, {})).status).toBe(400);
      expect((await t.post('token-alice', `${path}/tags`, { add: 'vip' })).status).toBe(400);
      expect((await t.post('token-alice', `${path}/tags`, { add: ['Not A Tag'] })).status).toBe(
        400,
      );
    });

    it('reads contacts with their identities', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const contacts = await t.request('token-alice', `${t.base(t.orgA)}/contacts`);
      const [contact] = contacts.body.contacts as [Json];
      expect(contact).toMatchObject({
        displayName: 'Ana',
        phone: '+15551234567',
        origin: { kind: 'channel', channel: 'whatsapp', connectionId: CONNECTION_A },
      });
      const one = await t.request('token-alice', `${t.base(t.orgA)}/contacts/${contact.id}`);
      expect(one.body.identities).toEqual([
        expect.objectContaining({ externalId: '15551234567', verification: 'provider' }),
      ]);
      expect((await t.request('token-alice', `${t.base(t.orgA)}/contacts/${MISSING}`)).status).toBe(
        404,
      );
    });

    it("never reads or changes another organization's conversations or contacts", async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const { id, contactId } = await t.firstConversation();
      // Bob, owner of B, asks for A's records through his own organization: absent.
      const inB = `${t.base(t.orgB)}/conversations/${id}`;
      expect((await t.request('token-bob', inB)).status).toBe(404);
      expect((await t.request('token-bob', `${inB}/messages`)).status).toBe(404);
      expect((await t.post('token-bob', `${inB}/status`, { status: 'closed' })).status).toBe(404);
      expect((await t.post('token-bob', `${inB}/assign`, { assigneeId: t.bobId })).status).toBe(
        404,
      );
      expect((await t.post('token-bob', `${inB}/tags`, { add: ['x'] })).status).toBe(404);
      expect((await t.request('token-bob', `${t.base(t.orgB)}/contacts/${contactId}`)).status).toBe(
        404,
      );
      expect((await t.request('token-bob', `${t.base(t.orgB)}/contacts`)).body.contacts).toEqual(
        [],
      );
      // Through A's organization he is not a member: refused before anything is read.
      expect((await t.request('token-bob', `${t.base(t.orgA)}/conversations/${id}`)).status).toBe(
        403,
      );
      expect((await t.request('token-bob', `${t.base(t.orgA)}/channel-connections`)).status).toBe(
        403,
      );
      expect((await t.firstConversation()).status).toBe('open');
    });

    it('needs the conversation, contact and channel permissions', async () => {
      const t = await setup({
        authorization: createAuthorizationService({
          owner: ['organization.read', 'conversation.read'],
        } as never),
      });
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const { id } = await t.firstConversation();
      expect(
        (
          await t.post('token-alice', `${t.base(t.orgA)}/conversations/${id}/status`, {
            status: 'closed',
          })
        ).body,
      ).toEqual({ error: 'permission_denied' });
      expect((await t.request('token-alice', `${t.base(t.orgA)}/contacts`)).status).toBe(403);
      expect((await t.request('token-alice', `${t.base(t.orgA)}/channel-connections`)).status).toBe(
        403,
      );
      expect((await t.request('token', `${t.base(t.orgA)}/conversations`)).status).toBe(401);
    });

    it('applies delivery statuses to outbound messages from the webhook', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const conversation = await t.firstConversation();
      await t.stores.putOutbound({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as MessageId,
        organizationId: t.orgA,
        conversationId: conversation.id as ConversationId,
        channel: 'whatsapp',
        connectionId: CONNECTION_A,
        direction: 'outbound',
        externalMessageId: 'wamid.out',
        sender: { kind: 'user', userId: t.aliceId },
        type: 'text',
        text: 'Hola',
        attachments: [],
        status: 'sent',
        sentAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        createdAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
      });
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: PHONE_A },
                  statuses: [{ id: 'wamid.out', status: 'read', timestamp: '1790510400' }],
                },
              },
            ],
          },
        ],
      });
      expect((await t.deliver(CONNECTION_A, body, APP_SECRET_A)).body.statuses).toBe(1);
      // B's connection reporting on A's message changes nothing.
      const crossed = body.replace(PHONE_A, PHONE_B);
      expect((await t.deliver(CONNECTION_B, crossed, APP_SECRET_B)).body.statuses).toBe(0);
      const messages = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${conversation.id}/messages`,
      );
      expect(messages.body.messages.find((m: Json) => m.direction === 'outbound')?.status).toBe(
        'read',
      );
    });
  });
});

describe('no send path in CV-1', () => {
  it('exposes no route that sends a message', async () => {
    const [[, memory]] = STORES as [[string, () => Stores]];
    const t = setupApp(memory());
    for (const path of ['messages', 'send', 'reply']) {
      const response = await t.app.request(
        `/v1/organizations/${MISSING}/conversations/${MISSING}/${path}`,
        t.as('token-alice', { method: 'POST', body: '{}' }),
      );
      expect([403, 404]).toContain(response.status);
    }
  });

  it('never calls an adapter send from the API, and adds no tool', () => {
    const source = ['app.ts', 'conversations.ts', 'webhooks.ts', 'server.ts']
      .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
      .join('\n');
    // The only way out is the tool gate (CV-2): the API never reaches a provider directly.
    expect(source).not.toMatch(/\.send\(/);
    expect(source).not.toContain('graph.facebook.com');
    expect(defaultToolRegistry().list()).toEqual([]);
  });
});

describe('not configured', () => {
  it('fails closed: webhooks answer 503 without an ingress', async () => {
    const app = createApp({
      logger: createLogger({ service: 'api', sink: () => {} }),
      version: 't',
    });
    const response = await app.request(`/webhooks/whatsapp/${CONNECTION_A}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'channels_not_configured' });
  });
});
