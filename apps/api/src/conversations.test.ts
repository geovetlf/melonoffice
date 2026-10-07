import { DEFAULT_DEPARTMENT_CATALOGUE } from '@melonoffice/departments';
import type {
  ChannelConnection,
  ChannelConnectionId,
  ConversationId,
  ExecutionId,
  ExecutionNodeId,
  IsoTimestamp,
  MessageId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { secretRefsFor, WHATSAPP_CAPABILITIES, WHATSAPP_PROVIDER } from '@melonoffice/integrations';
import { createAuthorizationService, ROLES, type AuthorizationService } from '@melonoffice/rbac';
import { defaultToolRegistry } from '@melonoffice/tools';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@melonoffice/observability';
import { createApp } from './app.js';
import { MAX_WEBHOOK_BODY_BYTES } from './webhooks.js';
import { graphAccepted, setupApp, STORES, type Stores } from './test-api.js';

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
  readonly contact?: Json | null;
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
  async function setup(options: { authorization?: AuthorizationService; sending?: boolean } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(stores, options.authorization, undefined, undefined, undefined, {
      sending: options.sending ?? true,
    });
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
        provider: WHATSAPP_PROVIDER,
        category: 'messaging',
        channel: 'whatsapp',
        status: 'connected',
        capabilities: WHATSAPP_CAPABILITIES,
        displayName: 'Ventas',
        account: { phoneNumberId },
        secrets: secretRefsFor(PROJECT, id),
        createdAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        createdBy: aliceId,
        updatedAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        updatedBy: aliceId,
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
    /**
     * An agent handles the conversation. Nothing in CV-6A puts one in charge (hand-back only
     * resumes a conversation a person paused), so the test records it in the store the way a later
     * phase's assignment will.
     */
    const aiHandles = (org: OrganizationId, id: string) =>
      stores.conversations.updateConversation(org, id as ConversationId, (current) => ({
        conversation: {
          ...current,
          control: {
            handledBy: 'ai',
            aiState: 'active',
            epoch: 1,
            changedAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
          },
          revision: current.revision + 1,
        },
        events: [],
      }));
    return {
      ...ctx,
      stores,
      aiHandles,
      connect,
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

  describe('human control (CV-6A)', () => {
    it('keeps AI off until a person allows it, then lets a person take control and hand back', async () => {
      const t = await setup();
      // A message from a minute ago: a person's reply must fall inside WhatsApp's 24-hour window
      // whenever the test runs.
      const recent = String(Math.floor(Date.now() / 1000) - 60);
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A, { timestamp: recent }), APP_SECRET_A);
      const conversation = await t.firstConversation();
      const one = `${t.base(t.orgA)}/conversations/${conversation.id}`;
      const settings = `${t.base(t.orgA)}/conversation-settings`;
      expect(conversation).toMatchObject({
        control: { handledBy: 'human', aiState: 'off', changedAt: null },
        handoff: null,
      });
      expect(JSON.stringify(conversation)).not.toMatch(/epoch|revision/);
      expect((await t.request('token-alice', settings)).body).toMatchObject({ autonomy: 'manual' });

      // Manual: nothing can be handed to AI.
      const refused = await t.post('token-alice', `${one}/handback`, {});
      expect(refused).toMatchObject({ status: 409, body: { error: 'autonomy_not_enabled' } });

      const changed = await t.post('token-alice', `${settings}/autonomy`, {
        autonomy: 'autonomous',
      });
      expect(changed).toMatchObject({ status: 200, body: { autonomy: 'autonomous' } });
      // Hand-back only resumes a conversation a person paused: never one AI never handled.
      const never = await t.post('token-alice', `${one}/handback`, {});
      expect(never).toMatchObject({ status: 409, body: { error: 'invalid_transition' } });
      await t.aiHandles(t.orgA, conversation.id);

      // While AI handles it, a person's reply is refused and nothing is sent.
      const blocked = await t.post('token-alice', `${one}/messages`, {
        clientMessageId: 'web-1',
        text: 'Hola',
      });
      expect(blocked).toMatchObject({ status: 409, body: { error: 'conversation_handled_by_ai' } });

      const taken = await t.post('token-alice', `${one}/takeover`, {});
      expect(taken).toMatchObject({
        status: 200,
        body: { control: { handledBy: 'human', aiState: 'paused' } },
      });
      expect((await t.post('token-alice', `${one}/takeover`, {})).status).toBe(409);
      const sent = await t.post('token-alice', `${one}/messages`, {
        clientMessageId: 'web-2',
        text: 'Hola',
      });
      expect(sent.status).toBe(201);
      const handed = await t.post('token-alice', `${one}/handback`, {});
      expect(handed).toMatchObject({
        status: 200,
        body: { control: { handledBy: 'ai', aiState: 'active' } },
      });

      const actions = (await t.stores.auditEvents()).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'conversation.autonomy_changed',
          'conversation.ai_handed_back',
          'conversation.ai_human_takeover',
        ]),
      );
    });

    it('takes nothing from the browser: no organization, state, reason or level it invents', async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const conversation = await t.firstConversation();
      const one = `${t.base(t.orgA)}/conversations/${conversation.id}`;
      const settings = `${t.base(t.orgA)}/conversation-settings/autonomy`;
      for (const body of [
        { handledBy: 'ai' },
        { aiState: 'active' },
        { organizationId: t.orgB },
        { reason: 'customer_requested_human' },
      ]) {
        expect((await t.post('token-alice', `${one}/takeover`, body)).status).toBe(400);
        expect((await t.post('token-alice', `${one}/handback`, body)).status).toBe(400);
      }
      expect((await t.post('token-alice', settings, { autonomy: 'unlimited' })).status).toBe(400);
      expect(
        (await t.post('token-alice', settings, { autonomy: 'autonomous', organizationId: t.orgB }))
          .status,
      ).toBe(400);
      expect((await t.post('token-alice', settings, {})).status).toBe(400);
      // No route lets anyone escalate: that is the runtime's, never a request's.
      expect(
        (await t.post('token-alice', `${one}/escalate`, { reason: 'unresolved' })).status,
      ).toBe(404);
      expect(
        (await t.request('token-alice', `${t.base(t.orgA)}/conversation-settings`)).body,
      ).toMatchObject({
        autonomy: 'manual',
      });
    });

    it("never lets another organization read or change a conversation's control or settings", async () => {
      const t = await setup();
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const conversation = await t.firstConversation();
      await t.post('token-alice', `${t.base(t.orgA)}/conversation-settings/autonomy`, {
        autonomy: 'autonomous',
      });
      await t.aiHandles(t.orgA, conversation.id);
      // Bob in his own organization, naming Alice's conversation: missing.
      await t.post('token-bob', `${t.base(t.orgB)}/conversation-settings/autonomy`, {
        autonomy: 'autonomous',
      });
      const inB = `${t.base(t.orgB)}/conversations/${conversation.id}`;
      expect((await t.post('token-bob', `${inB}/takeover`, {})).status).toBe(404);
      expect((await t.post('token-bob', `${inB}/handback`, {})).status).toBe(404);
      // Bob naming Alice's organization: not a member.
      const inA = `${t.base(t.orgA)}/conversations/${conversation.id}`;
      expect((await t.post('token-bob', `${inA}/takeover`, {})).status).toBe(403);
      expect(
        (
          await t.post('token-bob', `${t.base(t.orgA)}/conversation-settings/autonomy`, {
            autonomy: 'manual',
          })
        ).status,
      ).toBe(403);
      expect((await t.request('token-bob', `${t.base(t.orgA)}/conversation-settings`)).status).toBe(
        403,
      );
      const still = await t.request('token-alice', inA);
      expect(still.body).toMatchObject({ control: { handledBy: 'ai', aiState: 'active' } });
    });
  });

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
        expect.objectContaining({ id: CONNECTION_A, status: 'connected', channel: 'whatsapp' }),
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

  describe('inbox (CV-3)', () => {
    /** Two conversations of A: Ana, then José (newest). */
    async function two(t: Awaited<ReturnType<typeof setup>>) {
      const now = Math.floor(Date.now() / 1000);
      await t.deliver(
        CONNECTION_A,
        whatsapp(PHONE_A, { timestamp: String(now - 120) }),
        APP_SECRET_A,
      );
      await t.deliver(
        CONNECTION_A,
        whatsapp(PHONE_A, {
          id: 'wamid.jose',
          from: '5215512345678',
          text: 'Precio por favor',
          timestamp: String(now - 60),
        }),
        APP_SECRET_A,
      );
      const [jose, ana] = (await t.conversationsOf()) as [ConversationJson, ConversationJson];
      return { jose, ana };
    }
    const list = (t: Awaited<ReturnType<typeof setup>>, query = '', token = 'token-alice') =>
      t.request(token, `${t.base(t.orgA)}/conversations${query}`);

    it('lists each conversation with who it is with, searched, filtered and sorted', async () => {
      const t = await setup();
      const { jose, ana } = await two(t);
      const all = await list(t);
      expect(all.body.conversations.map((c) => c.contact)).toEqual([
        { id: jose.contactId, displayName: 'Ana', phone: '+5215512345678' },
        { id: ana.contactId, displayName: 'Ana', phone: '+15551234567' },
      ]);
      const ids = async (query: string) =>
        (await list(t, query)).body.conversations.map((c) => c.id);
      expect(await ids('?q=%2B52%201%2055')).toEqual([jose.id]);
      expect(await ids('?q=ANA')).toEqual([jose.id, ana.id]);
      expect(await ids('?q=precio')).toEqual([]);
      await t.post('token-alice', `${t.base(t.orgA)}/conversations/${ana.id}/priority`, {
        priority: 'urgent',
      });
      expect(await ids('?sort=priority')).toEqual([ana.id, jose.id]);
      expect(await ids('?sort=created')).toEqual([jose.id, ana.id]);
      expect(await ids('?priority=urgent')).toEqual([ana.id]);
      expect(await ids('?status=open&unassigned=true&sort=last_activity')).toEqual([
        jose.id,
        ana.id,
      ]);
      for (const bad of ['sort=newest', 'priority=asap', 'q=a', 'q=x&q=y']) {
        expect((await list(t, `?${bad}`)).status).toBe(400);
      }
    });

    it('opens one conversation whole, with nothing secret in it', async () => {
      const t = await setup();
      const { jose } = await two(t);
      const detail = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${jose.id}/detail`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        conversation: { id: jose.id, status: 'open', priority: 'normal', tags: [] },
        contact: { id: jose.contactId, phone: '+5215512345678' },
        identity: { channel: 'whatsapp', externalId: '5215512345678', verification: 'provider' },
        messages: [{ direction: 'inbound', text: 'Precio por favor' }],
      });
      const raw = JSON.stringify(detail.body);
      for (const secret of [APP_SECRET_A, VERIFY_TOKEN, ACCESS_TOKEN, 'secrets/', 'revision']) {
        expect(raw).not.toContain(secret);
      }
      const limited = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${jose.id}/detail?limit=1`,
      );
      expect(limited.body.messages).toHaveLength(1);
      for (const bad of ['limit=0', 'limit=x', 'other=1']) {
        expect(
          (
            await t.request(
              'token-alice',
              `${t.base(t.orgA)}/conversations/${jose.id}/detail?${bad}`,
            )
          ).status,
        ).toBe(400);
      }
    });

    it('shows the person taking over the note an agent left, and only its own organization’s', async () => {
      const t = await setup();
      const { jose, ana } = await two(t);
      const path = (id: string) => `${t.base(t.orgA)}/conversations/${id}/detail`;
      // No hand-off: no note.
      expect((await t.request('token-alice', path(jose.id))).body.handoffSummary).toBeNull();
      const executionId = '5b1f2c7e-9a41-4c3e-8f0d-2a6b7c8d9e10' as ExecutionId;
      const note = 'Quiere cambiar la dirección del pedido 1042.';
      const handedOff = (id: string, by: ExecutionId) =>
        t.conversations.updateConversation(t.orgA, id as ConversationId, (current) => ({
          conversation: {
            ...current,
            control: {
              handledBy: 'human',
              aiState: 'escalated',
              epoch: 2,
              changedAt: '2026-09-27T12:05:00.000Z' as IsoTimestamp,
            },
            handoff: {
              reason: 'sensitive_operation',
              requestedAt: '2026-09-27T12:05:00.000Z' as IsoTimestamp,
              executionId: by,
            },
            revision: current.revision + 1,
          },
          events: [],
        }));
      await handedOff(jose.id, executionId);
      await t.agentOutputs.save({
        organizationId: t.orgA,
        executionId,
        nodeId: 'decide' as ExecutionNodeId,
        requestId: 'job-1',
        output: {
          structured: {
            action: 'handoff',
            reply: null,
            handoffReason: 'sensitive_operation',
            confidence: 'high',
            summary: note,
          },
        },
        createdAt: '2026-09-27T12:04:59.000Z' as IsoTimestamp,
      });
      const detail = await t.request('token-alice', path(jose.id));
      expect(detail.body).toMatchObject({
        conversation: { handoff: { reason: 'sensitive_operation' } },
        handoffSummary: note,
      });
      // The list and the conversation view never carry it, nor the execution behind it.
      expect(JSON.stringify(await t.conversationsOf())).not.toContain(note);
      expect(JSON.stringify(detail.body.conversation)).not.toContain(executionId);
      // A hand-off naming another organization's answer gets nothing from it.
      const theirs = '6c2a3d8f-0b52-4d4f-9a1e-3b7c8d9e0f21' as ExecutionId;
      await handedOff(ana.id, theirs);
      await t.agentOutputs.save({
        organizationId: t.orgB,
        executionId: theirs,
        nodeId: 'decide' as ExecutionNodeId,
        requestId: 'job-2',
        output: { structured: { action: 'handoff', summary: 'de B' } },
        createdAt: '2026-09-27T12:04:59.000Z' as IsoTimestamp,
      });
      const foreign = await t.request('token-alice', path(ana.id));
      expect(foreign.body.handoffSummary).toBeNull();
      expect(JSON.stringify(foreign.body)).not.toContain('de B');
    });

    it("never lets one organization read or change another's inbox (IDOR)", async () => {
      const t = await setup();
      const { jose } = await two(t);
      const path = `/conversations/${jose.id}`;
      // B, through its own organization, naming A's conversation: as if it did not exist.
      for (const suffix of ['', '/detail', '/messages']) {
        expect((await t.request('token-bob', `${t.base(t.orgB)}${path}${suffix}`)).status).toBe(
          404,
        );
      }
      expect(
        (await t.post('token-bob', `${t.base(t.orgB)}${path}/priority`, { priority: 'high' }))
          .status,
      ).toBe(404);
      expect(
        (await t.post('token-bob', `${t.base(t.orgB)}${path}/tags`, { add: ['vip'] })).status,
      ).toBe(404);
      // B naming A's organization: not a member.
      expect((await t.request('token-bob', `${t.base(t.orgA)}${path}/detail`)).status).toBe(403);
      expect((await list(t, '', 'token-bob')).status).toBe(403);
      // B's search never reaches A's contacts.
      expect(
        (await t.request('token-bob', `${t.base(t.orgB)}/conversations?q=ana`)).body.conversations,
      ).toEqual([]);
      const after = await t.request('token-alice', `${t.base(t.orgA)}${path}`);
      expect(after.body).toMatchObject({ priority: 'normal', tags: [] });
    });

    it('changes priority by a person with conversation.manage, audited', async () => {
      const t = await setup();
      const { ana } = await two(t);
      const path = `${t.base(t.orgA)}/conversations/${ana.id}/priority`;
      const changed = await t.post('token-alice', path, { priority: 'high' });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ id: ana.id, priority: 'high' });
      expect((await t.post('token-alice', path, { priority: 'high' })).status).toBe(409);
      expect((await t.post('token-alice', path, { priority: 'critical' })).status).toBe(400);
      expect((await t.post('token-alice', path, {})).status).toBe(400);
      expect(
        (await t.post('token-alice', path, { priority: 'low', organizationId: t.orgB })).status,
      ).toBe(400);
      const events = (await t.stores.auditEvents()).filter(
        (e) => e.action === 'conversation.priority_changed',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organizationId: t.orgA,
        actor: { type: 'user', userId: t.aliceId },
        target: { type: 'conversation', id: ana.id },
        transition: { from: 'normal', to: 'high' },
      });
    });

    it('lets a reader only read: no contacts, no search, no changes', async () => {
      const reader = createAuthorizationService({ owner: ['conversation.read'] } as never);
      const t = await setup({ authorization: reader });
      await t.deliver(CONNECTION_A, whatsapp(PHONE_A), APP_SECRET_A);
      const [one] = (await list(t)).body.conversations as [ConversationJson];
      expect(one.contact).toBeNull();
      expect((await list(t, '?q=ana')).status).toBe(403);
      const path = `${t.base(t.orgA)}/conversations/${one.id}`;
      expect((await t.request('token-alice', `${path}/detail`)).status).toBe(403);
      expect((await t.post('token-alice', `${path}/priority`, { priority: 'high' })).status).toBe(
        403,
      );
      expect((await t.post('token-alice', `${path}/status`, { status: 'closed' })).status).toBe(
        403,
      );
    });

    it('works a conversation end to end: assign, tag, prioritize, reply through CV-2, close', async () => {
      const t = await setup();
      const { ana } = await two(t);
      const path = `${t.base(t.orgA)}/conversations/${ana.id}`;
      const department = `${t.orgA}_${DEFAULT_DEPARTMENT_CATALOGUE.types[0]?.id}`;
      expect(
        (
          await t.post('token-alice', `${path}/assign`, {
            assigneeId: t.aliceId,
            departmentId: department,
          })
        ).status,
      ).toBe(200);
      expect((await t.post('token-alice', `${path}/tags`, { add: ['vip'] })).status).toBe(200);
      expect((await t.post('token-alice', `${path}/priority`, { priority: 'high' })).status).toBe(
        200,
      );
      // The reply is CV-2's send: the same route, through the tool gate.
      const reply = await t.post('token-alice', `${path}/messages`, {
        clientMessageId: 'inbox-reply-1',
        text: 'Hola Ana, te ayudo',
      });
      expect(reply.status).toBe(201);
      expect(t.meta.calls).toHaveLength(1);
      expect((await t.post('token-alice', `${path}/status`, { status: 'closed' })).status).toBe(
        200,
      );
      const detail = await t.request('token-alice', `${path}/detail`);
      expect(detail.body).toMatchObject({
        conversation: {
          status: 'closed',
          priority: 'high',
          tags: ['vip'],
          assigneeId: t.aliceId,
          departmentId: department,
          lastMessage: { direction: 'outbound', preview: 'Hola Ana, te ayudo' },
        },
      });
      const messages = detail.body.messages as Json[];
      expect(messages.map((m) => [m.direction, m.status])).toEqual([
        ['inbound', 'received'],
        ['outbound', 'sent'],
      ]);
      const actions = (await t.stores.auditEvents())
        .map((e) => e.action)
        .filter((a) => a.startsWith('conversation.'));
      expect(actions).toEqual([
        // Each stored inbound message, recorded once by the Integration Engine (ADR-0044).
        'conversation.message_received',
        'conversation.message_received',
        'conversation.assigned',
        'conversation.tags_changed',
        'conversation.priority_changed',
        'conversation.message_sent',
        'conversation.status_changed',
      ]);
    });
  });

  describe('send (CV-2, ADR-0034)', () => {
    /** A Unix time a given number of seconds ago, as WhatsApp sends it. */
    const ago = (seconds: number) => String(Math.floor(Date.now() / 1000) - seconds);
    const HOUR = 3600;

    /** A conversation of A whose contact last wrote `secondsAgo` ago. */
    async function conversationIn(t: Awaited<ReturnType<typeof setup>>, secondsAgo = 60) {
      await t.deliver(
        CONNECTION_A,
        whatsapp(PHONE_A, { timestamp: ago(secondsAgo) }),
        APP_SECRET_A,
      );
      return t.firstConversation();
    }
    const sendPath = (t: Awaited<ReturnType<typeof setup>>, org: string, id: string) =>
      `${t.base(org)}/conversations/${id}/messages`;
    const send = (
      t: Awaited<ReturnType<typeof setup>>,
      id: string,
      body: unknown = { clientMessageId: 'reply-1', text: 'Hola Ana, te ayudo' },
      token = 'token-alice',
      org: string = t.orgA,
    ) => t.post(token, sendPath(t, org, id), body);
    const outbound = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
      (
        await t.request('token-alice', `${t.base(t.orgA)}/conversations/${id}/messages`)
      ).body.messages.filter((m: Json) => m.direction === 'outbound');

    it('sends a person’s reply through the tool gate, from the conversation alone', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      const answer = await send(t, conversation.id);
      expect(answer.status).toBe(201);
      expect(answer.body.message).toMatchObject({
        conversationId: conversation.id,
        direction: 'outbound',
        sender: { kind: 'user', userId: t.aliceId },
        type: 'text',
        text: 'Hola Ana, te ayudo',
        status: 'sent',
        failureCode: null,
      });
      // One call to the official Cloud API, to the contact of the conversation, with the
      // connection's own token read from the secret store.
      expect(t.meta.calls).toHaveLength(1);
      const [call] = t.meta.calls;
      expect(call?.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_A}/messages`);
      expect(call?.init.headers).toMatchObject({ authorization: `Bearer ${ACCESS_TOKEN}` });
      expect(JSON.parse(call?.init.body as string)).toMatchObject({
        messaging_product: 'whatsapp',
        to: '15551234567',
        type: 'text',
        text: { body: 'Hola Ana, te ayudo' },
      });
      const after = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${conversation.id}`,
      );
      expect(after.body).toMatchObject({
        lastMessage: { direction: 'outbound', preview: 'Hola Ana, te ayudo' },
      });
      expect(after.body.lastOutboundAt).not.toBeNull();
      const events = await t.stores.auditEvents();
      const sent = events.filter((e) => e.action === 'conversation.message_sent');
      expect(sent).toEqual([
        expect.objectContaining({
          result: 'success',
          actor: { type: 'user', userId: t.aliceId, via: 'direct' },
          organizationId: t.orgA,
          target: { type: 'message', id: (answer.body.message as Json).id },
          reference: `conversation:${conversation.id}`,
          reason: 'whatsapp',
          tool: { id: 'message_send', version: 1 },
        }),
      ]);
      // The person is the actor of every step: no runtime, no specialist, no invented actor.
      for (const e of events.filter((e) => e.action.startsWith('tool.'))) {
        expect(e.actor).toEqual({ type: 'user', userId: t.aliceId, via: 'direct' });
      }
      expect(events.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          'execution.created',
          'tool.authorization_checked',
          'tool.execution_requested',
          'tool.execution_completed',
          'execution.verification_recorded',
        ]),
      );
      // No model is ever called.
      expect(events.filter((e) => e.action.startsWith('ai.'))).toEqual([]);
    });

    it('never sends the same message twice: the same key answers with the stored one', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      const first = await send(t, conversation.id);
      const again = await send(t, conversation.id);
      expect(again.status).toBe(200);
      expect((again.body.message as Json).id).toBe((first.body.message as Json).id);
      expect(t.meta.calls).toHaveLength(1);
      expect(await outbound(t, conversation.id)).toHaveLength(1);
      // The same key with another text is refused, never sent.
      const changed = await send(t, conversation.id, { clientMessageId: 'reply-1', text: 'Otro' });
      expect(changed).toEqual({ status: 409, body: { error: 'duplicate_request' } });
      expect(t.meta.calls).toHaveLength(1);
      // Another key is another message.
      expect(
        (await send(t, conversation.id, { clientMessageId: 'reply-2', text: 'Y otro' })).status,
      ).toBe(201);
      expect(t.meta.calls).toHaveLength(2);
    });

    it('takes nothing but the key and the text: no organization, recipient, account or token', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      for (const extra of [
        { organizationId: t.orgB },
        { tenantId: t.orgB },
        { to: '15559999999' },
        { channelConnectionId: CONNECTION_B },
        { credentialId: 'x' },
        { accessToken: 'x' },
        { contactId: MISSING },
        { channelIdentityId: MISSING },
        { messageId: MISSING },
      ]) {
        const answer = await send(t, conversation.id, {
          clientMessageId: 'reply-1',
          text: 'Hola',
          ...extra,
        });
        expect(answer).toEqual({ status: 400, body: { error: 'invalid_request' } });
      }
      for (const body of [
        {},
        { clientMessageId: 'reply-1' },
        { clientMessageId: 'has spaces', text: 'Hola' },
        { clientMessageId: 'reply-1', text: '' },
        { clientMessageId: 'reply-1', text: 'x'.repeat(4097) },
        { clientMessageId: 'reply-1', text: 7 },
      ]) {
        expect((await send(t, conversation.id, body)).status).toBe(400);
      }
      expect(t.meta.calls).toHaveLength(0);
      expect(await outbound(t, conversation.id)).toEqual([]);
    });

    it("never reaches another organization's conversation, connection or credentials", async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      // Bob, in B, naming A's conversation: it does not exist for him.
      expect(await send(t, conversation.id, undefined, 'token-bob', t.orgB)).toEqual({
        status: 404,
        body: { error: 'conversation_not_found' },
      });
      // Bob naming A's organization: not his.
      expect((await send(t, conversation.id, undefined, 'token-bob', t.orgA)).status).toBe(403);
      expect((await send(t, MISSING)).status).toBe(404);
      expect((await send(t, 'not-an-id')).status).toBe(404);
      expect(t.meta.calls).toHaveLength(0);
      // And B's own conversation is sent from B's connection, with B's token, never A's.
      await t.deliver(CONNECTION_B, whatsapp(PHONE_B, { timestamp: ago(60) }), APP_SECRET_B);
      const theirs = await t.firstConversation('token-bob', t.orgB);
      t.stores.secrets.put(
        secretRefsFor(PROJECT, CONNECTION_B).access_token,
        'test-access-token-b',
      );
      expect((await send(t, theirs.id, undefined, 'token-bob', t.orgB)).status).toBe(201);
      const [call] = t.meta.calls;
      expect(call?.url).toContain(`/${PHONE_B}/messages`);
      expect(call?.init.headers).toMatchObject({ authorization: 'Bearer test-access-token-b' });
    });

    it('refuses without conversation.send, and reserves nothing without every permission', async () => {
      const without = (permission: string) =>
        createAuthorizationService({
          owner: ROLES.owner.filter((p) => p !== permission),
        } as never);
      for (const permission of ['conversation.send', 'tool.execute', 'execution.start']) {
        const t = await setup({ authorization: without(permission) });
        const conversation = await conversationIn(t);
        const answer = await send(t, conversation.id);
        expect(answer).toEqual({ status: 403, body: { error: 'permission_denied' } });
        expect(await outbound(t, conversation.id)).toEqual([]);
        expect(t.meta.calls).toHaveLength(0);
      }
    });

    it('blocks a reply outside the 24h window: no template, no other channel, nothing stored', async () => {
      const t = await setup();
      const conversation = await conversationIn(t, 25 * HOUR);
      expect(await send(t, conversation.id)).toEqual({
        status: 409,
        body: { error: 'outside_messaging_window' },
      });
      expect(t.meta.calls).toHaveLength(0);
      expect(await outbound(t, conversation.id)).toEqual([]);
      const events = await t.stores.auditEvents();
      expect(events.filter((e) => e.action === 'conversation.message_send_failed')).toEqual([
        expect.objectContaining({ result: 'denied', reason: 'outside_messaging_window' }),
      ]);
      // Just inside the window, the reply goes.
      const inside = await setup();
      const recent = await conversationIn(inside, 23 * HOUR);
      expect((await send(inside, recent.id)).status).toBe(201);
    });

    it('records a refusal by Meta as failed, consistently, and never retries it', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      t.meta.answer = async () =>
        new Response(
          JSON.stringify({ error: { code: 131026, message: 'Message undeliverable' } }),
          {
            status: 400,
          },
        );
      const answer = await send(t, conversation.id);
      expect(answer.status).toBe(502);
      expect(answer.body).toMatchObject({
        error: 'external_send_failed',
        reason: 'invalid_destination',
        message: { status: 'failed', failureCode: 'invalid_destination' },
      });
      expect(JSON.stringify(answer.body)).not.toContain('undeliverable');
      const again = await send(t, conversation.id);
      expect(again.status).toBe(502);
      expect(t.meta.calls).toHaveLength(1);
      const after = await t.request(
        'token-alice',
        `${t.base(t.orgA)}/conversations/${conversation.id}`,
      );
      expect(after.body.lastOutboundAt).toBeNull();
      const events = await t.stores.auditEvents();
      expect(events.filter((e) => e.action === 'conversation.message_send_failed')).toEqual([
        expect.objectContaining({ result: 'failure', reason: 'invalid_destination' }),
      ]);
      // Meta's own window refusal (131047) is the same deterministic block.
      const late = await setup();
      const other = await conversationIn(late);
      late.meta.answer = async () =>
        new Response(JSON.stringify({ error: { code: 131047 } }), { status: 400 });
      expect(await send(late, other.id)).toMatchObject({
        status: 409,
        body: { error: 'outside_messaging_window', message: { status: 'failed' } },
      });
    });

    it('marks a lost answer unknown, and never resends it blindly', async () => {
      for (const lost of [
        async (): Promise<Response> => {
          throw new Error('socket hang up');
        },
        async () => new Response('bad gateway', { status: 502 }),
        async () => new Response('{"messages":[]}', { status: 200 }),
      ]) {
        const t = await setup();
        const conversation = await conversationIn(t);
        t.meta.answer = lost;
        const answer = await send(t, conversation.id);
        expect(answer.status).toBe(202);
        expect(answer.body).toMatchObject({
          error: 'external_send_unknown',
          message: { status: 'unknown', failureCode: 'outcome_unknown' },
        });
        t.meta.answer = graphAccepted();
        const again = await send(t, conversation.id);
        expect(again.status).toBe(202);
        expect(t.meta.calls).toHaveLength(1);
        const events = await t.stores.auditEvents();
        expect(events.filter((e) => e.action === 'conversation.message_send_unknown')).toHaveLength(
          1,
        );
      }
    });

    it('rate limiting fails it, and nothing was sent', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      t.meta.answer = async () => new Response('{}', { status: 429 });
      expect(await send(t, conversation.id)).toMatchObject({
        status: 502,
        body: { error: 'external_send_failed', reason: 'rate_limited' },
      });
    });

    it('refuses a closed conversation and a disabled or unreadable connection', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      await t.post('token-alice', `${t.base(t.orgA)}/conversations/${conversation.id}/status`, {
        status: 'closed',
      });
      expect(await send(t, conversation.id)).toEqual({
        status: 409,
        body: { error: 'conversation_closed' },
      });
      const off = await setup();
      const other = await conversationIn(off);
      const connection = await off.connect(off.orgA, CONNECTION_A, PHONE_A, APP_SECRET_A);
      await off.stores.putConnection({ ...connection, status: 'disconnected', revision: 2 });
      // A connection that is not connected is refused before anything is reserved (ADR-0044).
      expect(await send(off, other.id)).toEqual({
        status: 503,
        body: { error: 'channel_not_available' },
      });
      expect([...t.meta.calls, ...off.meta.calls]).toHaveLength(0);
    });

    it('keeps tokens and message text out of answers, logs and the audit trail', async () => {
      const t = await setup();
      const conversation = await conversationIn(t);
      const answers = [await send(t, conversation.id)];
      t.meta.answer = async () => new Response('{}', { status: 401 });
      answers.push(await send(t, conversation.id, { clientMessageId: 'reply-2', text: 'Segunda' }));
      const everything = [
        JSON.stringify(answers),
        t.lines.join('\n'),
        await t.stores.storedAudit(),
      ].join('\n');
      expect(everything).not.toContain(ACCESS_TOKEN);
      expect(everything).not.toContain('Bearer');
      expect(everything).not.toContain(APP_SECRET_A);
      const audit = await t.stores.storedAudit();
      expect(audit).not.toContain('Hola Ana, te ayudo');
      expect(audit).not.toContain('Segunda');
      // Observability: the attempt and its outcome, as structured events, without the text.
      expect(t.lines.join('\n')).toContain('human_message_send_attempt');
      expect(t.lines.join('\n')).toContain('human_message_send_success');
      expect(t.lines.join('\n')).toContain('human_message_send_failure');
      expect(t.lines.join('\n')).not.toContain('Hola Ana, te ayudo');
    });

    it('answers 503 where sending is not configured, and sends nothing', async () => {
      const t = await setup({ sending: false });
      const conversation = await conversationIn(t);
      expect(await send(t, conversation.id)).toEqual({
        status: 503,
        body: { error: 'sending_not_configured' },
      });
      expect(t.meta.calls).toHaveLength(0);
    });
  });
});

