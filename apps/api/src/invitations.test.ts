import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { membershipIdOf } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { joinAccount, setupApp, STORES, type Stores } from './test-api.js';

/**
 * Invitations by email (ADR-0089), against memory and, where the emulator runs, Firestore.
 *
 * People: Alice owns Tenant A and is the platform administrator. Bob owns Tenant B, with his email
 * not verified. Carol is Partner A's admin, Dave Partner B's admin, Frank Partner A's support.
 * Heidi has no organization yet. Ivan is a member of Tenant A who is not its owner.
 */
type Body = Record<string, unknown> & { error?: string };
type Lookup = {
  invitation: { status: string; scopes: string[]; updatedAt: string; account: unknown };
  person: string;
  organization: null | 'ambiguous' | { id: string; canDecide: boolean };
};

describe.each(STORES)('invitations by email with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'bob', 'carol', 'dave', 'frank', 'heidi', 'ivan']) {
      ids[who] = await first.register(`token-${who}`);
    }
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      platformAdmins: [ids.alice as string],
    });
    const call = async (who: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(`token-${who}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    const org = async (who: string, name: string) =>
      ((await call(who, 'POST', '/v1/organizations', { name })).body.organization as { id: string })
        .id;
    const tenantA = await org('alice', 'Tenant A');
    const tenantB = await org('bob', 'Tenant B');
    const at = new Date().toISOString() as IsoTimestamp;
    await stores.put({
      id: membershipIdOf(tenantA as OrganizationId, ids.ivan as UserId),
      organizationId: tenantA as OrganizationId,
      userId: ids.ivan as UserId,
      status: 'active',
      role: 'member',
      createdAt: at,
      updatedAt: at,
    });
    const account = async (name: string, admin: string, customers = 5) => {
      const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
        type: 'partner',
        name,
        adminUserId: ids[admin],
        limits: { customers, members: 3 },
      });
      expect(created.status).toBe(201);
      return (created.body.account as { id: string }).id;
    };
    const partnerA = await account('Partner A', 'carol');
    const partnerB = await account('Partner B', 'dave');
    const support = await joinAccount(call, 'carol', partnerA, 'frank', 'partner.support');
    expect(support.status).toBe(200);
    const invitations = (id: string) => `/v1/commercial/accounts/${id}/invitations`;
    const invite = async (email: string, scopes: string[] = ['summary', 'usage'], by = 'carol') => {
      const sent = await call(by, 'POST', invitations(by === 'dave' ? partnerB : partnerA), {
        email,
        mode: 'reseller',
        scopes,
      });
      expect(sent.status).toBe(201);
      return {
        token: sent.body.token as string,
        invitation: sent.body.invitation as { id: string; updatedAt: string; status: string },
      };
    };
    const lookup = async (who: string, token: string) => {
      const found = await call(who, 'POST', '/v1/invitations/lookup', { token });
      expect(found.status).toBe(200);
      return found.body as unknown as Lookup;
    };
    return {
      ...ctx,
      stores,
      ids,
      call,
      tenantA,
      tenantB,
      partnerA,
      partnerB,
      invitations,
      invite,
      lookup,
    };
  }

  it('sends a pending invitation that grants nothing, answers its secret once and never stores it', async () => {
    const { call, invite, invitations, partnerA, stores } = await setup();
    const { token, invitation } = await invite(' Alice@Example.com ');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.status).toBe('pending');
    // The account sees it, without the secret; nothing opens a customer yet.
    const listed = (await call('carol', 'GET', invitations(partnerA))).body.invitations as Record<
      string,
      unknown
    >[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ email: 'alice@example.com', status: 'pending' });
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(
      (await call('carol', 'GET', `/v1/commercial/accounts/${partnerA}/customers`)).body,
    ).toMatchObject({ customers: [], pending: [] });
    // The store keeps only a hash; the audit keeps neither the email nor the secret.
    const stored = await stores.commercial.findInvitation(invitation.id as never);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    const events = await stores.auditEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'customer_invitation.created',
        commercialAccountId: partnerA,
        reference: 'reseller',
      }),
    );
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain('alice@example.com');
  });

  it('checks who invites and what, one pending invitation per email, within the limit', async () => {
    const { call, invitations, partnerA, partnerB, invite } = await setup();
    const post = (who: string, account: string, body: unknown) =>
      call(who, 'POST', invitations(account), body);
    for (const bad of [
      { email: 'not-an-email', mode: 'reseller' },
      { email: 'x@example.com', mode: 'agency' },
      { email: 'x@example.com', mode: 'reseller', scopes: ['everything'] },
      // Known, but nothing reads it yet (ADR-0096): not asked for.
      { email: 'x@example.com', mode: 'reseller', scopes: ['summary', 'knowledge'] },
      { email: 'x@example.com', mode: 'reseller', billing: 'someone' },
    ]) {
      expect((await post('carol', partnerA, bad)).status).toBe(400);
    }
    // Support reads invitations but never sends or revokes one; another account's people neither.
    expect(await post('frank', partnerA, { email: 'x@example.com', mode: 'reseller' })).toEqual({
      status: 403,
      body: { error: 'permission_denied' },
    });
    expect((await call('frank', 'GET', invitations(partnerA))).status).toBe(200);
    expect(
      (await post('dave', partnerA, { email: 'x@example.com', mode: 'reseller' })).status,
    ).toBe(403);
    expect((await call('dave', 'GET', invitations(partnerA))).status).toBe(403);
    await invite('heidi@example.com');
    expect(await post('carol', partnerA, { email: 'HEIDI@example.com', mode: 'reseller' })).toEqual(
      { status: 409, body: { error: 'invitation_exists' } },
    );
    // Another account may invite the same person.
    await invite('heidi@example.com', [], 'dave');
    expect((await call('dave', 'GET', invitations(partnerB))).body.invitations).toHaveLength(1);
  });

  it('keeps pending invitations within the account limit', async () => {
    const { call, ids, invitations } = await setup();
    const small = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
      type: 'partner',
      name: 'Small',
      adminUserId: ids.carol,
      limits: { customers: 1, members: 1 },
    });
    const id = (small.body.account as { id: string }).id;
    const post = (email: string) =>
      call('carol', 'POST', invitations(id), { email, mode: 'reseller' });
    expect((await post('one@example.com')).status).toBe(201);
    expect(await post('two@example.com')).toEqual({
      status: 409,
      body: { error: 'commercial_limit_reached' },
    });
  });

  it('lets only the invited person, with that email verified, take it', async () => {
    const { call, invite, lookup, stores } = await setup();
    const forBob = await invite('bob@example.com');
    const forAlice = await invite('alice@example.com');
    // Bob's email is not verified: he is told so, and can do nothing with it yet.
    expect((await lookup('bob', forBob.token)).person).toBe('email_not_verified');
    expect(
      await call('bob', 'POST', '/v1/invitations/accept', {
        token: forBob.token,
        expectedUpdatedAt: forBob.invitation.updatedAt,
      }),
    ).toEqual({ status: 403, body: { error: 'email_not_verified' } });
    // Someone else holding Alice's link cannot take or decline it, whatever they send.
    const other = await lookup('carol', forAlice.token);
    expect(other).toMatchObject({ person: 'not_invited_person', organization: null });
    for (const path of ['accept', 'reject']) {
      expect(
        await call('bob', 'POST', `/v1/invitations/${path}`, {
          token: forAlice.token,
          expectedUpdatedAt: forAlice.invitation.updatedAt,
        }),
      ).toEqual({ status: 403, body: { error: 'invitation_forbidden' } });
    }
    // A made-up or malformed secret opens nothing.
    for (const token of ['x'.repeat(43), 'short', undefined]) {
      expect((await call('alice', 'POST', '/v1/invitations/lookup', { token })).status).toBe(404);
    }
    const denied = (await stores.auditEvents()).filter(
      (e) => e.action.startsWith('customer_invitation.') && e.result === 'denied',
    );
    expect(denied.map((e) => e.reason).sort()).toEqual([
      'email_not_verified',
      'not_invited_person',
      'not_invited_person',
    ]);
  });

  it('an owner grants exactly the scopes they tick, none by default, for their own organization', async () => {
    const { call, invite, lookup, tenantA, tenantB, partnerA, stores } = await setup();
    const { token, invitation } = await invite('alice@example.com', ['summary', 'usage']);
    const seen = await lookup('alice', token);
    expect(seen).toMatchObject({
      person: 'invited',
      organization: { id: tenantA, canDecide: true },
      invitation: { status: 'pending', scopes: ['summary', 'usage'] },
    });
    // More than was asked for is refused; the organization is never taken from the request.
    expect(
      (
        await call('alice', 'POST', '/v1/invitations/accept', {
          token,
          scopes: ['summary', 'billing'],
          expectedUpdatedAt: invitation.updatedAt,
        })
      ).status,
    ).toBe(400);
    const accepted = await call('alice', 'POST', '/v1/invitations/accept', {
      token,
      organizationId: tenantB,
      expectedUpdatedAt: invitation.updatedAt,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.relationship).toMatchObject({
      organizationId: tenantA,
      commercialAccountId: partnerA,
      status: 'active',
      scopes: [],
    });
    // It is taken once: a second try, or declining now, is refused.
    expect(
      await call('alice', 'POST', '/v1/invitations/reject', {
        token,
        expectedUpdatedAt: invitation.updatedAt,
      }),
    ).toEqual({ status: 409, body: { error: 'invitation_not_pending', status: 'accepted' } });
    // Nothing was granted, so the partner still cannot read the summary.
    expect(
      (await call('carol', 'GET', `/v1/commercial/accounts/${partnerA}/customers/${tenantA}`))
        .status,
    ).toBe(403);
    expect(
      (await stores.auditEvents())
        .filter((e) => e.result === 'success')
        .map((e) => e.action)
        .filter((a) => a.startsWith('customer_')),
    ).toEqual(
      expect.arrayContaining([
        'customer_invitation.created',
        'customer_invitation.accepted',
        'customer_relationship.created',
        'customer_relationship.updated',
      ]),
    );
  });

  it('an owner who ticks scopes grants those, and an existing relationship is not doubled', async () => {
    const { call, invite, tenantA, partnerA } = await setup();
    const first = await invite('alice@example.com', ['summary', 'usage']);
    const accepted = await call('alice', 'POST', '/v1/invitations/accept', {
      token: first.token,
      scopes: ['summary'],
      expectedUpdatedAt: first.invitation.updatedAt,
    });
    expect(accepted.body.relationship).toMatchObject({ status: 'active', scopes: ['summary'] });
    const summary = await call(
      'carol',
      'GET',
      `/v1/commercial/accounts/${partnerA}/customers/${tenantA}`,
    );
    expect(summary.status).toBe(200);
    const again = await invite('alice@example.com');
    expect(
      await call('alice', 'POST', '/v1/invitations/accept', {
        token: again.token,
        expectedUpdatedAt: again.invitation.updatedAt,
      }),
    ).toEqual({ status: 409, body: { error: 'relationship_exists' } });
  });

  it('a member who is not the owner takes it for the owner, who then decides as usual', async () => {
    const { call, invite, lookup, tenantA, partnerA } = await setup();
    const { token, invitation } = await invite('ivan@example.com', ['summary']);
    expect((await lookup('ivan', token)).organization).toEqual({ id: tenantA, canDecide: false });
    const taken = await call('ivan', 'POST', '/v1/invitations/accept', {
      token,
      scopes: ['summary'],
      expectedUpdatedAt: invitation.updatedAt,
    });
    expect(taken.body.relationship).toMatchObject({ status: 'pending', scopes: ['summary'] });
    // Nothing is reachable until Alice, the owner, accepts in her usual screen.
    const path = `/v1/commercial/accounts/${partnerA}/customers/${tenantA}`;
    expect((await call('carol', 'GET', path)).status).toBe(403);
    const rel = `/v1/organizations/${tenantA}/commercial-relationships`;
    const [pending] = (await call('alice', 'GET', rel)).body.relationships as {
      status: string;
      updatedAt: string;
    }[];
    expect(pending?.status).toBe('pending');
    await call('alice', 'POST', `${rel}/${partnerA}/accept`, {
      scopes: ['summary'],
      expectedUpdatedAt: pending?.updatedAt,
    });
    expect((await call('carol', 'GET', path)).status).toBe(200);
  });

  it('someone without an organization creates it first, then takes the invitation for it', async () => {
    const { call, invite, lookup } = await setup();
    const { token, invitation } = await invite('heidi@example.com', ['summary']);
    expect(await lookup('heidi', token)).toMatchObject({ person: 'invited', organization: null });
    expect(
      await call('heidi', 'POST', '/v1/invitations/accept', {
        token,
        expectedUpdatedAt: invitation.updatedAt,
      }),
    ).toEqual({ status: 409, body: { error: 'organization_required' } });
    const created = await call('heidi', 'POST', '/v1/organizations', { name: 'Heidi Co' });
    const id = (created.body.organization as { id: string }).id;
    const accepted = await call('heidi', 'POST', '/v1/invitations/accept', {
      token,
      scopes: ['summary'],
      expectedUpdatedAt: invitation.updatedAt,
    });
    expect(accepted.body.relationship).toMatchObject({
      organizationId: id,
      status: 'active',
      scopes: ['summary'],
    });
  });

  it('the invited person can decline; the account can revoke; both close the link', async () => {
    const { call, invite, lookup, invitations, partnerA, partnerB, stores } = await setup();
    const declined = await invite('alice@example.com');
    expect(
      await call('alice', 'POST', '/v1/invitations/reject', {
        token: declined.token,
        expectedUpdatedAt: declined.invitation.updatedAt,
      }),
    ).toEqual({ status: 200, body: { status: 'rejected' } });
    expect((await lookup('alice', declined.token)).invitation.status).toBe('rejected');

    const revoked = await invite('heidi@example.com');
    const path = `${invitations(partnerA)}/${revoked.invitation.id}/revoke`;
    // Support cannot revoke; a stale version is refused.
    expect((await call('frank', 'POST', path, { expectedUpdatedAt: 'x' })).status).toBe(403);
    expect((await call('carol', 'POST', path, { expectedUpdatedAt: 'x' })).status).toBe(409);
    const done = await call('carol', 'POST', path, {
      expectedUpdatedAt: revoked.invitation.updatedAt,
    });
    expect(done.body.invitation).toMatchObject({ status: 'revoked' });
    expect(
      await call('heidi', 'POST', '/v1/invitations/accept', {
        token: revoked.token,
        expectedUpdatedAt: revoked.invitation.updatedAt,
      }),
    ).toEqual({ status: 409, body: { error: 'invitation_not_pending', status: 'revoked' } });
    // Another account cannot revoke it through its own path.
    expect(
      (
        await call('dave', 'POST', path.replace(partnerA, partnerB), {
          expectedUpdatedAt: revoked.invitation.updatedAt,
        })
      ).status,
    ).toBe(404);
    const actions = (await stores.auditEvents()).map((e) => e.action);
    expect(actions).toContain('customer_invitation.rejected');
    expect(actions).toContain('customer_invitation.revoked');
  });

  it('expires after its time, records it once, and can no longer be taken', async () => {
    const { call, invite, lookup, invitations, partnerA, stores } = await setup();
    const { token, invitation } = await invite('alice@example.com');
    const stored = await stores.commercial.findInvitation(invitation.id as never);
    if (stored === undefined) throw new Error('missing invitation');
    // Its time passes, as it would a week later.
    await stores.commercial.saveInvitation(
      { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() as IsoTimestamp },
      stored,
      [],
    );
    expect((await lookup('alice', token)).invitation.status).toBe('expired');
    expect((await lookup('alice', token)).invitation.status).toBe('expired');
    const listed = (await call('carol', 'GET', invitations(partnerA))).body.invitations as {
      status: string;
    }[];
    expect(listed.map((i) => i.status)).toEqual(['expired']);
    expect(
      (
        await call('alice', 'POST', '/v1/invitations/accept', {
          token,
          expectedUpdatedAt: invitation.updatedAt,
        })
      ).body,
    ).toEqual({ error: 'invitation_not_pending', status: 'expired' });
    expect(
      (await stores.auditEvents()).filter((e) => e.action === 'customer_invitation.expired'),
    ).toHaveLength(1);
    // An expired invitation no longer blocks a new one to the same person.
    expect((await invite('alice@example.com')).invitation.status).toBe('pending');
  });
});
