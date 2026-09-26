import type { OrganizationId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { authenticate, type AuthDependencies } from './authenticate.js';
import { actAsGia } from './context.js';
import { AuthError } from './errors.js';
import { createIdentityPlatformVerifier } from './identity-platform.js';
import { noMemberships, type MembershipDirectory } from './tenancy.js';
import { createSigner, NOW, PROJECT_ID } from './test-tokens.js';
import { InMemoryUserDirectory } from './users.js';

const ORG_A = 'org-a' as OrganizationId;
const ORG_B = 'org-b' as OrganizationId;

async function setup(membershipsOf: Record<string, OrganizationId[]> = {}) {
  const signer = await createSigner();
  const users = new InMemoryUserDirectory(() => NOW);
  const memberships: MembershipDirectory = {
    organizationsOf: async (userId) => membershipsOf[userId] ?? [],
  };
  const deps: AuthDependencies = {
    verifier: createIdentityPlatformVerifier({
      projectId: PROJECT_ID,
      keys: signer.keys,
      now: () => NOW,
    }),
    users,
    memberships,
  };
  return { ...signer, users, deps, membershipsOf };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('authenticate', () => {
  it('identifies a registered user from a valid token', async () => {
    const { sign, users, deps } = await setup();
    const alice = await users.register('uid-alice');
    const context = await authenticate({ authorization: `Bearer ${await sign()}` }, deps);
    expect(context).toEqual({
      actor: 'user',
      userId: alice.id,
      email: 'alice@example.com',
      emailVerified: true,
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('never uses the provider subject as the internal user id', async () => {
    const { sign, users, deps } = await setup();
    await users.register('uid-alice');
    const context = await authenticate({ authorization: `Bearer ${await sign()}` }, deps);
    expect(context.userId).not.toBe('uid-alice');
  });

  it('rejects a request without a token', async () => {
    const { deps } = await setup();
    expect(await codeOf(authenticate({ authorization: undefined }, deps))).toBe('missing_token');
  });

  it('rejects a malformed authorization header', async () => {
    const { deps } = await setup();
    expect(await codeOf(authenticate({ authorization: 'Basic abc' }, deps))).toBe('invalid_token');
  });

  it('rejects a valid token for a user that is not registered', async () => {
    const { sign, deps } = await setup();
    expect(await codeOf(authenticate({ authorization: `Bearer ${await sign()}` }, deps))).toBe(
      'user_not_registered',
    );
  });

  it('keeps users apart: each token maps to its own user', async () => {
    const { sign, users, deps } = await setup();
    const alice = await users.register('uid-alice');
    const bob = await users.register('uid-bob');
    const asBob = await authenticate(
      { authorization: `Bearer ${await sign({ sub: 'uid-bob', email: 'bob@example.com' })}` },
      deps,
    );
    expect(asBob.userId).toBe(bob.id);
    expect(asBob.userId).not.toBe(alice.id);
  });

  describe('organization', () => {
    it('is absent while the user has no membership', async () => {
      const { sign, users, deps } = await setup();
      await users.register('uid-alice');
      const context = await authenticate({ authorization: `Bearer ${await sign()}` }, deps);
      expect(context.organizationId).toBeUndefined();
    });

    it('is the only organization the user belongs to', async () => {
      const { sign, users, deps, membershipsOf } = await setup();
      const alice = await users.register('uid-alice');
      membershipsOf[alice.id] = [ORG_A];
      const context = await authenticate({ authorization: `Bearer ${await sign()}` }, deps);
      expect(context.organizationId).toBe(ORG_A);
    });

    it('can be chosen by the client only among its own organizations', async () => {
      const { sign, users, deps, membershipsOf } = await setup();
      const alice = await users.register('uid-alice');
      membershipsOf[alice.id] = [ORG_A, ORG_B];
      const token = `Bearer ${await sign()}`;
      expect(
        (await authenticate({ authorization: token, requestedOrganization: ORG_B }, deps))
          .organizationId,
      ).toBe(ORG_B);
      expect((await authenticate({ authorization: token }, deps)).organizationId).toBeUndefined();
    });

    it("refuses another user's organization, so a client-sent id cannot grant access", async () => {
      const { sign, users, deps, membershipsOf } = await setup();
      const alice = await users.register('uid-alice');
      const bob = await users.register('uid-bob');
      membershipsOf[alice.id] = [ORG_A];
      membershipsOf[bob.id] = [ORG_B];
      const request = { authorization: `Bearer ${await sign()}`, requestedOrganization: ORG_B };
      expect(await codeOf(authenticate(request, deps))).toBe('organization_forbidden');
    });

    it('answers the same for an organization that does not exist', async () => {
      const { sign, users, deps, membershipsOf } = await setup();
      const alice = await users.register('uid-alice');
      membershipsOf[alice.id] = [ORG_A];
      const request = { authorization: `Bearer ${await sign()}`, requestedOrganization: 'nope' };
      expect(await codeOf(authenticate(request, deps))).toBe('organization_forbidden');
    });

    it('is never granted before memberships exist', async () => {
      const { sign, users, deps } = await setup();
      await users.register('uid-alice');
      const request = { authorization: `Bearer ${await sign()}`, requestedOrganization: ORG_A };
      expect(await codeOf(authenticate(request, { ...deps, memberships: noMemberships }))).toBe(
        'organization_forbidden',
      );
    });
  });
});

describe('actAsGia', () => {
  it('keeps the same user, organization and identity, and only marks the actor', async () => {
    const context = Object.freeze({
      actor: 'user' as const,
      userId: 'u1' as UserId,
      organizationId: ORG_A,
      email: 'alice@example.com',
      emailVerified: true,
    });
    const gia = actAsGia(context);
    expect(gia).toEqual({ ...context, actor: 'gia' });
    expect(Object.isFrozen(gia)).toBe(true);
    expect(context.actor).toBe('user');
  });

  it('cannot be widened: extra fields passed along are type errors and are not privileges', () => {
    const context = { actor: 'user' as const, userId: 'u1' as UserId, emailVerified: false };
    // @ts-expect-error actAsGia takes exactly one context argument.
    const gia = actAsGia(context, { organizationId: ORG_B });
    expect(gia.organizationId).toBeUndefined();
  });
});

describe('InMemoryUserDirectory', () => {
  it('registers once per subject', async () => {
    const users = new InMemoryUserDirectory(() => NOW);
    const first = await users.register('uid-alice');
    const again = await users.register('uid-alice');
    expect(again).toBe(first);
    expect(first).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      identity: { provider: 'identity-platform', subject: 'uid-alice' },
      createdAt: '2026-09-26T12:00:00.000Z',
    });
  });
});
