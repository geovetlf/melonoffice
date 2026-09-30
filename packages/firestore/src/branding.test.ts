import { buildAuditEvent } from '@melonoffice/audit';
import { BrandingError, brandConfigIdOf } from '@melonoffice/branding';
import type {
  BrandConfigRecord,
  BrandOwner,
  CommercialAccountId,
  DomainBinding,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS } from './audit.js';
import { BRAND_CONFIGS, DOMAIN_BINDINGS, FirestoreBrandStore } from './branding.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * The branding store (ADR-0087) against the emulator: one brand per owner, never mixed between
 * owners, changed only from the version read and always with its audit event; and domain
 * bindings, unique per hostname.
 */
const NOW = '2026-09-30T12:00:00.000Z' as IsoTimestamp;
const LATER = '2026-09-30T13:00:00.000Z' as IsoTimestamp;
const OWNER = '11111111-1111-4111-8111-111111111111' as UserId;
const ORG_A = '22222222-2222-4222-8222-222222222222' as OrganizationId;
const ORG_B = '33333333-3333-4333-8333-333333333333' as OrganizationId;
const PARTNER = '44444444-4444-4444-8444-444444444444' as CommercialAccountId;

const record = (owner: BrandOwner, productName: string): BrandConfigRecord => ({
  id: brandConfigIdOf(owner),
  owner,
  config: { productName },
  createdAt: NOW,
  updatedAt: NOW,
  updatedBy: OWNER,
});
const audited = (owner: BrandOwner) => [
  buildAuditEvent(
    {
      action: 'brand_config.updated',
      result: 'success',
      actor: { type: 'user', userId: OWNER, via: 'direct' },
      ...(owner.level === 'organization' ? { organizationId: owner.organizationId } : {}),
      target: { type: 'brand_config', id: brandConfigIdOf(owner) },
      reference: owner.level,
      source: 'api',
    },
    new Date(NOW),
  ),
];

describe.runIf(emulatorHost)('FirestoreBrandStore (emulator)', () => {
  function setup() {
    const db = emulatorFirestore();
    return { db, store: new FirestoreBrandStore(db) };
  }

  it('keeps one brand per owner and never mixes owners or levels', async () => {
    const { db, store } = setup();
    const a: BrandOwner = { level: 'organization', organizationId: ORG_A };
    const b: BrandOwner = { level: 'organization', organizationId: ORG_B };
    const white: BrandOwner = {
      level: 'white_label',
      commercialAccountId: PARTNER,
      organizationId: ORG_A,
    };
    await store.saveBrand(record(a, 'Acme'), undefined, audited(a));
    await store.saveBrand(record(white, 'Partner for Acme'), undefined, audited(white));
    expect((await store.findBrand(a))?.config).toEqual({ productName: 'Acme' });
    expect((await store.findBrand(white))?.config).toEqual({ productName: 'Partner for Acme' });
    expect(await store.findBrand(b)).toBeUndefined();
    expect(
      await store.findBrand({ level: 'commercial_account', commercialAccountId: PARTNER }),
    ).toBeUndefined();
    expect((await db.collection(BRAND_CONFIGS).get()).size).toBe(2);
    expect((await db.collection(AUDIT_LOGS).get()).size).toBe(2);
  });

  it('changes a brand only from the version read, even when two saves race', async () => {
    const { db, store } = setup();
    const a: BrandOwner = { level: 'organization', organizationId: ORG_A };
    const first = record(a, 'Acme');
    await store.saveBrand(first, undefined, audited(a));
    // Creating it again as if it did not exist is refused.
    await expect(store.saveBrand(record(a, 'Other'), undefined, audited(a))).rejects.toEqual(
      new BrandingError('brand_conflict'),
    );
    const results = await Promise.allSettled([
      store.saveBrand(
        { ...first, config: { productName: 'One' }, updatedAt: LATER },
        first,
        audited(a),
      ),
      store.saveBrand(
        { ...first, config: { productName: 'Two' }, updatedAt: LATER },
        first,
        audited(a),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const now = (await store.findBrand(a))?.config.productName;
    expect(['One', 'Two']).toContain(now);
    // One audit event per stored change: the refused writes left none.
    expect((await db.collection(AUDIT_LOGS).get()).size).toBe(2);
  });

  it('keeps a hostname to one binding, changed only from the version read', async () => {
    const { db, store } = setup();
    const binding: DomainBinding = {
      hostname: 'app.acme.example',
      target: { type: 'organization', organizationId: ORG_A },
      status: 'pending_verification',
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: OWNER,
    };
    await store.saveDomain(binding, undefined, []);
    await expect(
      store.saveDomain(
        { ...binding, target: { type: 'organization', organizationId: ORG_B } },
        undefined,
        [],
      ),
    ).rejects.toEqual(new BrandingError('domain_conflict'));
    expect((await store.findDomain('app.acme.example'))?.target).toEqual(binding.target);
    await expect(
      store.saveDomain({ ...binding, status: 'active' }, { ...binding, updatedAt: LATER }, []),
    ).rejects.toEqual(new BrandingError('domain_conflict'));
    expect((await db.collection(DOMAIN_BINDINGS).get()).size).toBe(1);
    expect(await store.listDomains()).toHaveLength(1);
  });
});
