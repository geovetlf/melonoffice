import { createConversationIngress } from '@melonoffice/conversations';
import type { ChannelConnectionId, IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;

describe.each(STORES)('opportunities and pipeline with storage in %s', (_name, createStores) => {
  async function setup(options: { readOnly?: boolean } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.readOnly
        ? createAuthorizationService({ owner: ['opportunity.read', 'contact.manage'] })
        : undefined,
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
    const base = (org: string) => `/v1/organizations/${org}`;
    const profile = (org: string, token: string, businessType: string) =>
      send(token, 'PUT', `${base(org)}/business-profile`, {
        businessType,
        country: 'PE',
        currency: 'PEN',
        timeZone: 'America/Lima',
        city: 'Lima',
      });
    const contact = async (token: string, org: string, phone: string) =>
      (await send(token, 'POST', `${base(org)}/customers`, { displayName: 'Rosa', phone })).body
        .id as string;
    return { ...ctx, stores, orgA, orgB, call, send, base, profile, contact };
  }

  it('proposes stages for the kind of business, then stores them with the first opportunity', async () => {
    const t = await setup();
    await t.profile(t.orgA, 'token-alice', 'restaurant');
    const proposed = await t.call('token-alice', `${t.base(t.orgA)}/pipeline`);
    expect(proposed.status).toBe(200);
    expect(proposed.body).toMatchObject({ stored: false, template: 'restaurant', revision: 0 });
    expect((proposed.body.stages as { id: string }[]).map((s) => s.id)).toEqual([
      'inquiry',
      'quote',
      'confirmation',
      'won',
      'lost',
    ]);
    const contactId = await t.contact('token-alice', t.orgA, '+51922222222');
    const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
      contactId,
      title: 'Cena de empresa',
      value: { amountMinor: 150000 },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      stageId: 'inquiry',
      status: 'open',
      probability: 20,
      value: { amountMinor: 150000, currency: 'PEN' },
      owner: null,
    });
    const stored = await t.call('token-alice', `${t.base(t.orgA)}/pipeline`);
    expect(stored.body).toMatchObject({ stored: true, revision: 1 });
    const list = await t.call('token-alice', `${t.base(t.orgA)}/opportunities?status=open`);
    expect(list.body.summary).toMatchObject({
      currency: 'PEN',
      open: { count: 1, valueMinor: 150000 },
      won: 0,
      lost: 0,
    });
  });

  it('wins an opportunity from a WhatsApp contact: the contact becomes a customer', async () => {
    const t = await setup();
    const { conversation } = await createConversationIngress({
      repository: t.stores.conversations,
    }).receive({
      organizationId: t.orgA,
      connectionId: CONNECTION,
      channel: 'whatsapp',
      externalMessageId: 'wamid.C2API1',
      from: { externalId: '51933333333', displayName: 'Luis', phone: '+51933333333' },
      type: 'text',
      text: 'Hola',
      attachments: [],
      sentAt: '2026-09-28T16:00:00.000Z' as IsoTimestamp,
    });
    const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
      contactId: conversation.contactId,
      title: 'Pedido mayorista',
    });
    const one = `${t.base(t.orgA)}/opportunities/${created.body.id as string}`;
    const won = await t.send('token-alice', 'PATCH', one, { revision: 1, stageId: 'won' });
    expect(won.body).toMatchObject({ status: 'won', probability: 100, revision: 2 });
    const detail = await t.call('token-alice', one);
    expect(detail.body).toMatchObject({
      contact: { id: conversation.contactId, stage: 'customer' },
      stage: { id: 'won', kind: 'won' },
      conversations: [{ id: conversation.id, channel: 'whatsapp' }],
    });
    const history = detail.body.history as { action: string; actor: string }[];
    expect(history.map((h) => h.action)).toEqual(['opportunity.won', 'opportunity.created']);
    expect(history.every((h) => h.actor === 'you')).toBe(true);
    const customers = await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=customer`);
    expect(customers.body.counts).toMatchObject({ customer: 1 });
    // A won opportunity is closed to other changes.
    expect(await t.send('token-alice', 'PATCH', one, { revision: 2, title: 'X' })).toEqual({
      status: 409,
      body: { error: 'opportunity_closed' },
    });
  });

  it('loses with a reason, keeps the contact a lead and never exposes personal data', async () => {
    const t = await setup();
    const contactId = await t.contact('token-alice', t.orgA, '+51944444444');
    const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
      contactId,
      title: 'Catering boda',
      value: { amountMinor: 880000, currency: 'PEN' },
    });
    const one = `${t.base(t.orgA)}/opportunities/${created.body.id as string}`;
    expect(
      (await t.send('token-alice', 'PATCH', one, { revision: 1, stageId: 'lost' })).body,
    ).toEqual({
      error: 'invalid_request',
      field: 'lostReason',
    });
    const lost = await t.send('token-alice', 'PATCH', one, {
      revision: 1,
      stageId: 'lost',
      lostReason: 'competitor',
    });
    expect(lost.body).toMatchObject({ status: 'lost', lostReason: 'competitor' });
    expect(
      (await t.call('token-alice', `${t.base(t.orgA)}/customers/${contactId}`)).body,
    ).toMatchObject({ commercial: { stage: 'lead' } });
    const trail = JSON.stringify(await t.auditEvents());
    for (const personal of ['Rosa', 'Catering', '880000', '944444444']) {
      expect(trail).not.toContain(personal);
    }
  });

  it('edits the stages against the revision and refuses removing one in use', async () => {
    const t = await setup();
    const contactId = await t.contact('token-alice', t.orgA, '+51955555555');
    await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
      contactId,
      title: 'Web',
      stageId: 'proposal',
    });
    const path = `${t.base(t.orgA)}/pipeline`;
    expect(
      await t.send('token-alice', 'PUT', path, {
        revision: 1,
        stages: [{ id: 'new', probability: 10 }, { id: 'won' }, { id: 'lost' }],
      }),
    ).toEqual({ status: 409, body: { error: 'stage_in_use' } });
    const saved = await t.send('token-alice', 'PUT', path, {
      revision: 1,
      stages: [
        { id: 'proposal', name: 'Cotización enviada', probability: 40 },
        { name: 'Visita', probability: 70 },
        { id: 'won' },
        { id: 'lost' },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ revision: 2, stored: true });
    expect((saved.body.stages as { name: string | null }[])[0]?.name).toBe('Cotización enviada');
    expect((await t.send('token-alice', 'PUT', path, { revision: 1, stages: [] })).body).toEqual({
      error: 'pipeline_concurrency_conflict',
    });
  });

  it('tells Company Brain the pipeline totals after a change', async () => {
    const t = await setup();
    await t.profile(t.orgA, 'token-alice', 'store');
    const contactId = await t.contact('token-alice', t.orgA, '+51966666666');
    await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
      contactId,
      title: 'Uniformes',
      value: { amountMinor: 50000 },
    });
    const brain = await t.call(
      'token-alice',
      `${t.base(t.orgA)}/brain/knowledge?domain=commercial`,
    );
    const items = brain.body.items as { key: string; value: unknown }[];
    expect(items.find((i) => i.key === 'open_opportunities_count')?.value).toEqual({
      type: 'number',
      number: 1,
    });
    expect(items.find((i) => i.key === 'open_pipeline_value')?.value).toEqual({
      type: 'money',
      amountMinor: 50000,
      currency: 'PEN',
    });
    expect(JSON.stringify(items)).not.toContain('Uniformes');
  });

  it("keeps each organization's opportunities to itself", async () => {
    const t = await setup();
    const contactId = await t.contact('token-alice', t.orgA, '+51977777777');
    const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
      contactId,
      title: 'Web',
    });
    const id = created.body.id as string;
    expect((await t.call('token-bob', `${t.base(t.orgB)}/opportunities/${id}`)).status).toBe(404);
    expect(
      (
        await t.send('token-bob', 'PATCH', `${t.base(t.orgB)}/opportunities/${id}`, {
          revision: 1,
          stageId: 'won',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.send('token-bob', 'POST', `${t.base(t.orgB)}/opportunities`, {
          contactId,
          title: 'X',
        })
      ).status,
    ).toBe(404);
    expect((await t.call('token-bob', `${t.base(t.orgA)}/opportunities`)).status).toBe(403);
    expect(
      ((await t.call('token-bob', `${t.base(t.orgB)}/opportunities`)).body.items as unknown[])
        .length,
    ).toBe(0);
  });

  it('lets a role with only opportunity.read look, not change', async () => {
    const t = await setup({ readOnly: true });
    expect((await t.call('token-alice', `${t.base(t.orgA)}/opportunities`)).status).toBe(200);
    expect((await t.call('token-alice', `${t.base(t.orgA)}/pipeline`)).status).toBe(200);
    const contactId = await t.contact('token-alice', t.orgA, '+51988888888');
    expect(
      (
        await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
          contactId,
          title: 'Web',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.send('token-alice', 'PUT', `${t.base(t.orgA)}/pipeline`, {
          revision: 0,
          stages: [],
        })
      ).status,
    ).toBe(403);
  });
});
