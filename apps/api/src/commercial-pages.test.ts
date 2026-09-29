import { localDateTime, plusDays } from '@melonoffice/conversations';
import type { OrganizationId } from '@melonoffice/domain';
import { createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Comercial's lists, one page at a time (ADR-0061): contacts, opportunities and follow-ups. Every
 * test walks the pages the way the screen does, with the cursor each page hands out, and checks
 * the walk against the whole list read at once.
 */

interface Page {
  readonly items: { readonly id: string }[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly [key: string]: unknown;
}

describe.each(STORES)("Comercial's pages with storage in %s", (_name, createStores) => {
  async function setup(options: { readonly permissions?: readonly Permission[] } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.permissions === undefined
        ? undefined
        : createAuthorizationService({ owner: [...options.permissions] }),
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
    const profile = (org: string, token: string) =>
      send(token, 'PUT', `${base(org)}/business-profile`, {
        businessType: 'restaurant',
        country: 'PE',
        currency: 'PEN',
        timeZone: 'America/Lima',
        city: 'Lima',
      });
    let phones = 0;
    const contact = async (org: string, token = 'token-alice') =>
      (
        await send(token, 'POST', `${base(org)}/customers`, {
          displayName: `Cliente ${++phones}`,
          phone: `+5191${String(phones).padStart(7, '0')}`,
        })
      ).body.id as string;
    /** Every page of `path`, `limit` at a time, following each page's cursor. */
    const walk = async (token: string, path: string, limit: number, from?: string | null) => {
      const pages: Page[] = [];
      let cursor: string | null = from ?? null;
      do {
        const join = path.includes('?') ? '&' : '?';
        const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const got = await call(token, `${path}${join}limit=${limit}${suffix}`);
        expect(got.status).toBe(200);
        const page = got.body as unknown as Page;
        pages.push(page);
        cursor = page.nextCursor;
        expect(pages.length).toBeLessThan(20);
      } while (cursor !== null);
      return pages;
    };
    return { ...ctx, stores, orgA, orgB, call, send, base, profile, contact, walk };
  }

  const ids = (pages: readonly Page[]) => pages.flatMap((p) => p.items.map((i) => i.id));

  it('pages contacts newest change first: no duplicates, none lost, counts on every page', async () => {
    const t = await setup();
    for (let i = 0; i < 7; i += 1) await t.contact(t.orgA);
    const all = await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead&limit=200`);
    expect(all.body).toMatchObject({ hasMore: false, nextCursor: null });
    const whole = (all.body as unknown as Page).items.map((i) => i.id);
    expect(whole).toHaveLength(7);

    const pages = await t.walk('token-alice', `${t.base(t.orgA)}/customers?stage=lead`, 3);
    // First, second and last page.
    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(pages[0]?.nextCursor).toEqual(expect.any(String));
    expect(pages[2]?.nextCursor).toBeNull();
    // The walk is the whole list, in the same order: nothing twice, nothing missing.
    expect(ids(pages)).toEqual(whole);
    expect(new Set(ids(pages)).size).toBe(7);
    for (const page of pages) expect(page.counts).toEqual({ lead: 7, customer: 0, inactive: 0 });

    // The default page is the API's (50): seven fit in one, with no cursor.
    const one = await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead`);
    expect(one.body).toMatchObject({ hasMore: false, nextCursor: null });
    // Exactly one full page says there is no more.
    const exact = await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead&limit=7`);
    expect(exact.body).toMatchObject({ hasMore: false, nextCursor: null });
    expect((exact.body as unknown as Page).items).toHaveLength(7);
    // An empty stage is an empty page.
    const none = await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=customer&limit=3`);
    expect(none.body).toMatchObject({ items: [], hasMore: false, nextCursor: null });
  });

  it('keeps the filter with the cursor: a stage change on the way moves a contact, never duplicates it', async () => {
    const t = await setup();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push(await t.contact(t.orgA));
    const first = await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead&limit=2`);
    const page1 = first.body as unknown as Page;
    // Between two pages, a contact of the first page becomes a customer: it leaves the leads.
    const moved = page1.items[0]?.id ?? '';
    const current = await t.call('token-alice', `${t.base(t.orgA)}/customers/${moved}`);
    await t.send('token-alice', 'PATCH', `${t.base(t.orgA)}/customers/${moved}`, {
      revision: current.body.revision,
      stage: 'customer',
    });
    const rest = await t.walk(
      'token-alice',
      `${t.base(t.orgA)}/customers?stage=lead`,
      2,
      page1.nextCursor,
    );
    const seen = [...page1.items.map((i) => i.id), ...ids(rest)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(made));
    // A cursor of the leads is not a cursor of the customers.
    const other = await t.call(
      'token-alice',
      `${t.base(t.orgA)}/customers?stage=customer&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    );
    expect(other).toEqual({ status: 400, body: { error: 'invalid_request', field: 'cursor' } });
  });

  it("refuses another organization's cursor, a forged one and a page out of range", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i += 1) await t.contact(t.orgA);
    for (let i = 0; i < 3; i += 1) await t.contact(t.orgB, 'token-bob');
    const a = (await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead&limit=1`))
      .body as unknown as Page;
    const cursorA = encodeURIComponent(a.nextCursor ?? '');
    // Bob, in his own organization, with Alice's cursor: refused, nothing of A comes back.
    const bob = await t.call(
      'token-bob',
      `${t.base(t.orgB)}/customers?stage=lead&limit=1&cursor=${cursorA}`,
    );
    expect(bob).toEqual({ status: 400, body: { error: 'invalid_request', field: 'cursor' } });
    // Bob on Alice's organization: not a member, whatever the cursor.
    expect(
      (await t.call('token-bob', `${t.base(t.orgA)}/customers?stage=lead&cursor=${cursorA}`))
        .status,
    ).toBe(403);
    // A cursor rewritten to name B, and plain garbage.
    const forged = JSON.parse(Buffer.from(a.nextCursor ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const toB = Buffer.from(JSON.stringify({ ...forged, o: t.orgB })).toString('base64url');
    for (const cursor of [toB, 'not-a-cursor', '']) {
      const got = await t.call(
        'token-bob',
        `${t.base(t.orgB)}/customers?stage=lead&cursor=${encodeURIComponent(cursor)}`,
      );
      // B's own contacts, read with a position forged from A's, still only ever B's.
      if (got.status === 200) {
        const mine = (got.body as unknown as Page).items.map((i) => i.id);
        const theirs = (
          (await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead`))
            .body as unknown as Page
        ).items.map((i) => i.id);
        expect(mine.some((id) => theirs.includes(id))).toBe(false);
      } else {
        expect(got).toEqual({ status: 400, body: { error: 'invalid_request', field: 'cursor' } });
      }
    }
    for (const limit of ['0', '201', 'x', '2.5']) {
      expect(
        (await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead&limit=${limit}`)).body,
      ).toEqual({ error: 'invalid_request', field: 'limit' });
    }
  });

  it('pages opportunities per status with the totals of all of them on every page', async () => {
    const t = await setup();
    await t.profile(t.orgA, 'token-alice');
    const contactId = await t.contact(t.orgA);
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/opportunities`, {
        contactId,
        title: `Pedido ${i}`,
        value: { amountMinor: 10_000 * (i + 1) },
      });
      made.push(created.body.id as string);
    }
    // One is won: it leaves the open ones.
    const won = made[0] ?? '';
    await t.send('token-alice', 'PATCH', `${t.base(t.orgA)}/opportunities/${won}`, {
      revision: 1,
      stageId: 'won',
    });
    const whole = (
      (await t.call('token-alice', `${t.base(t.orgA)}/opportunities?status=open&limit=500`))
        .body as unknown as Page
    ).items.map((i) => i.id);
    const pages = await t.walk('token-alice', `${t.base(t.orgA)}/opportunities?status=open`, 2);
    expect(pages.map((p) => p.items.length)).toEqual([2, 2]);
    expect(ids(pages)).toEqual(whole);
    expect(new Set(ids(pages))).toEqual(new Set(made.slice(1)));
    for (const page of pages) {
      expect(page.summary).toEqual({
        currency: 'PEN',
        stages: {
          inquiry: { count: 4, valueMinor: 140_000 },
          won: { count: 1, valueMinor: 10_000 },
        },
        open: { count: 4, valueMinor: 140_000 },
        won: 1,
        lost: 0,
      });
    }
    // The contact's name comes with its page, read by id.
    expect(pages[0]?.items[0]).toMatchObject({ contactName: 'Cliente 1' });
    const wonPage = await t.walk('token-alice', `${t.base(t.orgA)}/opportunities?status=won`, 2);
    expect(ids(wonPage)).toEqual([won]);
    // Bob's organization has none, and Alice's cursor is not his.
    const bob = await t.call(
      'token-bob',
      `${t.base(t.orgB)}/opportunities?status=open&cursor=${encodeURIComponent(pages[0]?.nextCursor ?? '')}`,
    );
    expect(bob).toEqual({ status: 400, body: { error: 'invalid_request', field: 'cursor' } });
  });

  it('pages follow-ups soonest first, with the counts of all the open ones', async () => {
    const t = await setup();
    await t.profile(t.orgA, 'token-alice');
    const contactId = await t.contact(t.orgA);
    const tomorrow = plusDays(localDateTime(new Date(), 'America/Lima').date, 1);
    for (let i = 0; i < 5; i += 1) {
      const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups`, {
        requestKey: `pages-key-${String(i).padStart(4, '0')}`,
        contactId,
        type: 'call',
        title: `Llamada ${i}`,
        date: tomorrow,
        // Scheduled in reverse: the soonest was made last.
        time: `${String(15 - i).padStart(2, '0')}:00`,
      });
      expect(created.status).toBe(201);
    }
    const pages = await t.walk('token-alice', `${t.base(t.orgA)}/follow-ups?open=true`, 2);
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
    const times = pages.flatMap((p) => p.items.map((i) => (i as unknown as { time: string }).time));
    expect(times).toEqual(['11:00', '12:00', '13:00', '14:00', '15:00']);
    for (const page of pages) {
      expect(page.counts).toMatchObject({ open: 5, upcoming: 5, overdue: 0 });
    }
    // The person's own and a contact's: the same pages, the same filter kept by the cursor.
    const mine = await t.walk(
      'token-alice',
      `${t.base(t.orgA)}/follow-ups?open=true&assignee=me`,
      2,
    );
    expect(ids(mine)).toEqual(ids(pages));
    const ofContact = await t.walk(
      'token-alice',
      `${t.base(t.orgA)}/follow-ups?open=true&contact=${contactId}`,
      4,
    );
    expect(ids(ofContact)).toEqual(ids(pages));
    const wrong = await t.call(
      'token-alice',
      `${t.base(t.orgA)}/follow-ups?open=true&assignee=me&cursor=${encodeURIComponent(pages[0]?.nextCursor ?? '')}`,
    );
    expect(wrong).toEqual({ status: 400, body: { error: 'invalid_request', field: 'cursor' } });
  });

  it('keeps each list behind its own permission, with or without a cursor', async () => {
    const t = await setup({ permissions: ['contact.read', 'contact.manage'] });
    for (let i = 0; i < 3; i += 1) await t.contact(t.orgA);
    const page = (await t.call('token-alice', `${t.base(t.orgA)}/customers?stage=lead&limit=1`))
      .body as unknown as Page;
    expect(page.hasMore).toBe(true);
    const cursor = encodeURIComponent(page.nextCursor ?? '');
    for (const path of [
      `${t.base(t.orgA)}/opportunities?status=open&cursor=${cursor}`,
      `${t.base(t.orgA)}/follow-ups?open=true&cursor=${cursor}`,
    ]) {
      expect((await t.call('token-alice', path)).status).toBe(403);
    }
  });
});
