import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Joining a partner or agency account only by invitation (ADR-0093), against memory and, where
 * the emulator runs, Firestore. Alice is a platform administrator; Carol is Partner A's admin;
 * Frank and Dave are invited; Bob's email is not verified; Erin holds nobody's link.
 */
type Body = Record<string, unknown> & { error?: string };

describe.each(STORES)('member invitations with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
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
    const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
      type: 'partner',
      name: 'Partner A',
      adminUserId: ids.carol,
      limits: { customers: 2, members: 2 },
    });
    const partnerA = (created.body.account as { id: string; updatedAt: string }).id;
    const base = `/v1/commercial/accounts/${partnerA}/member-invitations`;
    const invite = (email: string, role = 'partner.support', by = 'carol') =>
      call(by, 'POST', base, { email, role });
    const lookup = (who: string, token: unknown) =>
      call(who, 'POST', '/v1/member-invitations/lookup', { token });
    const version = async (token: unknown) =>
      ((await lookup('carol', token)).body.invitation as { updatedAt: string }).updatedAt;
    const accept = async (who: string, token: unknown) =>
      call(who, 'POST', '/v1/member-invitations/accept', {
        token,
        expectedUpdatedAt: await version(token),
      });
    const members = async () =>
      (
        (await call('carol', 'GET', `/v1/commercial/accounts/${partnerA}/members`)).body
          .members as { userId: string; role: string; status: string }[]
      ).filter((m) => m.status === 'active');
    const events = async (action: string) =>
      (await stores.auditEvents()).filter((e) => e.action === action);
    return { stores, ids, call, partnerA, base, invite, lookup, accept, members, events };
  }

  it('joins only the invited person, with the invited role, once, audited', async () => {
    const { ids, invite, lookup, accept, members, events, call, partnerA } = await setup();
    const sent = await invite('Frank@Example.com');
    expect(sent.status).toBe(201);
    const token = sent.body.token;
    expect(sent.body.invitation).toMatchObject({
      email: 'frank@example.com',
      role: 'partner.support',
      status: 'pending',
    });
    // Nothing is granted yet.
    expect((await members()).map((m) => m.userId)).toEqual([ids.carol]);
    expect((await call('frank', 'GET', `/v1/commercial/accounts/${partnerA}`)).status).toBe(403);
    // Someone else holding the link cannot take it; the lookup says so.
    expect((await lookup('erin', token)).body.person).toBe('not_invited_person');
    expect(await accept('erin', token)).toEqual({
      status: 403,
      body: { error: 'invitation_forbidden' },
    });
    // Frank takes it.
    expect((await lookup('frank', token)).body).toMatchObject({
      invitation: { account: { name: 'Partner A', type: 'partner' }, role: 'partner.support' },
      person: 'invited',
    });
    const taken = await accept('frank', token);
    expect(taken).toEqual({
      status: 200,
      body: {
        account: { id: partnerA, name: 'Partner A', type: 'partner' },
        role: 'partner.support',
      },
    });
    expect((await members()).find((m) => m.userId === ids.frank)?.role).toBe('partner.support');
    expect((await call('frank', 'GET', `/v1/commercial/accounts/${partnerA}`)).status).toBe(200);
    // Once only.
    expect((await accept('frank', token)).body).toEqual({
      error: 'invitation_not_pending',
      status: 'accepted',
    });
    expect((await events('member_invitation.accepted')).map((e) => e.result)).toEqual([
      'denied',
      'success',
      'denied',
    ]);
    expect(await events('commercial_membership.created')).toHaveLength(2);
    // Neither the email nor the secret is recorded anywhere in the audit log.
    const logged = JSON.stringify(await events('member_invitation.created'));
    expect(logged).not.toContain('frank@example.com');
    expect(logged).not.toContain(String(token));
  });

  it('refuses an unverified email, a declined or withdrawn link, and a stale version', async () => {
    const { invite, lookup, accept, call, base, members } = await setup();
    const forBob = (await invite('bob@example.com')).body.token;
    expect((await lookup('bob', forBob)).body.person).toBe('email_not_verified');
    expect(await accept('bob', forBob)).toEqual({
      status: 403,
      body: { error: 'email_not_verified' },
    });

    const forDave = (await invite('dave@example.com')).body.token;
    const daveVersion = ((await lookup('dave', forDave)).body.invitation as { updatedAt: string })
      .updatedAt;
    expect(
      (
        await call('dave', 'POST', '/v1/member-invitations/accept', {
          token: forDave,
          expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
        })
      ).body,
    ).toEqual({ error: 'commercial_conflict' });
    expect(
      (
        await call('dave', 'POST', '/v1/member-invitations/reject', {
          token: forDave,
          expectedUpdatedAt: daveVersion,
        })
      ).body,
    ).toEqual({ status: 'rejected' });
    expect((await accept('dave', forDave)).status).toBe(409);

    const listed = (await call('carol', 'GET', base)).body.invitations as {
      id: string;
      email: string;
      status: string;
      updatedAt: string;
    }[];
    const bobs = listed.find((i) => i.email === 'bob@example.com');
    expect(
      (
        await call('carol', 'POST', `${base}/${bobs?.id}/revoke`, {
          expectedUpdatedAt: bobs?.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect((await lookup('bob', forBob)).body.invitation).toMatchObject({ status: 'revoked' });
    expect(await members()).toHaveLength(1);
    // A made-up link opens nothing.
    expect((await lookup('dave', 'x'.repeat(43))).status).toBe(404);
  });

  it('lets only the account admin invite, within its roles and limits, one pending per email', async () => {
    const { ids, invite, accept, call, partnerA } = await setup();
    expect((await invite('frank@example.com', 'agency.admin')).body).toEqual({
      error: 'invalid_commercial_request',
      field: 'role',
    });
    expect((await invite('not-an-email')).body).toEqual({
      error: 'invalid_commercial_request',
      field: 'email',
    });
    const token = (await invite('frank@example.com')).body.token;
    expect((await invite('frank@example.com')).body).toEqual({ error: 'invitation_exists' });
    // Nobody outside the account invites.
    expect((await invite('dave@example.com', 'partner.support', 'erin')).status).toBe(403);
    expect((await accept('frank', token)).status).toBe(200);
    // Support cannot invite, nor join anyone by id.
    expect((await invite('dave@example.com', 'partner.support', 'frank')).status).toBe(403);
    expect(
      (
        await call('carol', 'POST', `/v1/commercial/accounts/${partnerA}/members`, {
          userId: ids.dave,
          role: 'partner.support',
        })
      ).body,
    ).toEqual({ error: 'member_invitation_required' });
    // The account is full (2 members): the next acceptance is refused, nothing half-done.
    const forDave = (await invite('dave@example.com')).body.token;
    expect(await accept('dave', forDave)).toEqual({
      status: 409,
      body: { error: 'commercial_limit_reached' },
    });
  });

  it('changes an active member role only from the version read, and never the admin own role', async () => {
    const { ids, invite, accept, call, partnerA, members } = await setup();
    await accept('frank', (await invite('frank@example.com')).body.token);
    const path = `/v1/commercial/accounts/${partnerA}/members`;
    const list = (await call('carol', 'GET', path)).body.members as {
      userId: string;
      updatedAt: string;
    }[];
    const frank = list.find((m) => m.userId === ids.frank);
    const carol = list.find((m) => m.userId === ids.carol);
    expect(
      (
        await call('carol', 'POST', path, {
          userId: ids.frank,
          role: 'partner.admin',
          expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
        })
      ).body,
    ).toEqual({ error: 'commercial_conflict' });
    expect(
      (
        await call('carol', 'POST', path, {
          userId: ids.frank,
          role: 'partner.admin',
          expectedUpdatedAt: frank?.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('carol', 'POST', path, {
          userId: ids.carol,
          role: 'partner.support',
          expectedUpdatedAt: carol?.updatedAt,
        })
      ).body,
    ).toEqual({ error: 'cannot_change_own_role' });
    expect((await members()).find((m) => m.userId === ids.frank)?.role).toBe('partner.admin');
  });

  it('a suspended account gains nobody, and a removed member returns only by a new invitation', async () => {
    const { ids, invite, accept, call, partnerA, members } = await setup();
    await accept('frank', (await invite('frank@example.com')).body.token);
    await call('carol', 'POST', `/v1/commercial/accounts/${partnerA}/members/${ids.frank}/revoke`);
    expect((await members()).map((m) => m.userId)).toEqual([ids.carol]);
    const again = (await invite('frank@example.com')).body.token;
    const accounts = (
      (await call('alice', 'GET', '/v1/platform/commercial-accounts')).body.accounts as {
        id: string;
        updatedAt: string;
      }[]
    ).find((a) => a.id === partnerA);
    await call('alice', 'POST', `/v1/platform/commercial-accounts/${partnerA}/status`, {
      status: 'suspended',
      expectedUpdatedAt: accounts?.updatedAt,
    });
    expect(await accept('frank', again)).toEqual({
      status: 409,
      body: { error: 'commercial_account_inactive' },
    });
    const suspended = (
      (await call('alice', 'GET', '/v1/platform/commercial-accounts')).body.accounts as {
        id: string;
        updatedAt: string;
      }[]
    ).find((a) => a.id === partnerA);
    await call('alice', 'POST', `/v1/platform/commercial-accounts/${partnerA}/status`, {
      status: 'active',
      expectedUpdatedAt: suspended?.updatedAt,
    });
    expect((await accept('frank', again)).status).toBe(200);
    expect((await members()).map((m) => m.userId).sort()).toEqual([ids.carol, ids.frank].sort());
  });
});
