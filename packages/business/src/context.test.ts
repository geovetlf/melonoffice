import type { BusinessProfile, IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { businessFactsOf, companyContextSnapshotOf } from './context.js';

const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId;
const AT = '2026-09-28T12:00:00.000Z' as IsoTimestamp;

const profile = (extra: Partial<BusinessProfile> = {}): BusinessProfile => ({
  organizationId: ORG,
  businessType: 'restaurant' as BusinessProfile['businessType'],
  country: 'PE',
  currency: 'PEN',
  city: 'Lima',
  timeZone: 'America/Lima',
  revision: 3,
  createdAt: AT,
  updatedAt: AT,
  updatedBy: 'u' as UserId,
  ...extra,
});

describe('the business profile as Company Context (ADR-0048)', () => {
  it('points at the profile, versioned by its revision, and never copies it', () => {
    const snapshot = companyContextSnapshotOf(profile());
    expect(snapshot.ref).toEqual({
      kind: 'company_context',
      id: `business_profile:${ORG}`,
      version: '3',
    });
    expect(Object.keys(snapshot.sections).sort()).toEqual([
      'identity',
      'industry',
      'markets',
      'preferences',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('Lima');
  });

  it('fills products and priorities only from what the owner wrote', () => {
    const snapshot = companyContextSnapshotOf(
      profile({ offering: 'Pollos a la brasa', needs: 'Más pedidos' }),
    );
    expect(snapshot.sections.products).toEqual({ type: 'business_profile', id: ORG });
    expect(snapshot.sections.priorities).toEqual({ type: 'business_profile', id: ORG });
  });

  it('gives GIA the stored facts only, with nothing inferred', () => {
    expect(businessFactsOf('Pollería Don Juan', profile())).toEqual({
      name: 'Pollería Don Juan',
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      city: 'Lima',
      timeZone: 'America/Lima',
    });
    expect(
      businessFactsOf('P', profile({ offering: 'Pollos', salesChannels: ['whatsapp'] })),
    ).toMatchObject({ offering: 'Pollos', salesChannels: ['whatsapp'] });
  });
});
