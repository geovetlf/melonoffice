import { InMemoryUserDirectory } from '@melonoffice/auth';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { setupApp, STORES, verifier } from './test-api.js';

interface View {
  organization: { id: string; name: string; status: string };
  membership: { id: string; role: string; status: string };
}

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';

describe.each(STORES)('organizations with storage in %s', (_name, createStores) => {
  /** Alice owns organization A and Bob owns organization B, each created through the API. */
  async function setup() {
    const ctx = setupApp(createStores());
    const { app, as, register } = ctx;
    const create = (token: string, body: unknown) =>
      app.request(
        '/v1/organizations',
        as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const aliceId = (await register('token-alice')) as UserId;
    const bobId = (await register('token-bob')) as UserId;
    return { ...ctx, create, aliceId, bobId };
  }

  async function withTwoOrganizations() {
    const ctx = await setup();
    const created = async (token: string, name: string) =>
      ((await (await ctx.create(token, { name })).json()) as View).organization
        .id as OrganizationId;
    const orgA = await created('token-alice', 'Org A');
    const orgB = await created('token-bob', 'Org B');
    const get = (token: string, id: string) =>
      ctx.app.request(`/v1/organizations/${encodeURIComponent(id)}`, ctx.as(token));
    return { ...ctx, orgA, orgB, get };
  }

  describe('POST /v1/organizations', () => {
    it('creates the organization with the caller as its active owner', async () => {
      const { create, aliceId, tenancy } = await setup();
      const response = await create('token-alice', { name: ' Acme ' });
      expect(response.status).toBe(201);
      const body = (await response.json()) as View;
      expect(body).toEqual({
        organization: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          name: 'Acme',
          status: 'active',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        membership: {
          id: `${body.organization.id}_${aliceId}`,
          role: 'owner',
          status: 'active',
          createdAt: expect.any(String),
        },
      });
      const [membership] = await tenancy.membershipsOfUser(aliceId);
      expect(membership?.organizationId).toBe(body.organization.id);
    });

    it('ignores any id, owner, user, status or role in the body', async () => {
      const { create, bobId, tenancy } = await setup();
      const response = await create('token-alice', {
        name: 'Acme',
        id: MISSING_ORG,
        organizationId: MISSING_ORG,
        userId: bobId,
        createdBy: bobId,
        status: 'suspended',
        role: 'admin',
      });
      const body = (await response.json()) as View;
      expect(body.organization.id).not.toBe(MISSING_ORG);
      expect(body.organization.status).toBe('active');
      expect(body.membership.role).toBe('owner');
      expect(await tenancy.membershipsOfUser(bobId)).toHaveLength(0);
    });

    it.each([
      ['no body', undefined],
      ['a missing name', {}],
      ['an empty name', { name: '  ' }],
      ['a name that is too long', { name: 'x'.repeat(101) }],
      ['a name that is not a string', { name: 42 }],
    ])('refuses %s', async (_name, body) => {
      const { create } = await setup();
      const response = await create('token-alice', body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_organization_name' });
    });

    it('lets a user create only one organization', async () => {
      const { create } = await setup();
      expect((await create('token-alice', { name: 'First' })).status).toBe(201);
      const second = await create('token-alice', { name: 'Second' });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: 'organization_limit_reached' });
    });

    it('needs a registered user', async () => {
      const { app, as } = setupApp(createStores());
      const anonymous = await app.request('/v1/organizations', { method: 'POST' });
      expect(anonymous.status).toBe(401);
      const unregistered = await app.request(
        '/v1/organizations',
        as('token-bob', { method: 'POST' }),
      );
      expect(unregistered.status).toBe(403);
      expect(await unregistered.json()).toEqual({ error: 'user_not_registered' });
    });
  });

  describe('GET /v1/me/organizations', () => {
    it("lists only the caller's organizations", async () => {
      const { app, as, orgA, orgB } = await withTwoOrganizations();
      const alice = (await (
        await app.request('/v1/me/organizations', as('token-alice'))
      ).json()) as {
        organizations: View[];
      };
      expect(alice.organizations.map((o) => o.organization.id)).toEqual([orgA]);
      const bob = (await (await app.request('/v1/me/organizations', as('token-bob'))).json()) as {
        organizations: View[];
      };
      expect(bob.organizations.map((o) => o.organization.id)).toEqual([orgB]);
    });

    it('is empty before the user creates or joins one', async () => {
      const { app, as } = await setup();
      const response = await app.request('/v1/me/organizations', as('token-alice'));
      expect(await response.json()).toEqual({ organizations: [] });
    });

    it('cannot be pointed at another user', async () => {
      const { app, as, bobId, orgA } = await withTwoOrganizations();
      const response = await app.request(
        `/v1/me/organizations?userId=${bobId}`,
        as('token-alice', { headers: { 'x-user-id': bobId } }),
      );
      const body = (await response.json()) as { organizations: View[] };
      expect(body.organizations.map((o) => o.organization.id)).toEqual([orgA]);
    });
  });

  describe('GET /v1/organizations/:id (cross-tenant)', () => {
    it('user A reads organization A', async () => {
      const { get, orgA, aliceId } = await withTwoOrganizations();
      const response = await get('token-alice', orgA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as View;
      expect(body.organization).toMatchObject({ id: orgA, name: 'Org A', status: 'active' });
      expect(body.membership).toMatchObject({ id: `${orgA}_${aliceId}`, status: 'active' });
    });

    it('user A cannot read organization B', async () => {
      const { get, orgB } = await withTwoOrganizations();
      const response = await get('token-alice', orgB);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'organization_forbidden' });
    });

    it('user B reads organization B', async () => {
      const { get, orgB } = await withTwoOrganizations();
      expect((await get('token-bob', orgB)).status).toBe(200);
    });

    it('a modified organization id never elevates, and all refusals look the same', async () => {
      const { get, orgA, orgB } = await withTwoOrganizations();
      for (const forged of [orgB, MISSING_ORG, orgA.toUpperCase(), 'org-a', `${orgA}_x`]) {
        const response = await get('token-alice', forged);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'organization_forbidden' });
      }
    });

    it('a modified user id or organization header does not change identity', async () => {
      const { app, as, bobId, orgB } = await withTwoOrganizations();
      const response = await app.request(
        `/v1/organizations/${orgB}?userId=${bobId}`,
        as('token-alice', { headers: { 'x-user-id': bobId, 'x-organization-id': orgB } }),
      );
      expect(response.status).toBe(403);
    });

    it.each(['suspended', 'revoked'] as const)('refuses a %s membership', async (status) => {
      const { get, orgA, aliceId, tenancy, put } = await withTwoOrganizations();
      const membership = await tenancy.findMembership(orgA, aliceId);
      if (membership === undefined) throw new Error('missing membership');
      await put({ ...membership, status });
      expect((await get('token-alice', orgA)).status).toBe(403);
    });

    it('refuses a suspended organization', async () => {
      const { get, orgA, tenancy, put } = await withTwoOrganizations();
      const organization = await tenancy.findOrganization(orgA);
      if (organization === undefined) throw new Error('missing organization');
      await put({ ...organization, status: 'suspended' });
      expect((await get('token-alice', orgA)).status).toBe(403);
    });
  });
});

