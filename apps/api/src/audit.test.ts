import type { OrganizationId, UserId } from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import type { TenancyStore } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

interface View {
  organization: { id: string };
  membership: { id: string };
}

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';

describe.each(STORES)('audit log with storage in %s', (_name, createStores) => {
  async function setup(options: { stores?: Stores; noPermissions?: boolean } = {}) {
    const stores = options.stores ?? createStores();
    const ctx = setupApp(
      stores,
      options.noPermissions ? createAuthorizationService({ owner: [] }) : undefined,
    );
    const create = (token: string, body: unknown) =>
      ctx.app.request(
        '/v1/organizations',
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
    const events = async (action?: string) =>
      (await stores.auditEvents()).filter((e) => action === undefined || e.action === action);
    return { ...ctx, create, aliceId, bobId, events };
  }

  async function withOrganizations(options: { noPermissions?: boolean } = {}) {
    const ctx = await setup(options);
    const orgA = ((await (await ctx.create('token-alice', { name: 'A' })).json()) as View)
      .organization.id as OrganizationId;
    const orgB = ((await (await ctx.create('token-bob', { name: 'B' })).json()) as View)
      .organization.id as OrganizationId;
    const get = (token: string, id: string, headers: Record<string, string> = {}) =>
      ctx.app.request(`/v1/organizations/${encodeURIComponent(id)}`, ctx.as(token, { headers }));
    return { ...ctx, orgA, orgB, get };
  }

  describe('auth events', () => {
    it('records the first sign-in as auth.register and later ones as auth.sign_in', async () => {
      const { app, as, aliceId, events } = await setup();
      await app.request('/v1/me', as('token-alice', { method: 'POST' }));
      const alice = (await events()).filter(
        (e) => e.actor.type === 'user' && e.actor.userId === aliceId,
      );
      expect(alice.map((e) => [e.action, e.result])).toEqual([
        ['auth.register', 'success'],
        ['auth.sign_in', 'success'],
      ]);
      expect(alice[0]).toMatchObject({
        actor: { type: 'user', userId: aliceId, via: 'direct' },
        target: { type: 'user', id: aliceId },
        source: 'api',
      });
      expect(alice[0]?.organizationId).toBeUndefined();
    });

    it('records nothing for rejected authentication, which is not an authorization denial', async () => {
      const { app, events } = await setup();
      const before = (await events()).length;
      await app.request('/v1/me', { method: 'POST' });
      await app.request('/v1/me', { headers: { authorization: 'Bearer forged' } });
      await app.request(`/v1/organizations/${MISSING_ORG}`, {
        headers: { authorization: 'Bearer token-expired' },
      });
      expect(await events()).toHaveLength(before);
    });

    it('stores the request id the response carries', async () => {
      const { app, as, events } = await setup();
      const response = await app.request(
        '/v1/me',
        as('token-alice', { method: 'POST', headers: { 'x-request-id': 'req-123' } }),
      );
      expect(response.headers.get('x-request-id')).toBe('req-123');
      expect((await events('auth.sign_in')).at(-1)?.requestId).toBe('req-123');
    });
  });

  describe('tenancy events', () => {
    it('records organization.create and membership.create with the new organization as tenant', async () => {
      const { create, aliceId, events } = await setup();
      const body = (await (await create('token-alice', { name: 'Acme' })).json()) as View;
      const expected = {
        result: 'success',
        actor: { type: 'user', userId: aliceId, via: 'direct' },
        organizationId: body.organization.id,
        source: 'api',
      };
      expect(await events('organization.create')).toEqual([
        expect.objectContaining({
          ...expected,
          target: { type: 'organization', id: body.organization.id },
        }),
      ]);
      expect(await events('membership.create')).toEqual([
        expect.objectContaining({
          ...expected,
          target: { type: 'membership', id: body.membership.id },
        }),
      ]);
    });

    it('takes the actor and tenant from the server, never from the body or headers', async () => {
      const { create, aliceId, bobId, events } = await setup();
      const response = await create('token-alice', {
        name: 'Acme',
        actorUserId: bobId,
        userId: bobId,
        organizationId: MISSING_ORG,
        actorType: 'system',
        result: 'denied',
      });
      const body = (await response.json()) as View;
      const [event] = await events('organization.create');
      expect(event?.actor).toEqual({ type: 'user', userId: aliceId, via: 'direct' });
      expect(event?.organizationId).toBe(body.organization.id);
      expect(event?.organizationId).not.toBe(MISSING_ORG);
      expect(event?.result).toBe('success');
    });

    it('records a refused second organization as denied, without a tenant', async () => {
      const { create, aliceId, events } = await setup();
      await create('token-alice', { name: 'First' });
      expect((await create('token-alice', { name: 'Second' })).status).toBe(409);
      const denied = (await events('organization.create')).filter((e) => e.result === 'denied');
      expect(denied).toEqual([
        expect.objectContaining({
          actor: { type: 'user', userId: aliceId, via: 'direct' },
          reason: 'organization_limit_reached',
        }),
      ]);
      expect(denied[0]?.organizationId).toBeUndefined();
      expect(await events('membership.create')).toHaveLength(1);
    });

    it('does not record a malformed name, which is bad input and not a security event', async () => {
      const { create, events } = await setup();
      expect((await create('token-alice', { name: '' })).status).toBe(400);
      expect(await events('organization.create')).toEqual([]);
    });

    it('records a technical failure as failure and still answers 500', async () => {
      const stores = createStores();
      const broken: TenancyStore = {
        findOrganization: (id) => stores.tenancy.findOrganization(id),
        findMembership: (o, u) => stores.tenancy.findMembership(o, u),
        membershipsOfUser: (u) => stores.tenancy.membershipsOfUser(u),
        createOrganization: async () => {
          throw new Error('storage down');
        },
      };
      const { create, events } = await setup({ stores: { ...stores, tenancy: broken } });
      expect((await create('token-alice', { name: 'Acme' })).status).toBe(500);
      expect(await events('organization.create')).toEqual([
        expect.objectContaining({ result: 'failure', reason: 'storage_error' }),
      ]);
      expect(await events('membership.create')).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it("records each actor's events under its own organization", async () => {
      const { events, aliceId, bobId, orgA, orgB } = await withOrganizations();
      const created = await events('organization.create');
      const byActor = Object.fromEntries(
        created.map((e) => [e.actor.type === 'user' ? e.actor.userId : '', e.organizationId]),
      );
      expect(byActor).toEqual({ [aliceId]: orgA, [bobId]: orgB });
    });

    it('records A reaching for OrgB as denied, with OrgB only as the requested target', async () => {
      const { get, events, aliceId, bobId, orgB } = await withOrganizations();
      const response = await get('token-alice', orgB, {
        'x-user-id': bobId,
        'x-organization-id': orgB,
        'x-actor-user-id': bobId,
      });
      expect(response.status).toBe(403);
      const [event] = await events('tenancy.resolve');
      expect(event).toMatchObject({
        result: 'denied',
        actor: { type: 'user', userId: aliceId, via: 'direct' },
        requestedOrganizationId: orgB,
        reason: 'organization_forbidden',
      });
      expect(event?.organizationId).toBeUndefined();
      expect(event?.target).toBeUndefined();
    });

    it('does not store a malformed requested id', async () => {
      const { get, events } = await withOrganizations();
      await get('token-alice', 'not-an-org');
      const [event] = await events('tenancy.resolve');
      expect(event?.result).toBe('denied');
      expect(event?.requestedOrganizationId).toBeUndefined();
    });

    it('records a user without membership as denied, never as a member', async () => {
      const { get, events, bobId, orgA } = await withOrganizations();
      await get('token-bob', orgA);
      const [event] = await events('tenancy.resolve');
      expect(event).toMatchObject({ actor: { userId: bobId }, requestedOrganizationId: orgA });
      expect(event?.organizationId).toBeUndefined();
    });

    it.each(['suspended', 'revoked'] as const)(
      'denies and records a %s membership',
      async (status) => {
        const { get, put, events, tenancy, aliceId, orgA } = await withOrganizations();
        const membership = await tenancy.findMembership(orgA, aliceId);
        if (membership === undefined) throw new Error('missing membership');
        await put({ ...membership, status });
        expect((await get('token-alice', orgA)).status).toBe(403);
        expect(await events('tenancy.resolve')).toEqual([
          expect.objectContaining({ result: 'denied', requestedOrganizationId: orgA }),
        ]);
      },
    );

    it('denies and records a suspended organization', async () => {
      const { get, put, events, tenancy, orgA } = await withOrganizations();
      const organization = await tenancy.findOrganization(orgA);
      if (organization === undefined) throw new Error('missing organization');
      await put({ ...organization, status: 'suspended' });
      expect((await get('token-alice', orgA)).status).toBe(403);
      expect(await events('tenancy.resolve')).toHaveLength(1);
    });
  });

  describe('RBAC events', () => {
    it('records a refused permission with the authorized tenant and the permission', async () => {
      const { get, events, aliceId, orgA } = await withOrganizations({ noPermissions: true });
      expect((await get('token-alice', orgA)).status).toBe(403);
      expect(await events('authorization.check')).toEqual([
        expect.objectContaining({
          result: 'denied',
          actor: { type: 'user', userId: aliceId, via: 'direct' },
          organizationId: orgA,
          target: { type: 'organization', id: orgA },
          permission: 'organization.read',
          reason: 'permission_denied',
        }),
      ]);
    });

    it('records an unknown stored role as denied', async () => {
      const { get, put, events, tenancy, aliceId, orgA } = await withOrganizations();
      const membership = await tenancy.findMembership(orgA, aliceId);
      if (membership === undefined) throw new Error('missing membership');
      await put({ ...membership, role: 'admin' });
      expect((await get('token-alice', orgA)).status).toBe(403);
      expect((await events('authorization.check'))[0]?.reason).toBe('unknown_role');
    });

    it('records nothing for an allowed read, which is not audited', async () => {
      const { get, events, orgA } = await withOrganizations();
      const before = (await events()).length;
      expect((await get('token-alice', orgA)).status).toBe(200);
      expect(await events()).toHaveLength(before);
    });
  });

  describe('integrity and privacy', () => {
    it('has no endpoint to write, change or delete audit events', async () => {
      const { app, as } = await withOrganizations();
      for (const path of ['/v1/audit-logs', '/v1/auditLogs', '/v1/audit', '/v1/audit-logs/x']) {
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          const response = await app.request(
            path,
            as('token-alice', {
              method,
              headers: { 'content-type': 'application/json' },
              ...(method === 'GET' ? {} : { body: JSON.stringify({ action: 'auth.sign_in' }) }),
            }),
          );
          expect(response.status).toBe(404);
        }
      }
    });

    it('never stores tokens, authorization headers or emails', async () => {
      const { get, create, events, orgB } = await withOrganizations();
      await get('token-alice', orgB);
      await create('token-alice', { name: 'Again', password: 'hunter2', token: 'token-bob' });
      const stored = JSON.stringify(await events());
      for (const secret of ['token-alice', 'token-bob', 'Bearer', 'hunter2', '@example.com']) {
        expect(stored).not.toContain(secret);
      }
    });

    it('stores only the structured fields of the model', async () => {
      const { events } = await withOrganizations();
      const allowed = new Set([
        'id',
        'occurredAt',
        'action',
        'result',
        'actor',
        'organizationId',
        'target',
        'requestedOrganizationId',
        'permission',
        'plan',
        'reason',
        'requestId',
        'source',
      ]);
      for (const event of await events()) {
        for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
      }
    });
  });

  describe('error policy', () => {
    it('fails a sign-in closed when its event cannot be stored', async () => {
      const { app, as, breakAudit, lines } = await setup();
      breakAudit(true);
      const response = await app.request('/v1/me', as('token-alice', { method: 'POST' }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'audit_unavailable' });
      expect(lines.join('\n')).toContain('audit write failed');
    });

    it('keeps a denial a denial when its event cannot be stored, and logs the failure', async () => {
      const { get, breakAudit, lines, orgB } = await withOrganizations();
      breakAudit(true);
      const response = await get('token-alice', orgB);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'organization_forbidden' });
      expect(lines.join('\n')).toContain('audit write failed');
    });
  });
});