describe('the only send path is the tool gate (CV-2)', () => {
  it('exposes no other route that sends a message', async () => {
    const [[, memory]] = STORES as [[string, () => Stores]];
    const t = setupApp(memory());
    for (const path of ['send', 'reply', 'messages/send', 'template']) {
      const response = await t.app.request(
        `/v1/organizations/${MISSING}/conversations/${MISSING}/${path}`,
        t.as('token-alice', { method: 'POST', body: '{}' }),
      );
      expect([403, 404]).toContain(response.status);
    }
  });

  it('never calls an adapter from the API: its one send goes through the gate', () => {
    const source = ['app.ts', 'conversations.ts', 'webhooks.ts', 'server.ts', 'agent-turns.ts']
      .map((file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
      .join('\n');
    // The only way out is the tool gate (ADR-0034): the API never reaches a provider directly.
    expect(source.match(/\.send\(/g)).toEqual(['.send(']);
    expect(source).toContain('sender.send(');
    expect(source).toContain('createToolGate(');
    expect(source).not.toContain('graph.facebook.com');
    // The agent's handoff (CV-6B, ADR-0043), a person's follow-up (TL-1, ADR-0068), the
    // company memory search (RT-1, ADR-0130), the customer records summary (TL-2, ADR-0160) and
    // a workflow's follow-up (B6, ADR-0184) are internal: none reaches a channel. Only `message_send` has an external provider.
    const tools = defaultToolRegistry().list();
    expect(tools.map((t) => t.id)).toEqual([
      'message_send',
      'conversation_handoff',
      'follow_up_schedule',
      'knowledge_search',
      'customer_records_summary',
      'workflow_follow_up',
    ]);
    expect(
      tools.filter((t) => t.versions.some((v) => v.provider.kind === 'external')).map((t) => t.id),
    ).toEqual(['message_send']);
    // The API's own runtime (kickoff and resume only) has no executor at all.
    expect(source).toContain('executors: {},');
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
