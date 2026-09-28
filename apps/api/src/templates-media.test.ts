import type {
  ChannelConnection,
  ChannelConnectionId,
  ConversationId,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { secretRefsFor, WHATSAPP_CAPABILITIES, WHATSAPP_PROVIDER } from '@melonoffice/integrations';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Templates and media (CV-6D phase 2, ADR-0046), end to end through the API, the tool gate and
 * the Integration Engine, over a fake Graph API. The letters are the brief's tests A–O.
 */

const PROJECT = 'melonoffice-test';
const CONNECTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const CONNECTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as ChannelConnectionId;
const PHONE_A = '106540352242922';
const PHONE_B = '206540352242922';
const WABA_A = '102290129340398';
// Test values only: stand-ins for what Secret Manager would hold.
const APP_SECRET = 'test-app-secret-a';
const VERIFY_TOKEN = 'test-verify-token';
const ACCESS_TOKEN = 'test-access-token';
/** A signed, private media link: it must never reach a log or the audit trail. */
const PRIVATE_URL = 'https://cdn.example.com/files/p.jpg?signature=PRIVATE-SIGNATURE-123';
const CUSTOMER = 'Ana López Private';

/** What Meta holds on the account (its WhatsApp Manager): created and approved there. */
const META_TEMPLATES = [
  {
    name: 'order_update',
    language: 'es',
    status: 'APPROVED',
    category: 'UTILITY',
    parameter_format: 'POSITIONAL',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}' },
      { type: 'BODY', text: 'Hola {{1}}, tu pedido {{2}} está listo.' },
      { type: 'FOOTER', text: 'MelonOffice' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Ver', url: 'https://shop.example.com/o/{{1}}' },
          { type: 'QUICK_REPLY', text: 'Gracias' },
        ],
      },
    ],
  },
  {
    name: 'invoice_ready',
    language: 'es',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'DOCUMENT' },
      { type: 'BODY', text: 'Tu factura {{1}} está adjunta.' },
    ],
  },
  { name: 'spring_sale', language: 'es', status: 'PAUSED', components: [] },
  {
    name: 'named_greeting',
    language: 'es',
    status: 'APPROVED',
    parameter_format: 'NAMED',
    components: [{ type: 'BODY', text: 'Hola {{first_name}}' }],
  },
];

interface Json {
  readonly [key: string]: unknown;
}

