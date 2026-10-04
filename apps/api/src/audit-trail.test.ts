import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import { InMemoryUserDirectory } from '@melonoffice/auth';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { InMemoryTenancyStore } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { setupApp, STORES, verifier, type Stores } from './test-api.js';

/**
 * The audit trail viewer (ADR-0147): the organization's own events, newest first, a page at a
 * time, through an allow-list of fields, read only.
 */

interface Page {
  items: {
    id: string;
    at: string;
    action: string;
    category: string;
    result: string;
    actor: { kind: string; onBehalfOf?: string };
    target?: { type: string; link?: { kind: string; id: string } };
    details: Record<string, unknown>;
  }[];
  nextCursor: string | null;
  filter: string | null;
  fromDay: string;
  toDay: string;
  timeZone: string;
}

const SPECIALIST = '0b7c1b8e-3f7e-4f63-9a5e-1d2c3b4a5f60';

describe.each(STORES)('audit trail with storage in %s', (_name, createStores) => {
  async function setup(roles: Record<string, readonly string[]> = ROLES) {
    const stores: Stores = createStores();
    const ctx = setupApp(stores, createAuthorizationService(roles as never));
    const alice = (await ctx.register('token-alice')) as UserId;
    const bob = (await ctx.register('token-bob')) as UserId;
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
    const orgA = await create('token-alice', 'Pollería A');
    const orgB = await create('token-bob', 'Tienda B');
    const trail = async (token: string, org: string, query = '') => {
      const response = await ctx.app.request(
        `/v1/organizations/${org}/audit-trail${query}`,
        ctx.as(token),
      );
      return { status: response.status, body: (await response.json()) as Page };
    };
    /** An agent's version, as AC-1..AC-4 record it, with fields the viewer must never show. */
    const versioned = (organizationId: OrganizationId, userId: UserId, version: number) =>
      stores.audit.record({
        action: 'specialist.version_created',
        result: 'success',
        actor: { type: 'user', userId, via: 'direct' },
        organizationId,
        target: { type: 'specialist', id: SPECIALIST },
        targetVersion: version,
        reference: 'ref-hidden-7f3a91',
        requestId: 'req-hidden-7f3a92',
        source: 'api',
      });
    return { ...ctx, stores, alice, bob, orgA, orgB, trail, versioned };
  }

  it('lists the organization’s events newest first, with who, what, on what and how it ended', async () => {
    const t = await setup();
    await t.versioned(t.orgA, t.alice, 2);
    await t.stores.audit.record({
      action: 'plan.step_declined',
      result: 'success',
      actor: { type: 'system', id: 'runtime', initiatedBy: t.alice, via: 'runtime' },
      organizationId: t.orgA,
      target: { type: 'plan', id: '6f1d2c3b-4a5e-4f60-8b7c-1d2e3f4a5b6c' },
      nodeId: 'campaign',
      reason: 'rejected',
      source: 'api',
    });
    const { status, body } = await t.trail('token-alice', t.orgA);
    expect(status).toBe(200);
    expect(body.timeZone).toBe('America/Lima');
    expect(body.filter).toBeNull();
    // Two events of the same instant are ordered by id; find each by what it is.
    const declined = body.items.find((i) => i.action === 'plan.step_declined');
    const version = body.items.find((i) => i.action === 'specialist.version_created');
    expect(declined).toMatchObject({
      action: 'plan.step_declined',
      category: 'planning',
      result: 'success',
      actor: { kind: 'agent', onBehalfOf: 'you' },
      target: {
        type: 'plan',
        link: { kind: 'plan', id: '6f1d2c3b-4a5e-4f60-8b7c-1d2e3f4a5b6c' },
      },
      details: { reason: 'rejected', step: 'campaign' },
    });
    expect(version).toMatchObject({
      action: 'specialist.version_created',
      category: 'specialist',
      actor: { kind: 'you' },
      target: { type: 'specialist' },
      details: { version: 2 },
    });
    // The agent's id is not a link the app opens, so it is not shown.
    expect(version?.target?.link).toBeUndefined();
    const keys = body.items.map((i) => `${i.at}|${i.id}`);
    expect([...keys].sort().reverse()).toEqual(keys);
    expect(body.items.map((i) => i.action)).toEqual(
      expect.arrayContaining(['organization.create', 'membership.create']),
    );
    // Plumbing is recorded but not in "everything".
    expect(body.items.some((i) => i.action === 'tenancy.resolve')).toBe(false);
  });

  it('never shows secrets, references, request ids or another person’s id', async () => {
    const t = await setup();
    await t.versioned(t.orgA, t.alice, 3);
    const { body } = await t.trail('token-alice', t.orgA);
    const text = JSON.stringify(body);
    expect(text).not.toContain('ref-hidden');
    expect(text).not.toContain('req-hidden');
    expect(text).not.toContain(t.alice);
    expect(text).not.toContain(SPECIALIST);
  });

  it('pages with a cursor, newest first, without repeating or skipping an event', async () => {
    const t = await setup();
    for (let v = 1; v <= 30; v += 1) await t.versioned(t.orgA, t.alice, v);
    const first = await t.trail('token-alice', t.orgA, '?category=specialist');
    expect(first.body.items).toHaveLength(25);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await t.trail(
      'token-alice',
      t.orgA,
      `?category=specialist&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(30);
    const all = [...first.body.items, ...second.body.items];
    expect(new Set(all.map((i) => i.details.version)).size).toBe(30);
    // Newest first; events of the same instant by id, so the order is total.
    const keys = all.map((i) => `${i.at}|${i.id}`);
    expect([...keys].sort().reverse()).toEqual(keys);
  });

  it('filters by category, by days and by one record, all checked on the server', async () => {
    const t = await setup();
    await t.versioned(t.orgA, t.alice, 1);
    const specialists = await t.trail('token-alice', t.orgA, '?category=specialist');
    expect(specialists.body.filter).toBe('specialist');
    expect(specialists.body.items.map((i) => i.action)).toEqual(['specialist.version_created']);
    await t.stores.audit.record({
      action: 'authorization.check',
      result: 'denied',
      actor: { type: 'user', userId: t.alice, via: 'direct' },
      organizationId: t.orgA,
      permission: 'plan.create',
      reason: 'permission_not_granted',
      source: 'api',
    });
    // Technical events only under their own filter.
    const technical = await t.trail('token-alice', t.orgA, '?category=technical');
    expect(technical.body.items.map((i) => [i.action, i.result, i.details.permission])).toEqual([
      ['authorization.check', 'denied', 'plan.create'],
    ]);
    const everything = await t.trail('token-alice', t.orgA);
    expect(everything.body.items.some((i) => i.action === 'authorization.check')).toBe(false);
    // Days long past: nothing happened then.
    const past = await t.trail('token-alice', t.orgA, '?from=2020-01-01&to=2020-01-31');
    expect(past.status).toBe(200);
    expect(past.body.items).toEqual([]);
    expect(past.body.fromDay).toBe('2020-01-01');
    const record = await t.trail('token-alice', t.orgA, `?target=specialist:${SPECIALIST}`);
    expect(record.body.items.map((i) => i.action)).toEqual(['specialist.version_created']);
  });

  it.each([
    ['an unknown category', '?category=everything', 'invalid_filter'],
    ['a forged cursor', '?cursor=bm90LWEtY3Vyc29y', 'invalid_cursor'],
    ['a malformed record', '?target=../../x', 'invalid_target'],
    ['a day that is not one', '?from=2026-02-30', 'invalid_period'],
    ['a range past a year', '?from=2024-01-01&to=2026-01-01', 'invalid_period'],
    ['days in the wrong order', '?from=2026-03-02&to=2026-03-01', 'invalid_period'],
  ])('refuses %s with 400', async (_label, query, error) => {
    const t = await setup();
    const { status, body } = await t.trail('token-alice', t.orgA, query);
    expect(status).toBe(400);
    expect(body).toEqual({ error });
  });

  it('keeps each organization’s trail to itself', async () => {
    const t = await setup();
    await t.versioned(t.orgA, t.alice, 1);
    expect((await t.trail('token-bob', t.orgA)).status).toBe(403);
    const b = await t.trail('token-bob', t.orgB, '?category=specialist');
    expect(b.body.items).toEqual([]);
    // Another organization's record, asked by id, reads nothing.
    const asked = await t.trail('token-bob', t.orgB, `?target=specialist:${SPECIALIST}`);
    expect(asked.body.items).toEqual([]);
    expect(JSON.stringify((await t.trail('token-bob', t.orgB)).body)).not.toContain(t.orgA);
  });

  it('needs activity.read', async () => {
    const t = await setup({ ...ROLES, owner: ROLES.owner.filter((p) => p !== 'activity.read') });
    expect((await t.trail('token-alice', t.orgA)).status).toBe(403);
  });

  it('offers no way to change or remove an event', async () => {
    const t = await setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await t.app.request(
        `/v1/organizations/${t.orgA}/audit-trail`,
        t.as('token-alice', { method }),
      );
      expect(response.status).toBe(404);
    }
  });
});

describe('audit trail without its reader', () => {
  it('fails closed', async () => {
    const logger = createLogger({ service: 'api', sink: () => undefined });
    const app = createApp({
      logger,
      version: 'test',
      auth: { verifier, users: new InMemoryUserDirectory() },
      tenancy: new InMemoryTenancyStore(),
      audit: createAuditService(new InMemoryAuditStore()),
    });
    const headers = { authorization: 'Bearer token-alice' };
    await app.request('/v1/me', { method: 'POST', headers });
    const response = await app.request(
      '/v1/organizations/99999999-9999-4999-8999-999999999999/audit-trail',
      { headers },
    );
    expect(response.status).toBe(503);
  });
});
