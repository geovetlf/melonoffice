import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import { DEFAULT_DEPARTMENT_CATALOGUE, provisionDepartments } from '@melonoffice/departments';
import type { InitialBilling, Organization, SubscriptionId, UserId } from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createBusinessTypeCatalogue, DEFAULT_BUSINESS_TYPE_CATALOGUE } from './catalogue.js';
import { BusinessError } from './errors.js';
import { checkProfileContent, isCountry, isCurrency, isTimeZone } from './profile.js';
import { InMemoryBusinessProfileRepository } from './repository.js';
import { createBusinessProfileService } from './service.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

const VALID = {
  businessType: 'restaurant',
  country: 'PE',
  currency: 'PEN',
  timeZone: 'America/Lima',
  city: 'Lima',
};

async function codeOf(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof BusinessError) {
      return error.field === undefined ? error.code : `${error.code}:${error.field}`;
    }
    throw error;
  }
  return 'accepted';
}

async function world() {
  const audit = new InMemoryAuditStore();
  const repository = new InMemoryBusinessProfileRepository(audit);
  const tenancy = new InMemoryTenancyStore(() => NOW);
  const options = {
    billing: BILLING,
    departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
    credits: openWallet,
  };
  const a = await createOrganization(as(ALICE), { name: 'Pollería A' }, tenancy, options);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
  const service = createBusinessProfileService({
    repository,
    organizations: tenancy,
    authorization: createAuthorizationService(),
    now: () => NOW,
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const giaA = await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy);
  const events = () => audit.events().filter((e) => e.action === 'organization.profile_updated');
  return { service, tenantA, tenantB, giaA, orgA: a.organization.id, events, repository };
}

describe('business types (ADR-0048)', () => {
  it('suggests the Master Functional Map orders, and the general one for the rest', () => {
    const order = (id: string) => DEFAULT_BUSINESS_TYPE_CATALOGUE.find(id)?.departmentPriority;
    expect(order('restaurant')).toEqual([
      'sales',
      'operations',
      'marketing',
      'finance',
      'leadership',
      'research',
    ]);
    expect(order('professional_services')?.slice(0, 5)).toEqual([
      'sales',
      'marketing',
      'finance',
      'leadership',
      'research',
    ]);
    expect(order('ecommerce')?.slice(0, 5)).toEqual([
      'sales',
      'marketing',
      'operations',
      'finance',
      'research',
    ]);
    expect(order('store')).toEqual(order('other'));
    // Every order names only offered departments, each once: nothing is ever hidden.
    const offered = DEFAULT_DEPARTMENT_CATALOGUE.types.map((t) => t.id).sort();
    for (const type of DEFAULT_BUSINESS_TYPE_CATALOGUE.types) {
      expect([...type.departmentPriority].sort()).toEqual(offered);
    }
  });

  it('refuses duplicate or malformed types', () => {
    const t = { id: 'x', nameKey: 'k', departmentPriority: [] } as never;
    expect(() => createBusinessTypeCatalogue([t, t])).toThrow();
    expect(() =>
      createBusinessTypeCatalogue([{ id: 'Bad', nameKey: 'k', departmentPriority: [] } as never]),
    ).toThrow();
  });
});

describe('profile checks', () => {
  it('accepts ISO countries and currencies and IANA time zones only', () => {
    expect(isCountry('PE')).toBe(true);
    expect(isCountry('pe')).toBe(false);
    expect(isCountry('EU')).toBe(false);
    expect(isCountry('XX')).toBe(false);
    expect(isCurrency('PEN')).toBe(true);
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('ABC')).toBe(false);
    expect(isTimeZone('America/Lima')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Base')).toBe(false);
  });

  it.each([
    ['no business type', { ...VALID, businessType: undefined }, 'businessType'],
    ['an unknown business type', { ...VALID, businessType: 'casino' }, 'businessType'],
    ['no country', { ...VALID, country: undefined }, 'country'],
    ['no currency', { ...VALID, currency: undefined }, 'currency'],
    ['no time zone', { ...VALID, timeZone: undefined }, 'timeZone'],
    ['an unknown key', { ...VALID, plan: 'enterprise' }, 'plan'],
    ['a city over 100 characters', { ...VALID, city: 'a'.repeat(101) }, 'city'],
    ['a city on two lines', { ...VALID, city: 'Lima\nCallao' }, 'city'],
    ['no city', { ...VALID, city: undefined }, 'city'],
    ['a blank city', { ...VALID, city: '   ' }, 'city'],
    ['a bad employee range', { ...VALID, employees: '1000' }, 'employees'],
    ['a repeated channel', { ...VALID, salesChannels: ['whatsapp', 'whatsapp'] }, 'salesChannels'],
    ['an unknown channel', { ...VALID, salesChannels: ['fax'] }, 'salesChannels'],
    ['notes over 500 characters', { ...VALID, notes: 'a'.repeat(501) }, 'notes'],
  ])('refuses %s, naming the field only', async (_case, input, field) => {
    expect(await codeOf(() => checkProfileContent(input, DEFAULT_BUSINESS_TYPE_CATALOGUE))).toBe(
      `invalid_profile:${field}`,
    );
  });

  it('keeps optional fields optional, and stores channels in one order', () => {
    const content = checkProfileContent(
      {
        ...VALID,
        city: ' Lima ',
        employees: '',
        salesChannels: ['website', 'whatsapp'],
        offering: ' Pollos ',
        notes: '   ',
      },
      DEFAULT_BUSINESS_TYPE_CATALOGUE,
    );
    expect(content).toEqual({
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      timeZone: 'America/Lima',
      city: 'Lima',
      salesChannels: ['whatsapp', 'website'],
      offering: 'Pollos',
    });
  });
});

describe('business profile service', () => {
  it('reads nothing until it is filled in, with the general order', async () => {
    const w = await world();
    const read = await w.service.get(w.tenantA);
    expect(read.profile).toBeUndefined();
    expect(read.departmentPriority).toEqual(
      DEFAULT_BUSINESS_TYPE_CATALOGUE.find('other')?.departmentPriority,
    );
  });

  it('saves it with one audit event that names the type, never what was written', async () => {
    const w = await world();
    const saved = await w.service.save(w.tenantA, { ...VALID, notes: 'Secreto del negocio' });
    expect(saved.profile).toMatchObject({
      organizationId: w.orgA,
      businessType: 'restaurant',
      revision: 1,
      updatedBy: ALICE,
    });
    expect(saved.departmentPriority[1]).toBe('operations');
    const [event] = w.events();
    expect(event).toMatchObject({
      organizationId: w.orgA,
      reason: 'created',
      reference: 'business_type:restaurant',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
    });
    expect(JSON.stringify(w.events())).not.toContain('Secreto');
    expect(JSON.stringify(w.events())).not.toContain('Lima');
  });

  it('records nothing when nothing changed, and a new revision when it did', async () => {
    const w = await world();
    await w.service.save(w.tenantA, VALID);
    await w.service.save(w.tenantA, VALID);
    expect(w.events()).toHaveLength(1);
    const next = await w.service.save(w.tenantA, { ...VALID, businessType: 'ecommerce' });
    expect(next.profile?.revision).toBe(2);
    expect(w.events().map((e) => e.reason)).toEqual(['created', 'updated']);
  });

  it('lets GIA read it, never change it', async () => {
    const w = await world();
    await w.service.save(w.tenantA, VALID);
    expect((await w.service.get(w.giaA)).profile?.country).toBe('PE');
    expect(await codeOf(w.service.save(w.giaA, { ...VALID, country: 'CL' }))).toBe('requires_user');
    expect((await w.service.get(w.tenantA)).profile?.country).toBe('PE');
  });

  it('keeps organizations apart: each reads and writes only its own', async () => {
    const w = await world();
    await w.service.save(w.tenantA, VALID);
    expect((await w.service.get(w.tenantB)).profile).toBeUndefined();
    await w.service.save(w.tenantB, { ...VALID, country: 'CL', currency: 'CLP' });
    expect((await w.service.get(w.tenantA)).profile?.country).toBe('PE');
    expect((await w.service.get(w.tenantB)).profile?.country).toBe('CL');
  });
});
