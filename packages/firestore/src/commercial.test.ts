import { buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import { openBilling } from '@melonoffice/billing';
import { openWallet } from '@melonoffice/credits';
import type {
  CommercialAccount,
  CommercialAccountId,
  CommercialMembership,
  CustomerInvitation,
  CustomerInvitationId,
  CustomerRelationship,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import {
  commercialMembershipIdOf,
  customerAccessOf,
  customerRelationshipIdOf,
  hashInvitationToken,
  listCustomersOf,
  newCommercialAccountId,
  newCustomerInvitationId,
  newInvitationToken,
  resolveCommercialContext,
  TenancyError,
} from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS } from './audit.js';
import {
  COMMERCIAL_ACCOUNTS,
  COMMERCIAL_MEMBERSHIPS,
  CUSTOMER_RELATIONSHIPS,
  FirestoreCommercialStore,
} from './commercial.js';
import { FirestoreTenancyStore } from './tenancy.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * The commercial layer's Firestore store (ADR-0086, ADR-0089, ADR-0091) against the emulator: what
 * it writes, that every write carries its audit events, that versions and limits are checked
 * inside the transaction (so concurrent writes cannot pass them), and that the access checks
 * built on it keep partners, their customers and other organizations apart.
 */
const NOW = '2026-09-30T12:00:00.000Z' as IsoTimestamp;
const LATER = '2026-09-30T13:00:00.000Z' as IsoTimestamp;
const CAROL = '33333333-3333-4333-8333-333333333333' as UserId;
const DAVE = '44444444-4444-4444-8444-444444444444' as UserId;
const ERIN = '55555555-5555-4555-8555-555555555555' as UserId;
const OWNER = '66666666-6666-4666-8666-666666666666' as UserId;
const user = (userId: UserId) => ({ actor: 'user' as const, userId, emailVerified: true });

const account = (name: string, limits = { customers: 2, members: 2 }): CommercialAccount => ({
  id: newCommercialAccountId(),
  type: 'partner',
  name,
  status: 'active',
  limits,
  createdAt: NOW,
  updatedAt: NOW,
});
const member = (
  accountId: CommercialAccountId,
  userId: UserId,
  role = 'partner.admin',
): CommercialMembership => ({
  id: commercialMembershipIdOf(accountId, userId),
  commercialAccountId: accountId,
  userId,
  role,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
});
const relationship = (
  accountId: CommercialAccountId,
  organizationId: OrganizationId,
  status: CustomerRelationship['status'],
  scopes: CustomerRelationship['scopes'] = ['summary'],
): CustomerRelationship => ({
  id: customerRelationshipIdOf(accountId, organizationId),
  commercialAccountId: accountId,
  organizationId,
  mode: 'reseller',
  status,
  scopes,
  createdAt: NOW,
  updatedAt: NOW,
});
const event = (
  action: 'commercial_account.created' | 'commercial_account.status_changed',
  accountId: CommercialAccountId,
): AuditEvent =>
  buildAuditEvent(
    {
      action,
      result: 'success',
      actor: { type: 'user', userId: CAROL, via: 'direct' },
      actorRole: 'platform_admin',
      commercialAccountId: accountId,
      target: { type: 'commercial_account', id: accountId },
      source: 'api',
    },
    new Date(NOW),
  );

describe.runIf(emulatorHost)('FirestoreCommercialStore (emulator)', () => {
  async function setup() {
    const db = emulatorFirestore();
    const store = new FirestoreCommercialStore(db);
    const tenancy = new FirestoreTenancyStore(db, () => new Date(NOW));
    const org = async (name: string) =>
      (
        await tenancy.createOrganization({
          name,
          // One organization per creator: each test company has its own owner.
          creator: randomUUID() as UserId,
          billing: (o) => openBilling(o, { id: 'entrepreneur', version: 1 }),
          credits: openWallet,
        })
      ).organization.id;
    const partnerA = account('Partner A');
    const partnerB = account('Partner B');
    await store.createAccount(partnerA, member(partnerA.id, CAROL), [
      event('commercial_account.created', partnerA.id),
    ]);
    await store.createAccount(partnerB, member(partnerB.id, DAVE), [
      event('commercial_account.created', partnerB.id),
    ]);
    const audit = async () => (await db.collection(AUDIT_LOGS).get()).docs.map((d) => d.data());
    return { db, store, tenancy, org, partnerA, partnerB, audit };
  }

  it('creates an account with its first admin and its audit event, and never twice', async () => {
    const { db, store, partnerA, audit } = await setup();
    expect(await store.findAccount(partnerA.id)).toEqual(partnerA);
    expect(
      (await db.collection(COMMERCIAL_MEMBERSHIPS).doc(`${partnerA.id}_${CAROL}`).get()).exists,
    ).toBe(true);
    expect((await audit()).filter((e) => e.action === 'commercial_account.created')).toHaveLength(
      2,
    );
    await expect(store.createAccount(partnerA, member(partnerA.id, ERIN), [])).rejects.toEqual(
      new TenancyError('commercial_conflict'),
    );
    expect(await store.findMembership(partnerA.id, ERIN)).toBeUndefined();
  });

  it('changes an account only from the version read, with its audit, keeping everything else', async () => {
    const { db, store, partnerA, audit } = await setup();
    const suspended = { ...partnerA, status: 'suspended' as const, updatedAt: LATER };
    await store.saveAccount(suspended, partnerA, [
      event('commercial_account.status_changed', partnerA.id),
    ]);
    expect(await store.findAccount(partnerA.id)).toEqual(suspended);
    // A second change from the old version loses: nothing is overwritten.
    await expect(
      store.saveAccount({ ...partnerA, status: 'closed' }, partnerA, [
        event('commercial_account.status_changed', partnerA.id),
      ]),
    ).rejects.toEqual(new TenancyError('commercial_conflict'));
    expect((await store.findAccount(partnerA.id))?.status).toBe('suspended');
    const stored = (await audit()).filter((e) => e.action === 'commercial_account.status_changed');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.actorRole).toBe('platform_admin');
    // The member and the account document are still there.
    expect(await store.findMembership(partnerA.id, CAROL)).toBeDefined();
    expect((await db.collection(COMMERCIAL_ACCOUNTS).get()).size).toBe(2);
    // An account that does not exist cannot be "changed" into existence.
    const ghost = account('Ghost');
    await expect(store.saveAccount(ghost, ghost, [])).rejects.toEqual(
      new TenancyError('commercial_conflict'),
    );
    expect(await store.findAccount(ghost.id)).toBeUndefined();
  });

  it('resolves a person only in an active account they are an active member of', async () => {
    const { store, partnerA, partnerB } = await setup();
    const context = await resolveCommercialContext(user(CAROL), partnerA.id, store);
    expect(context).toMatchObject({ commercialAccountId: partnerA.id, role: 'partner.admin' });
    // Carol is nobody in Partner B, and an outsider is nobody anywhere.
    for (const [who, id] of [
      [CAROL, partnerB.id],
      [ERIN, partnerA.id],
    ] as const) {
      await expect(resolveCommercialContext(user(who), id, store)).rejects.toEqual(
        new TenancyError('commercial_account_forbidden'),
      );
    }
    // GIA acting for Carol has no commercial path.
    await expect(
      resolveCommercialContext({ ...user(CAROL), actor: 'gia' }, partnerA.id, store),
    ).rejects.toEqual(new TenancyError('commercial_account_forbidden'));
    // Suspending the account shuts it for its own admin too.
    await store.saveAccount({ ...partnerA, status: 'suspended', updatedAt: LATER }, partnerA, []);
    await expect(resolveCommercialContext(user(CAROL), partnerA.id, store)).rejects.toEqual(
      new TenancyError('commercial_account_forbidden'),
    );
    // A revoked membership is refused as well.
    const dave = member(partnerB.id, DAVE);
    await store.saveMembership({ ...dave, status: 'revoked', updatedAt: LATER }, dave, []);
    await expect(resolveCommercialContext(user(DAVE), partnerB.id, store)).rejects.toEqual(
      new TenancyError('commercial_account_forbidden'),
    );
  });

  it('counts the member limit inside the transaction, even for concurrent additions', async () => {
    const { store, partnerA } = await setup();
    // Limit 2: Carol plus one. Two people added at the same time: exactly one gets in.
    const results = await Promise.allSettled([
      store.saveMembership(member(partnerA.id, DAVE, 'partner.support'), undefined, [], 2),
      store.saveMembership(member(partnerA.id, ERIN, 'partner.support'), undefined, [], 2),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toEqual(new TenancyError('commercial_limit_reached'));
    const active = (await store.membersOfAccount(partnerA.id)).filter((m) => m.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('keeps each partner to its own customers, and to what they granted', async () => {
    const { store, tenancy, org, partnerA, partnerB } = await setup();
    const tenantA = await org('Tenant A');
    const tenantB = await org('Tenant B');
    await store.saveRelationship(
      relationship(partnerA.id, tenantA, 'active', ['usage']),
      undefined,
      [],
      2,
    );
    await store.saveRelationship(relationship(partnerA.id, tenantB, 'pending'), undefined, [], 2);
    const carol = await resolveCommercialContext(user(CAROL), partnerA.id, store);
    const dave = await resolveCommercialContext(user(DAVE), partnerB.id, store);

    const access = await customerAccessOf(carol, tenantA, store, tenancy);
    expect([...access.scopes]).toEqual(['usage']);
    // A pending relationship grants nothing; another partner's customer is not reachable; a
    // made-up id looks the same as all of them.
    for (const [context, organizationId] of [
      [carol, tenantB],
      [dave, tenantA],
      [carol, '77777777-7777-4777-8777-777777777777'],
    ] as const) {
      await expect(customerAccessOf(context, organizationId, store, tenancy)).rejects.toEqual(
        new TenancyError('customer_forbidden'),
      );
    }
    expect((await listCustomersOf(carol, store, tenancy)).map((c) => c.organizationId)).toEqual([
      tenantA,
    ]);
    expect(await listCustomersOf(dave, store, tenancy)).toEqual([]);
    // A copied context authorizes nothing.
    await expect(customerAccessOf({ ...carol }, tenantA, store, tenancy)).rejects.toEqual(
      new TenancyError('customer_forbidden'),
    );
  });

  it('counts the customer limit inside the transaction and checks versions', async () => {
    const { db, store, org, partnerA } = await setup();
    const [one, two, three] = [await org('One'), await org('Two'), await org('Three')];
    const results = await Promise.allSettled(
      [one, two, three].map((o) =>
        store.saveRelationship(relationship(partnerA.id, o, 'pending'), undefined, [], 2),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      (
        await db
          .collection(CUSTOMER_RELATIONSHIPS)
          .where('commercialAccountId', '==', partnerA.id)
          .get()
      ).size,
    ).toBe(2);
    const stored = (await store.relationshipsOfAccount(partnerA.id))[0] as CustomerRelationship;
    await expect(
      store.saveRelationship({ ...stored, status: 'ended' }, { ...stored, updatedAt: LATER }, []),
    ).rejects.toEqual(new TenancyError('commercial_conflict'));
  });

  describe('invitations', () => {
    const invitation = (
      accountId: CommercialAccountId,
      tokenHash: string,
      id: CustomerInvitationId = newCustomerInvitationId(),
    ): CustomerInvitation => ({
      id,
      commercialAccountId: accountId,
      email: 'ana@example.com',
      mode: 'reseller',
      scopes: ['summary'],
      status: 'pending',
      tokenHash,
      expiresAt: '2026-10-07T12:00:00.000Z' as IsoTimestamp,
      createdBy: CAROL,
      createdAt: NOW,
      updatedAt: NOW,
    });

    it('finds an invitation only by the exact hash of its secret', async () => {
      const { store, partnerA } = await setup();
      const { token, tokenHash } = newInvitationToken();
      const sent = invitation(partnerA.id, tokenHash);
      await store.saveInvitation(sent, undefined, [], 5);
      expect(await store.findInvitationByTokenHash(hashInvitationToken(token))).toEqual(sent);
      expect(await store.findInvitationByTokenHash(newInvitationToken().tokenHash)).toBeUndefined();
      // The secret itself is never what is stored.
      expect(JSON.stringify(await store.findInvitation(sent.id))).not.toContain(token);
    });

    it('counts pending invitations inside the transaction', async () => {
      const { store, partnerA } = await setup();
      await store.saveInvitation(
        invitation(partnerA.id, newInvitationToken().tokenHash),
        undefined,
        [],
        1,
      );
      await expect(
        store.saveInvitation(
          invitation(partnerA.id, newInvitationToken().tokenHash),
          undefined,
          [],
          1,
        ),
      ).rejects.toEqual(new TenancyError('commercial_limit_reached'));
    });

    it('accepts once: the invitation and its relationship are written together or not at all', async () => {
      const { store, org, partnerA } = await setup();
      const tenant = await org('Tenant');
      const sent = invitation(partnerA.id, newInvitationToken().tokenHash);
      await store.saveInvitation(sent, undefined, [], 5);
      const accepted = {
        ...sent,
        status: 'accepted' as const,
        decidedBy: OWNER,
        organizationId: tenant,
        updatedAt: LATER,
      };
      const created = relationship(partnerA.id, tenant, 'active');
      const results = await Promise.allSettled([
        store.acceptInvitation(accepted, sent, created, undefined, [], 5),
        store.acceptInvitation(accepted, sent, created, undefined, [], 5),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await store.findInvitation(sent.id))?.status).toBe('accepted');
      expect(await store.findRelationship(partnerA.id, tenant)).toEqual(created);
      // Over the customer limit, neither is written.
      const other = invitation(partnerA.id, newInvitationToken().tokenHash);
      await store.saveInvitation(other, undefined, [], 5);
      const second = await org('Second');
      await expect(
        store.acceptInvitation(
          { ...other, status: 'accepted', organizationId: second, updatedAt: LATER },
          other,
          relationship(partnerA.id, second, 'active'),
          undefined,
          [],
          1,
        ),
      ).rejects.toEqual(new TenancyError('commercial_limit_reached'));
      expect((await store.findInvitation(other.id))?.status).toBe('pending');
      expect(await store.findRelationship(partnerA.id, second)).toBeUndefined();
    });
  });
});
