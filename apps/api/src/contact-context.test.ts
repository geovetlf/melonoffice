import { createConversationIngress } from '@melonoffice/conversations';
import type { ChannelConnectionId, IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import { createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;

/** C3 (ADR-0055): a contact's card shows its conversations, opportunities and history. */
describe.each(STORES)(
  "a contact's commercial context with storage in %s",
  (_name, createStores) => {
    async function setup(permissions?: Permission[]) {
      const stores: Stores = createStores();
      const ctx = setupApp(
        stores,
        permissions === undefined ? undefined : createAuthorizationService({ owner: permissions }),
      );
      await ctx.register('token-alice');
      await ctx.register('token-bob');
      const call = async (token: string, path: string, init: RequestInit = {}) => {
        const response = await ctx.app.request(path, ctx.as(token, init));
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
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
      const whatsapp = async (organizationId: OrganizationId, phone: string, id: string) =>
        (
          await createConversationIngress({ repository: stores.conversations }).receive({
            organizationId,
            connectionId: CONNECTION,
            channel: 'whatsapp',
            externalMessageId: `wamid.${id}`,
            from: { externalId: phone.slice(1), displayName: 'Luis', phone },
            type: 'text',
            text: 'Hola, ¿tienen pollo a la brasa para 20?',
            attachments: [],
            sentAt: '2026-09-28T16:00:00.000Z' as IsoTimestamp,
          })
        ).conversation;
      return { ...ctx, stores, orgA, orgB, call, send, base, whatsapp };
    }

    it('shows how a WhatsApp contact arrived, its conversation, opportunities and history', async () => {
      const t = await setup();
      const conversation = await t.whatsapp(t.orgA, '+51933333333', 'C3A');
      const contactId = conversation.contactId as string;
      const opportunities = `${t.base(t.orgA)}/opportunities`;
      const first = await t.send('token-alice', 'POST', opportunities, {
        contactId,
        title: 'Almuerzo de empresa',
        value: { amountMinor: 80000, currency: 'PEN' },
      });
      const second = await t.send('token-alice', 'POST', opportunities, {
        contactId,
        title: 'Cumpleaños',
      });
      await t.send('token-alice', 'PATCH', `${opportunities}/${first.body.id as string}`, {
        revision: 1,
        stageId: 'won',
      });

      const card = await t.call('token-alice', `${t.base(t.orgA)}/customers/${contactId}`);
      expect(card.status).toBe(200);
      expect(card.body).toMatchObject({
        id: contactId,
        origin: 'channel',
        commercial: { stage: 'customer', source: 'channel' },
        conversations: [{ id: conversation.id, channel: 'whatsapp', status: 'open' }],
      });
      const own = card.body.opportunities as {
        id: string;
        status: string;
        value: unknown;
        stage: { id: string; kind: string } | null;
      }[];
      expect(own.map((o) => o.id).sort()).toEqual(
        [first.body.id as string, second.body.id as string].sort(),
      );
      expect(own.find((o) => o.id === first.body.id)).toMatchObject({
        status: 'won',
        value: { amountMinor: 80000, currency: 'PEN' },
        stage: { id: 'won', kind: 'won' },
      });
      expect(own.find((o) => o.id === second.body.id)?.stage).toMatchObject({ kind: 'open' });

      const history = card.body.history as {
        action: string;
        actor: string;
        opportunityId: string | null;
      }[];
      // The contact's own events and both opportunities', from the one audit trail.
      expect(history.map((h) => h.action).sort()).toEqual(
        [
          'contact.stage_changed',
          'contact.stage_changed',
          'opportunity.created',
          'opportunity.created',
          'opportunity.won',
        ].sort(),
      );
      expect(history.filter((h) => h.opportunityId === first.body.id).map((h) => h.action)).toEqual(
        ['opportunity.won', 'opportunity.created'],
      );
      expect(
        history
          .filter((h) => h.opportunityId === null)
          .every((h) => h.action.startsWith('contact.')),
      ).toBe(true);
      expect(history.every((h) => h.actor === 'you')).toBe(true);
      // Newest first.
      const times = (card.body.history as { at: string }[]).map((h) => h.at);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('gives a role only the parts it may read: the others are null, not empty', async () => {
      const t = await setup(['contact.read', 'contact.manage']);
      const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/customers`, {
        displayName: 'Carmen',
        phone: '+51987111222',
      });
      const card = await t.call(
        'token-alice',
        `${t.base(t.orgA)}/customers/${created.body.id as string}`,
      );
      expect(card.status).toBe(200);
      expect(card.body).toMatchObject({ conversations: null, opportunities: null });
      expect((card.body.history as { action: string }[]).map((h) => h.action)).toEqual([
        'contact.created',
      ]);
    });

    it("never shows another organization's contact or opportunities", async () => {
      const t = await setup();
      const conversation = await t.whatsapp(t.orgB, '+51944444444', 'C3B');
      const contactId = conversation.contactId as string;
      await t.send('token-bob', 'POST', `${t.base(t.orgB)}/opportunities`, {
        contactId,
        title: 'Pedido',
      });
      // Alice asks for Bob's contact through her organization, and through Bob's.
      expect((await t.call('token-alice', `${t.base(t.orgA)}/customers/${contactId}`)).status).toBe(
        404,
      );
      expect((await t.call('token-alice', `${t.base(t.orgB)}/customers/${contactId}`)).status).toBe(
        403,
      );
      const bobs = await t.call('token-bob', `${t.base(t.orgB)}/customers/${contactId}`);
      expect((bobs.body.opportunities as unknown[]).length).toBe(1);
    });
  },
);
