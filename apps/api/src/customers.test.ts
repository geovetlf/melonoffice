import { createConversationIngress } from '@melonoffice/conversations';
import type { ChannelConnectionId, IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;

describe.each(STORES)('customers and leads with storage in %s', (_name, createStores) => {
  async function setup(options: { readOnly?: boolean } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.readOnly ? createAuthorizationService({ owner: ['contact.read'] }) : undefined,
    );
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const call = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const send = (token: string, method: string, path: string, body: unknown) =>
      call(token, path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const create = async (token: string, name: string) =>
      (
        (await send(token, 'POST', '/v1/organizations', { name })).body as {
          organization: { id: string };
        }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'Pollería A');
    const orgB = await create('token-bob', 'Tienda B');
    const base = (org: string) => `/v1/organizations/${org}/customers`;
    const whatsapp = (organizationId: OrganizationId, phone: string, id: string) =>
      createConversationIngress({ repository: stores.conversations }).receive({
        organizationId,
        connectionId: CONNECTION,
        channel: 'whatsapp',
        externalMessageId: `wamid.${id}`,
        from: { externalId: phone.slice(1), displayName: 'Rosa', phone },
        type: 'text',
        text: 'Hola',
        attachments: [],
        sentAt: '2026-09-28T15:00:00.000Z' as IsoTimestamp,
      });
    const contactEvents = async () =>
      (await ctx.auditEvents()).filter((e) => e.action.startsWith('contact.'));
    return { ...ctx, orgA, orgB, call, send, base, whatsapp, contactEvents };
  }

  it('registers a lead, lists it with its counts and refuses the same phone twice', async () => {
    const t = await setup();
    const empty = await t.call('token-alice', t.base(t.orgA));
    expect(empty).toEqual({
      status: 200,
      body: {
        items: [],
        counts: { lead: 0, customer: 0, inactive: 0 },
        hasMore: false,
        nextCursor: null,
      },
    });
    const created = await t.send('token-alice', 'POST', t.base(t.orgA), {
      displayName: 'Carmen',
      phone: '+51 987 111 222',
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      displayName: 'Carmen',
      phone: '+51987111222',
      origin: 'user',
      revision: 1,
      commercial: { stage: 'lead', owner: null, source: 'manual', consent: 'unknown' },
    });
    const again = await t.send('token-alice', 'POST', t.base(t.orgA), {
      displayName: 'Carmen R.',
      phone: '0051987111222',
    });
    expect(again).toEqual({
      status: 409,
      body: { error: 'duplicate_contact', contactId: created.body.id },
    });
    const list = await t.call('token-alice', `${t.base(t.orgA)}?stage=lead`);
    expect(list.body.counts).toEqual({ lead: 1, customer: 0, inactive: 0 });
    expect((list.body.items as unknown[]).length).toBe(1);
    expect((await t.send('token-alice', 'POST', t.base(t.orgA), { displayName: 'X' })).status).toBe(
      400,
    );
  });

  it('marks a WhatsApp contact as a lead and a customer, the same contact', async () => {
    const t = await setup();
    const { conversation } = await t.whatsapp(t.orgA, '+51922222222', 'C1API1');
    const one = `${t.base(t.orgA)}/${conversation.contactId}`;
    const before = await t.call('token-alice', one);
    expect(before.body).toMatchObject({ commercial: null, revision: 0, origin: 'channel' });
    const lead = await t.send('token-alice', 'PATCH', one, { revision: 0, stage: 'lead' });
    expect(lead.body).toMatchObject({ commercial: { stage: 'lead', source: 'channel' } });
    const me = await t.call('token-alice', '/v1/me');
    const customer = await t.send('token-alice', 'PATCH', one, {
      revision: 1,
      stage: 'customer',
      ownerId: (me.body as { userId: string }).userId,
      consent: { messaging: 'granted', recordedBy: 'contact' },
      nextAction: { text: 'Llamar para el pedido', dueOn: '2026-10-01' },
    });
    expect(customer.body).toMatchObject({
      revision: 2,
      commercial: {
        stage: 'customer',
        owner: 'you',
        consent: 'granted',
        nextAction: { text: 'Llamar para el pedido', dueOn: '2026-10-01' },
      },
    });
    // A stale revision is refused; a later message from the same phone keeps the same contact.
    expect(
      (await t.send('token-alice', 'PATCH', one, { revision: 1, stage: 'inactive' })).body,
    ).toEqual({ error: 'contact_concurrency_conflict' });
    const later = await t.whatsapp(t.orgA, '+51922222222', 'C1API2');
    expect(later.conversation.contactId).toBe(conversation.contactId);
    expect((await t.call('token-alice', one)).body).toMatchObject({
      commercial: { stage: 'customer' },
    });
    // Notes.
    const note = await t.send('token-alice', 'POST', `${one}/notes`, { text: 'Prefiere entrega' });
    expect(note.body).toMatchObject({ text: 'Prefiere entrega', author: 'you' });
    expect(((await t.call('token-alice', one)).body.notes as unknown[]).length).toBe(1);
    // The audit trail says what changed, never who the person is.
    const events = await t.contactEvents();
    // Events of one change share a time, so compare them regardless of the store's order.
    expect(events.map((e) => e.action).sort()).toEqual([
      'contact.consent_changed',
      'contact.note_added',
      'contact.owner_changed',
      'contact.stage_changed',
      'contact.stage_changed',
      'contact.updated',
    ]);
    const trail = JSON.stringify(events);
    for (const personal of ['51922222222', 'Rosa', 'Llamar', 'Prefiere']) {
      expect(trail).not.toContain(personal);
    }
  });

  it('tells Company Brain the totals after a change', async () => {
    const t = await setup();
    await t.send('token-alice', 'POST', t.base(t.orgA), {
      displayName: 'Luis',
      email: 'Luis@Example.com',
    });
    const brain = await t.call(
      'token-alice',
      `/v1/organizations/${t.orgA}/brain/knowledge?domain=customers`,
    );
    const items = brain.body.items as { key: string; value: unknown }[];
    expect(items.find((i) => i.key === 'leads_count')?.value).toEqual({
      type: 'number',
      number: 1,
    });
    expect(JSON.stringify(items)).not.toContain('Luis');
  });

  it("keeps each organization's customers to itself", async () => {
    const t = await setup();
    const created = await t.send('token-alice', 'POST', t.base(t.orgA), {
      displayName: 'Carmen',
      phone: '+51987111222',
    });
    const id = created.body.id as string;
    // Bob, in his own organization, naming Alice's contact: missing.
    expect((await t.call('token-bob', `${t.base(t.orgB)}/${id}`)).status).toBe(404);
    expect(
      (
        await t.send('token-bob', 'PATCH', `${t.base(t.orgB)}/${id}`, {
          revision: 1,
          stage: 'customer',
        })
      ).status,
    ).toBe(404);
    // Bob naming Alice's organization: not a member.
    expect((await t.call('token-bob', t.base(t.orgA))).status).toBe(403);
    // The same phone in Bob's organization is his own contact.
    expect(
      (
        await t.send('token-bob', 'POST', t.base(t.orgB), {
          displayName: 'Carmen',
          phone: '+51987111222',
        })
      ).status,
    ).toBe(200);
    expect((await t.call('token-bob', t.base(t.orgB))).body.counts).toEqual({
      lead: 1,
      customer: 0,
      inactive: 0,
    });
  });

  it('refuses a responsible person who is not a member', async () => {
    const t = await setup();
    const created = await t.send('token-alice', 'POST', t.base(t.orgA), {
      displayName: 'Carmen',
      phone: '+51987111222',
    });
    const bob = await t.call('token-bob', '/v1/me');
    const answer = await t.send('token-alice', 'PATCH', `${t.base(t.orgA)}/${created.body.id}`, {
      revision: 1,
      ownerId: (bob.body as { userId: string }).userId,
    });
    expect(answer).toEqual({ status: 409, body: { error: 'owner_not_member' } });
  });

  it('lets a role with only contact.read look, not change', async () => {
    const t = await setup({ readOnly: true });
    expect((await t.call('token-alice', t.base(t.orgA))).status).toBe(200);
    expect(
      (
        await t.send('token-alice', 'POST', t.base(t.orgA), {
          displayName: 'A',
          phone: '+51900000000',
        })
      ).status,
    ).toBe(403);
  });
});
