import { buildAuditEvent } from '@melonoffice/audit';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import type { EntitlementOverride } from '@melonoffice/entitlements';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS } from './audit.js';
import { ENTITLEMENT_OVERRIDES, FirestoreEntitlementOverrideStore } from './overrides.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const AT = new Date('2026-09-28T12:00:00Z');
const ORG_A = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ORG_B = '1c7f8d2f-9b1f-4e6b-8a1f-2d3e4f5a6b7c' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

const override = (key: string, value: unknown): EntitlementOverride =>
  ({ key, value, reason: 'DEV test connection', approvedBy: ALICE }) as EntitlementOverride;

const eventFor = (organizationId: OrganizationId, key: string) =>
  buildAuditEvent(
    {
      action: 'entitlements.override_set',
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      organizationId,
      target: { type: 'organization', id: organizationId },
      reference: `entitlement:${key}`,
      source: 'api',
    },
    AT,
  );

describe.runIf(emulatorHost)('FirestoreEntitlementOverrideStore (emulator)', () => {
  it('stores overrides per organization, key by key, each with its audit event', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreEntitlementOverrideStore(db);
    await store.set(
      ORG_A,
      override('integrations.connectionsMax', 1),
      eventFor(ORG_A, 'integrations.connectionsMax'),
      AT,
    );
    await store.set(
      ORG_A,
      override('integrations.categoriesAllowed', ['messaging']),
      eventFor(ORG_A, 'integrations.categoriesAllowed'),
      AT,
    );
    expect(await store.overridesOf(ORG_A)).toEqual([
      override('integrations.connectionsMax', 1),
      override('integrations.categoriesAllowed', ['messaging']),
    ]);
    expect(await store.overridesOf(ORG_B)).toEqual([]);
    const events = await db.collection(AUDIT_LOGS).get();
    expect(events.docs.map((d) => d.data().action)).toEqual([
      'entitlements.override_set',
      'entitlements.override_set',
    ]);
  });

  it('refuses an invalid override, and fails on a record it cannot use', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreEntitlementOverrideStore(db);
    await expect(
      store.set(
        ORG_A,
        override('integrations.connectionsMax', -1),
        eventFor(ORG_A, 'integrations.connectionsMax'),
        AT,
      ),
    ).rejects.toThrow();
    expect((await db.collection(AUDIT_LOGS).get()).empty).toBe(true);
    await db
      .collection(ENTITLEMENT_OVERRIDES)
      .doc(ORG_A)
      .set({ organizationId: ORG_A, overrides: { 'no.such.key': { valueJson: '1' } } });
    await expect(store.overridesOf(ORG_A)).rejects.toThrow();
  });
});