describe('regression', () => {
  it('without auth, health works and every /v1 route, organizations included, fails closed', async () => {
    const logger = createLogger({ service: 'api', sink: () => undefined });
    const app = createApp({ logger, version: 'test' });
    expect((await app.request('/health')).status).toBe(200);
    for (const path of ['/v1/me', '/v1/me/organizations', `/v1/organizations/${MISSING_ORG}`]) {
      expect((await app.request(path, { headers: { authorization: 'Bearer x' } })).status).toBe(
        503,
      );
    }
  });

  it('with auth but no tenancy store, organization routes fail closed and /v1/me still works', async () => {
    const logger = createLogger({ service: 'api', sink: () => undefined });
    const app = createApp({
      logger,
      version: 'test',
      auth: { verifier, users: new InMemoryUserDirectory() },
    });
    const headers = { authorization: 'Bearer token-alice' };
    expect((await app.request('/v1/me', { method: 'POST', headers })).status).toBe(201);
    expect((await app.request('/v1/me', { headers })).status).toBe(200);
    const response = await app.request('/v1/me/organizations', { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'tenancy_not_configured' });
    expect((await app.request('/v1/organizations', { method: 'POST', headers })).status).toBe(503);
  });
});

describe.each(STORES)(
  'RBAC on GET /v1/organizations/:id with storage in %s',
  (_name, createStores) => {
    /** Alice owns an organization; Bob is registered with no membership anywhere. */
    async function setup(authorization?: AuthorizationService) {
      const ctx = setupApp(createStores(), authorization);
      const aliceId = (await ctx.register('token-alice')) as UserId;
      await ctx.register('token-bob');
      const created = await ctx.app.request(
        '/v1/organizations',
        ctx.as('token-alice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Org A' }),
        }),
      );
      const orgA = ((await created.json()) as View).organization.id as OrganizationId;
      const membership = await ctx.tenancy.findMembership(orgA, aliceId);
      if (membership === undefined) throw new Error('missing membership');
      const read = async (headers: Record<string, string>) => {
        const response = await ctx.app.request(`/v1/organizations/${orgA}`, { headers });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      return { ...ctx, orgA, membership, read };
    }

    const alice = { authorization: 'Bearer token-alice' };

    it('allows the owner, whose role lists organization.read', async () => {
      const { read, orgA } = await setup();
      const { status, body } = await read(alice);
      expect(status).toBe(200);
      expect((body as unknown as View).organization.id).toBe(orgA);
    });

    it.each([
      ['no token', {}, 401, 'missing_token'],
      ['an invalid token', { authorization: 'Bearer forged' }, 401, 'invalid_token'],
      [
        'a valid token without a membership',
        { authorization: 'Bearer token-bob' },
        403,
        'organization_forbidden',
      ],
    ])('refuses %s', async (_name, headers, status, error) => {
      const { read } = await setup();
      expect(await read(headers)).toEqual({ status, body: { error } });
    });

    it.each(['suspended', 'revoked'] as const)('refuses a %s membership', async (status) => {
      const { read, put, membership } = await setup();
      await put({ ...membership, status });
      expect(await read(alice)).toEqual({ status: 403, body: { error: 'organization_forbidden' } });
    });

    it('refuses a member whose role does not list the permission', async () => {
      const { read } = await setup(createAuthorizationService({ owner: [] }));
      expect(await read(alice)).toEqual({ status: 403, body: { error: 'permission_denied' } });
    });

    it('refuses a stored role RBAC does not know, without saying why', async () => {
      const { read, put, membership, lines } = await setup();
      await put({ ...membership, role: 'admin' });
      expect(await read(alice)).toEqual({ status: 403, body: { error: 'permission_denied' } });
      expect(lines.join('\n')).toContain('"reason":"unknown_role"');
    });

    it('ignores membership, user and role values sent by the client', async () => {
      const { app, orgA, membership } = await setup(createAuthorizationService({ owner: [] }));
      const response = await app.request(
        `/v1/organizations/${orgA}?membershipId=${membership.id}&role=owner`,
        {
          headers: {
            ...alice,
            'x-membership-id': membership.id,
            'x-user-id': membership.userId,
            'x-role': 'owner',
          },
        },
      );
      expect(response.status).toBe(403);
    });
  },
);