const sign = (body: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;

const inbound = (secondsAgo: number) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_A,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_A },
              contacts: [{ profile: { name: 'Ana' }, wa_id: '15551234567' }],
              messages: [
                {
                  from: '15551234567',
                  id: `wamid.in${secondsAgo}`,
                  timestamp: String(Math.floor(Date.now() / 1000) - secondsAgo),
                  type: 'text',
                  text: { body: 'Hola' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

describe.each(STORES)('templates and media with storage in %s', (_name, createStores) => {
  async function setup(capabilities: ChannelConnection['capabilities'] = WHATSAPP_CAPABILITIES) {
    const stores: Stores = createStores();
    const ctx = setupApp(stores);
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
    const orgA = await create('token-alice', 'A');
    const orgB = await create('token-bob', 'B');
    const connect = async (
      organizationId: OrganizationId,
      id: ChannelConnectionId,
      phone: string,
    ) => {
      const connection: ChannelConnection = {
        id,
        organizationId,
        provider: WHATSAPP_PROVIDER,
        category: 'messaging',
        channel: 'whatsapp',
        status: 'connected',
        capabilities,
        displayName: 'Ventas',
        account: { phoneNumberId: phone },
        secrets: secretRefsFor(PROJECT, id),
        createdAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        createdBy: aliceId,
        updatedAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        updatedBy: aliceId,
        revision: 1,
      };
      await stores.putConnection(connection);
      stores.secrets.put(connection.secrets.app_secret, APP_SECRET);
      stores.secrets.put(connection.secrets.verify_token, VERIFY_TOKEN);
      stores.secrets.put(connection.secrets.access_token, ACCESS_TOKEN);
    };
    await connect(orgA, CONNECTION_A, PHONE_A);
    await connect(orgB, CONNECTION_B, PHONE_B);

    // Meta: the account's numbers and templates, and the sends, answered from `sendAnswers`.
    let sendAnswers: (() => Response | Promise<Response>)[] = [];
    let sent = 0;
    ctx.meta.answer = async (url) => {
      if (url.includes(`/${PHONE_A}?fields=id`)) {
        return new Response(JSON.stringify({ id: PHONE_A }));
      }
      if (url.includes(`/${WABA_A}/phone_numbers`)) {
        return new Response(JSON.stringify({ data: [{ id: PHONE_A }] }));
      }
      if (url.includes(`/${WABA_A}/message_templates`)) {
        const name = new URL(url).searchParams.get('name');
        return new Response(
          JSON.stringify({ data: META_TEMPLATES.filter((t) => t.name === name) }),
        );
      }
      if (url.endsWith('/messages')) {
        const next = sendAnswers.shift();
        if (next !== undefined) return next();
        sent += 1;
        return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent}` }] }));
      }
      return new Response('{}', { status: 404 });
    };

    const request = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Json };
    };
    const call = (token: string, method: string, path: string, body?: unknown) =>
      request(token, path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const base = (org: string) => `/v1/organizations/${org}`;
    const connectionPath = (org = orgA, id: string = CONNECTION_A) =>
      `${base(org)}/channel-connections/${id}`;
    /** A conversation of A whose contact last wrote `secondsAgo` ago. */
    const conversation = async (secondsAgo = 60): Promise<string> => {
      const body = inbound(secondsAgo);
      await ctx.app.request(`/webhooks/whatsapp/${CONNECTION_A}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        body,
      });
      const list = await request('token-alice', `${base(orgA)}/conversations`);
      const [first] = list.body.conversations as { id: string }[];
      if (first === undefined) throw new Error('no conversation');
      return first.id;
    };
    const register = async (name: string, language = 'es', org = orgA, token = 'token-alice') =>
      call(token, 'POST', `${connectionPath(org)}/templates`, { name, language });
    const withAccount = () =>
      call('token-alice', 'PATCH', connectionPath(), { businessAccountId: WABA_A });
    const send = (id: string, body: Json, token = 'token-alice', org: string = orgA) =>
      call(token, 'POST', `${base(org)}/conversations/${id}/messages`, body);
    const sends = () => ctx.meta.calls.filter((c) => c.url.endsWith('/messages'));
    const lastPayload = () => JSON.parse(sends().at(-1)?.init.body as string) as Json;
    const events = () => stores.auditEvents();
    return {
      ...ctx,
      stores,
      orgA,
      orgB,
      request,
      call,
      base,
      conversation,
      register,
      withAccount,
      send,
      sends,
      lastPayload,
      events,
      answerSends: (...answers: (() => Response | Promise<Response>)[]) => {
        sendAnswers = answers;
      },
    };
  }

  type T = Awaited<ReturnType<typeof setup>>;

  async function activeTemplate(t: T, name = 'order_update') {
    await t.withAccount();
    const registered = await t.register(name);
    expect(registered.status).toBe(201);
    return registered.body;
  }

  const orderValues = {
    header: ['A-1001'],
    body: [CUSTOMER, 'A-1001'],
    buttons: [{ index: 0, text: 'A-1001' }],
  };

  it('A. registers an approved template from Meta, and sends it with exactly its values', async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    expect(template).toMatchObject({
      name: 'order_update',
      language: 'es',
      status: 'active',
      category: 'utility',
      spec: {
        header: { format: 'text', parameters: 1 },
        bodyParameters: 2,
        urlButtons: [{ index: 0 }],
      },
    });
    // Meta was asked with the connection's own token, on its own account.
    expect(
      t.meta.calls.some((c) => c.url.includes(`/${WABA_A}/message_templates?name=order_update`)),
    ).toBe(true);
    const id = await t.conversation();
    const answer = await t.send(id, {
      clientMessageId: 'tpl-1',
      template: { templateId: template.id, values: orderValues },
    });
    expect(answer.status).toBe(201);
    expect(answer.body.message).toMatchObject({
      type: 'template',
      status: 'sent',
      template: { name: 'order_update', language: 'es', values: { body: [CUSTOMER, 'A-1001'] } },
    });
    expect(t.lastPayload()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'es' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'A-1001' }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: CUSTOMER },
              { type: 'text', text: 'A-1001' },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'A-1001' }],
          },
        ],
      },
    });
    const events = await t.events();
    const sent = events.find((e) => e.action === 'conversation.message_sent');
    expect(sent).toMatchObject({
      message: { type: 'template', template: 'order_update', language: 'es' },
      reference: `conversation:${id}`,
    });
    expect(events.find((e) => e.action === 'channel.delivery_attempted')).toMatchObject({
      result: 'success',
      attempt: 1,
      message: { type: 'template', template: 'order_update', language: 'es' },
    });
    expect(
      events.filter((e) => e.action.startsWith('channel.template_')).map((e) => e.action),
    ).toEqual(['channel.template_registered', 'channel.template_checked']);
  });

  it('B. a template that does not exist is refused, audited, and Meta is never asked to send it', async () => {
    const t = await setup();
    await t.withAccount();
    const missing = await t.register('no_such_template');
    expect(missing.body).toMatchObject({ status: 'invalid', statusReason: 'template_not_found' });
    const id = await t.conversation();
    // Registered but not approved: refused before anything is reserved.
    const refused = await t.send(id, {
      clientMessageId: 'tpl-b1',
      template: { templateId: missing.body.id, values: { body: [] } },
    });
    expect(refused).toMatchObject({ status: 409, body: { error: 'template_not_active' } });
    // Never registered at all.
    const unknown = await t.send(id, {
      clientMessageId: 'tpl-b2',
      template: { templateId: 'f'.repeat(64), values: { body: [] } },
    });
    expect(unknown).toMatchObject({ status: 404, body: { error: 'template_not_found' } });
    expect(t.sends()).toHaveLength(0);
    const denied = (await t.events()).filter(
      (e) => e.action === 'conversation.message_send_failed' && e.result === 'denied',
    );
    expect(denied.map((e) => e.reason)).toEqual(['template_not_active', 'template_not_found']);
    expect(denied[0]?.message).toEqual({ type: 'template' });
    // A paused template is not active either.
    expect((await t.register('spring_sale')).body).toMatchObject({
      status: 'invalid',
      statusReason: 'template_paused',
    });
    // Named parameters cannot be filled without guessing: refused.
    expect((await t.register('named_greeting')).body).toMatchObject({
      status: 'invalid',
      statusReason: 'template_named_parameters',
    });
  });

  it('C. an invalid language is refused, and one Meta does not have stays unusable', async () => {
    const t = await setup();
    await t.withAccount();
    expect(await t.register('order_update', 'spanish')).toMatchObject({
      status: 400,
      body: { error: 'invalid_template', field: 'language' },
    });
    const english = await t.register('order_update', 'en_US');
    expect(english.body).toMatchObject({
      status: 'invalid',
      statusReason: 'template_language_not_found',
    });
    const id = await t.conversation();
    expect(
      await t.send(id, {
        clientMessageId: 'tpl-c',
        template: { templateId: english.body.id, values: orderValues },
      }),
    ).toMatchObject({ status: 409, body: { error: 'template_not_active' } });
    expect(t.sends()).toHaveLength(0);
  });

  it('D. a missing or extra value is refused before Meta, audited, never retried', async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const id = await t.conversation();
    const missing = await t.send(id, {
      clientMessageId: 'tpl-d1',
      template: { templateId: template.id, values: { ...orderValues, body: [CUSTOMER] } },
    });
    expect(missing).toMatchObject({
      status: 422,
      body: { error: 'template_parameters_invalid', reason: 'template_parameter_missing' },
    });
    const extra = await t.send(id, {
      clientMessageId: 'tpl-d2',
      template: { templateId: template.id, values: { ...orderValues, buttons: [] } },
    });
    expect(extra.body).toMatchObject({ reason: 'template_parameter_missing' });
    const badValue = await t.send(id, {
      clientMessageId: 'tpl-d3',
      template: { templateId: template.id, values: { ...orderValues, body: ['a\nb', 'x'] } },
    });
    expect(badValue).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(t.sends()).toHaveLength(0);
    const denied = (await t.events()).filter(
      (e) => e.action === 'conversation.message_send_failed',
    );
    expect(denied.map((e) => e.reason)).toEqual([
      'template_parameter_missing',
      'template_parameter_missing',
    ]);
    // Nothing was reserved: no message, nothing to retry.
    const messages = await t.request(
      'token-alice',
      `${t.base(t.orgA)}/conversations/${id}/messages`,
    );
    expect((messages.body.messages as Json[]).filter((m) => m.direction === 'outbound')).toEqual(
      [],
    );
  });

  it('E and F. outside the 24-hour window only a template goes out; inside it, text and media too', async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const late = await t.conversation(25 * 3600);
    expect(await t.send(late, { clientMessageId: 'e-text', text: 'Hola' })).toMatchObject({
      status: 409,
      body: { error: 'outside_messaging_window' },
    });
    expect(
      await t.send(late, {
        clientMessageId: 'e-image',
        media: { type: 'image', url: PRIVATE_URL },
      }),
    ).toMatchObject({ status: 409, body: { error: 'outside_messaging_window' } });
    expect(t.sends()).toHaveLength(0);
    const templated = await t.send(late, {
      clientMessageId: 'e-template',
      template: { templateId: template.id, values: orderValues },
    });
    expect(templated).toMatchObject({ status: 201, body: { message: { status: 'sent' } } });
    expect(t.sends()).toHaveLength(1);

    const s = await setup();
    const fresh = await s.conversation(60);
    expect((await s.send(fresh, { clientMessageId: 'f-text', text: 'Hola' })).status).toBe(201);
    expect(
      (
        await s.send(fresh, {
          clientMessageId: 'f-audio',
          media: { type: 'audio', url: PRIVATE_URL },
        })
      ).status,
    ).toBe(201);
    expect(s.lastPayload()).toMatchObject({ type: 'audio', audio: { link: PRIVATE_URL } });
  });

  it('G. sends an image from a link with its caption; the link is never shown, logged or audited', async () => {
    const t = await setup();
    const id = await t.conversation();
    const answer = await t.send(id, {
      clientMessageId: 'g-1',
      text: 'Tu foto',
      media: { type: 'image', url: PRIVATE_URL },
    });
    expect(answer.status).toBe(201);
    expect(t.lastPayload()).toMatchObject({
      type: 'image',
      image: { link: PRIVATE_URL, caption: 'Tu foto' },
    });
    expect(answer.body.message).toMatchObject({
      type: 'image',
      text: 'Tu foto',
      media: { type: 'image', filename: null },
      status: 'sent',
    });
    expect(JSON.stringify(answer.body)).not.toContain('PRIVATE-SIGNATURE');
    const recorded = (await t.stores.storedAudit()) + t.lines.join('\n');
    expect(recorded).not.toContain('PRIVATE-SIGNATURE');
    expect(recorded).not.toContain('cdn.example.com');
    expect(
      (await t.events()).find((e) => e.action === 'conversation.message_sent')?.message,
    ).toEqual({
      type: 'image',
    });
    // Only https links to a host name: nothing else is accepted.
    for (const url of [
      'http://cdn.example.com/p.jpg',
      'https://127.0.0.1/p.jpg',
      'https://user:pw@cdn.example.com/p.jpg',
    ]) {
      expect(
        (await t.send(id, { clientMessageId: `g-${url.length}`, media: { type: 'image', url } }))
          .status,
      ).toBe(400);
    }
  });

  it('H. sends a document with its file name, and a template with a document header', async () => {
    const t = await setup();
    const id = await t.conversation();
    const answer = await t.send(id, {
      clientMessageId: 'h-1',
      text: 'Tu factura',
      media: { type: 'document', url: PRIVATE_URL, filename: 'factura-001.pdf' },
    });
    expect(answer.status).toBe(201);
    expect(t.lastPayload()).toMatchObject({
      type: 'document',
      document: { link: PRIVATE_URL, caption: 'Tu factura', filename: 'factura-001.pdf' },
    });
    expect(answer.body.message).toMatchObject({
      media: { type: 'document', filename: 'factura-001.pdf' },
    });
    const invoice = await activeTemplate(t, 'invoice_ready');
    expect(invoice.spec).toEqual({
      header: { format: 'document' },
      bodyParameters: 1,
      urlButtons: [],
    });
    const templated = await t.send(id, {
      clientMessageId: 'h-2',
      template: {
        templateId: invoice.id,
        values: {
          headerMedia: { type: 'document', url: PRIVATE_URL, filename: 'factura-001.pdf' },
          body: ['F-001'],
        },
      },
    });
    expect(templated.status).toBe(201);
    expect(t.lastPayload()).toMatchObject({
      template: {
        name: 'invoice_ready',
        components: [
          {
            type: 'header',
            parameters: [
              { type: 'document', document: { link: PRIVATE_URL, filename: 'factura-001.pdf' } },
            ],
          },
          { type: 'body', parameters: [{ type: 'text', text: 'F-001' }] },
        ],
      },
    });
    // A header of the wrong media type is refused before Meta.
    const calls = t.sends().length;
    const wrong = await t.send(id, {
      clientMessageId: 'h-3',
      template: {
        templateId: invoice.id,
        values: { headerMedia: { type: 'image', url: PRIVATE_URL }, body: ['F-001'] },
      },
    });
    expect(wrong.body).toMatchObject({ reason: 'template_header_mismatch' });
    expect(t.sends()).toHaveLength(calls);
  });

  it("I. Meta's refusal of a template is final: failed with its code, one call", async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const id = await t.conversation();
    t.answerSends(
      () =>
        new Response(JSON.stringify({ error: { code: 132001, message: 'x' } }), { status: 404 }),
    );
    const answer = await t.send(id, {
      clientMessageId: 'i-1',
      template: { templateId: template.id, values: orderValues },
    });
    expect(answer).toMatchObject({
      status: 404,
      body: { error: 'template_not_found', message: { status: 'failed' } },
    });
    expect(t.sends()).toHaveLength(1);
    expect((await t.events()).find((e) => e.action === 'channel.delivery_attempted')).toMatchObject(
      {
        result: 'failure',
        reason: 'template_not_found',
        message: { type: 'template', template: 'order_update', language: 'es' },
      },
    );
  });

  it('J. a transient error is retried under the phase 1 rules: the same message, sent once', async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const id = await t.conversation();
    t.answerSends(() => new Response('{}', { status: 429 }));
    const answer = await t.send(id, {
      clientMessageId: 'j-1',
      template: { templateId: template.id, values: orderValues },
    });
    expect(answer).toMatchObject({ status: 201, body: { message: { status: 'sent' } } });
    expect(t.sends()).toHaveLength(2);
    expect(t.sends()[0]?.init.body).toBe(t.sends()[1]?.init.body);
    const delivery = (await t.events())
      .filter((e) => e.action.startsWith('channel.delivery_'))
      .map((e) => [e.action, e.attempt, e.reason]);
    expect(delivery).toEqual([
      ['channel.delivery_attempted', 1, 'rate_limited'],
      ['channel.delivery_retry_scheduled', 1, 'rate_limited'],
      ['channel.delivery_attempted', 2, 'sent'],
    ]);
  });

  it('K. an unknown outcome is never retried, and never sent again', async () => {
    const t = await setup();
    const id = await t.conversation();
    t.answerSends(() => new Response('bad gateway', { status: 502 }));
    const body = { clientMessageId: 'k-1', media: { type: 'image', url: PRIVATE_URL } };
    const answer = await t.send(id, body);
    expect(answer).toMatchObject({
      status: 202,
      body: { error: 'external_send_unknown', message: { status: 'unknown' } },
    });
    expect(t.sends()).toHaveLength(1);
    expect((await t.send(id, body)).status).toBe(202);
    expect(t.sends()).toHaveLength(1);
  });

  it('L. an agent that takes the conversation during the retry wait stops the retry', async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const id = await t.conversation();
    t.answerSends(async () => {
      // While Meta refuses the first call, an agent takes the conversation.
      await t.stores.conversations.updateConversation(t.orgA, id as ConversationId, (current) => ({
        conversation: {
          ...current,
          control: {
            handledBy: 'ai',
            aiState: 'active',
            epoch: 1,
            changedAt: '2026-09-28T12:00:00.000Z' as IsoTimestamp,
          },
          revision: current.revision + 1,
        },
        events: [],
      }));
      return new Response('{}', { status: 429 });
    });
    const answer = await t.send(id, {
      clientMessageId: 'l-1',
      template: { templateId: template.id, values: orderValues },
    });
    expect(answer).toMatchObject({
      status: 409,
      body: { error: 'conversation_handled_by_ai', message: { status: 'failed' } },
    });
    expect(t.sends()).toHaveLength(1);
  });

  it("M. one organization never sees, registers on, or sends another's templates", async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const path = `${t.base(t.orgB)}/channel-connections/${CONNECTION_A}/templates`;
    expect((await t.request('token-bob', path)).status).toBe(404);
    expect(
      (await t.call('token-bob', 'POST', path, { name: 'order_update', language: 'es' })).status,
    ).toBe(404);
    expect((await t.request('token-bob', `${path}/${template.id as string}`)).status).toBe(404);
    // Bob's own connection cannot use Alice's template, even by its id.
    const body = inbound(60).replaceAll(PHONE_A, PHONE_B);
    await t.app.request(`/webhooks/whatsapp/${CONNECTION_B}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    const [bobs] = (await t.request('token-bob', `${t.base(t.orgB)}/conversations`)).body
      .conversations as { id: string }[];
    const answer = await t.send(
      bobs?.id as string,
      { clientMessageId: 'm-1', template: { templateId: template.id, values: orderValues } },
      'token-bob',
      t.orgB,
    );
    expect(answer).toMatchObject({ status: 404, body: { error: 'template_not_found' } });
    expect(t.sends()).toHaveLength(0);
    // And Alice's connection answers Bob as if it did not exist.
    expect(
      (
        await t.call(
          'token-bob',
          'PATCH',
          `${t.base(t.orgB)}/channel-connections/${CONNECTION_A}`,
          {
            businessAccountId: WABA_A,
          },
        )
      ).status,
    ).toBe(404);
  });

  it('N. no secret, link, value or number is ever logged or audited', async () => {
    const t = await setup();
    const template = await activeTemplate(t);
    const id = await t.conversation();
    t.answerSends(() => new Response('{}', { status: 429 }));
    await t.send(id, {
      clientMessageId: 'n-1',
      template: { templateId: template.id, values: orderValues },
    });
    await t.send(id, {
      clientMessageId: 'n-2',
      text: 'x',
      media: { type: 'image', url: PRIVATE_URL },
    });
    const recorded = (await t.stores.storedAudit()) + t.lines.join('\n');
    for (const secret of [
      ACCESS_TOKEN,
      APP_SECRET,
      VERIFY_TOKEN,
      'PRIVATE-SIGNATURE',
      CUSTOMER,
      '15551234567',
    ]) {
      expect(recorded).not.toContain(secret);
    }
  });

  it('O. sending a template or media, retries included, charges no credits', async () => {
    const t = await setup();
    const balance = async () =>
      (await t.request('token-alice', `${t.base(t.orgA)}/credits`)).body.balance;
    const before = await balance();
    const template = await activeTemplate(t);
    const id = await t.conversation();
    t.answerSends(() => new Response('{}', { status: 429 }));
    await t.send(id, {
      clientMessageId: 'o-1',
      template: { templateId: template.id, values: orderValues },
    });
    await t.send(id, { clientMessageId: 'o-2', media: { type: 'image', url: PRIVATE_URL } });
    expect(t.sends()).toHaveLength(3);
    expect(await balance()).toEqual(before);
    expect((await t.events()).filter((e) => e.action.startsWith('credits.'))).toEqual(
      (await t.events()).filter(
        (e) => e.action.startsWith('credits.') && e.reason !== 'ai_generation',
      ),
    );
  });

  it('records the business account once, and turns a template off', async () => {
    const t = await setup();
    const set = await t.withAccount();
    expect(set).toMatchObject({ status: 200, body: { account: { businessAccountId: WABA_A } } });
    expect((await t.withAccount()).status).toBe(400);
    const template = (await t.register('order_update')).body;
    const off = await t.call(
      'token-alice',
      'POST',
      `/v1/organizations/${t.orgA}/channel-connections/${CONNECTION_A}/templates/${template.id as string}/disable`,
    );
    expect(off.body).toMatchObject({ status: 'disabled' });
    const id = await t.conversation();
    expect(
      await t.send(id, {
        clientMessageId: 'x',
        template: { templateId: template.id, values: orderValues },
      }),
    ).toMatchObject({ status: 409, body: { error: 'template_not_active' } });
    // Checked again with Meta, it is active once more.
    const again = await t.call(
      'token-alice',
      'POST',
      `/v1/organizations/${t.orgA}/channel-connections/${CONNECTION_A}/templates/${template.id as string}/check`,
    );
    expect(again.body).toMatchObject({ status: 'active' });
  });

  it('refuses to read templates from an account that does not own the number', async () => {
    const t = await setup();
    await t.call('token-alice', 'PATCH', `${t.base(t.orgA)}/channel-connections/${CONNECTION_A}`, {
      businessAccountId: '999999999999999',
    });
    const registered = await t.register('order_update');
    expect(registered.body).toMatchObject({
      status: 'invalid',
      statusReason: 'account_not_accessible',
    });
    const s = await setup();
    expect((await s.register('order_update')).body).toMatchObject({
      status: 'invalid',
      statusReason: 'business_account_required',
    });
  });
  it('a connection made before phase 2 gains media and templates only by being checked again', async () => {
    // As stored by CV-6C: text only.
    const t = await setup({
      ...WHATSAPP_CAPABILITIES,
      outboundMedia: false,
      outboundTemplates: false,
    });
    const id = await t.conversation();
    const image = { type: 'image', url: 'https://cdn.example.com/a.jpg' };
    const refused = await t.send(id, { clientMessageId: 'old-1', media: image });
    expect(refused.body).toMatchObject({ error: 'capability_not_available' });
    expect(t.sends()).toHaveLength(0);

    // Pause and connect again (the web's own buttons): the check takes the adapter's capabilities.
    expect(
      (
        await t.call(
          'token-alice',
          'POST',
          `${t.base(t.orgA)}/channel-connections/${CONNECTION_A}/pause`,
        )
      ).status,
    ).toBe(200);
    const connected = await t.call(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/channel-connections/${CONNECTION_A}/connect`,
    );
    expect(connected.body).toMatchObject({ status: 'connected' });
    const sent = await t.send(id, { clientMessageId: 'old-2', media: image });
    expect(sent.status).toBe(201);
    expect(t.sends()).toHaveLength(1);
  });
});
