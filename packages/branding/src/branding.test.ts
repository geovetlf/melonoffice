import { InMemoryAuditStore } from '@melonoffice/audit';
import type {
  CommercialAccountId,
  IsoTimestamp,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { InMemoryCommercialStore } from '@melonoffice/tenancy';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRAND_LANGUAGES,
  brandConfigIdOf,
  canChangeDomainStatus,
  effectiveBrandOf,
  InMemoryBrandRepository,
  mergeBrand,
  parseBrandConfig,
  parseDomainTarget,
  parseHostname,
  PLATFORM_BRAND,
  resolveDomain,
} from './index.js';

const T = '2026-09-29T00:00:00.000Z' as IsoTimestamp;
const USER = '11111111-0000-4000-8000-000000000001' as UserId;
const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a' as OrganizationId;
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b' as OrganizationId;
const PARTNER_A = 'cccccccc-0000-4000-8000-00000000000a' as CommercialAccountId;
const PARTNER_B = 'cccccccc-0000-4000-8000-00000000000b' as CommercialAccountId;

function world() {
  const brands = new InMemoryBrandRepository(new InMemoryAuditStore());
  const commercial = new InMemoryCommercialStore(new InMemoryAuditStore());
  const orgs = new Map<string, Organization>();
  for (const id of [ORG_A, ORG_B]) {
    orgs.set(id, {
      id,
      name: id,
      status: 'active',
      createdBy: USER,
      createdAt: T,
      updatedAt: T,
    } as Organization);
  }
  for (const id of [PARTNER_A, PARTNER_B]) {
    commercial.putAccount({
      id,
      type: 'partner',
      name: id,
      status: 'active',
      createdAt: T,
      updatedAt: T,
    });
  }
  const put = (owner: Parameters<typeof brandConfigIdOf>[0], config: object) =>
    brands.putBrand({
      id: brandConfigIdOf(owner),
      owner,
      config,
      createdAt: T,
      updatedAt: T,
      updatedBy: USER,
    });
  const relate = (
    account: CommercialAccountId,
    org: OrganizationId,
    mode: string,
    scopes: string[],
  ) =>
    commercial.putRelationship({
      id: `${account}_${org}`,
      commercialAccountId: account,
      organizationId: org,
      mode,
      status: 'active',
      scopes,
      createdAt: T,
      updatedAt: T,
    } as never);
  const deps = {
    brands,
    commercial,
    organizations: { findOrganization: async (id: OrganizationId) => orgs.get(id) },
  };
  return { brands, commercial, orgs, put, relate, deps };
}

describe('brand configuration', () => {
  it('keeps only known, checked fields, and refuses the customer’s facts above its own level', () => {
    expect(
      parseBrandConfig(
        {
          brandName: '  Casa  ',
          primaryColor: '#ABCDEF',
          supportContact: { email: 'help@casa.example', phone: '+51 1 234 5678' },
          links: { terms: 'https://casa.example/terms' },
          login: {},
          defaultLanguage: 'es',
          timeZone: 'America/Lima',
          currency: 'PEN',
          country: 'PE',
          company: { legalName: 'Casa S.A.C.' },
        },
        'organization',
      ),
    ).toEqual({
      brandName: 'Casa',
      primaryColor: '#abcdef',
      supportContact: { email: 'help@casa.example', phone: '+51 1 234 5678' },
      links: { terms: 'https://casa.example/terms' },
      defaultLanguage: 'es',
      timeZone: 'America/Lima',
      currency: 'PEN',
      country: 'PE',
      company: { legalName: 'Casa S.A.C.' },
    });
    for (const level of ['commercial_account', 'white_label'] as const) {
      for (const fact of [
        { company: { legalName: 'X' } },
        { timeZone: 'UTC' },
        { currency: 'USD' },
        { country: 'US' },
      ]) {
        expect(() => parseBrandConfig(fact, level)).toThrow('invalid_brand_config');
      }
    }
    for (const bad of [
      null,
      [],
      { brandName: '' },
      { brandName: 'a'.repeat(81) },
      { brandName: 'line\nbreak' },
      { faviconUrl: 'javascript:alert(1)' },
      { links: { privacy: 'data:text/html,x' } },
      { agentNaming: { singular: 'Agent' } },
      { defaultLanguage: 'fr' },
      { supportContact: { email: 'nope' } },
    ]) {
      expect(() => parseBrandConfig(bad, 'organization')).toThrow('invalid_brand_config');
    }
  });

  it('offers exactly the languages the product has', () => {
    const locales = readdirSync(
      fileURLToPath(new URL('../../i18n/src/locales', import.meta.url)),
    ).map((f) => f.replace('.json', ''));
    expect([...BRAND_LANGUAGES].sort()).toEqual(locales.sort());
  });

  it('merges level by level, groups key by key', () => {
    expect(
      mergeBrand(
        PLATFORM_BRAND,
        { brandName: 'P', login: { title: 'Hi', message: 'Welcome' } },
        { login: { title: 'Hola' } },
      ),
    ).toMatchObject({
      brandName: 'P',
      productName: 'MelonOffice',
      login: { title: 'Hola', message: 'Welcome' },
    });
  });
});

describe('brand precedence', () => {
  it('is the platform alone for a Direct SaaS organization, then its own level with its facts', async () => {
    const { deps, put } = world();
    expect(await effectiveBrandOf(ORG_A, deps)).toEqual({ brand: PLATFORM_BRAND, levels: [] });
    put({ level: 'organization', organizationId: ORG_A }, { brandName: 'A' });
    const withFacts = { ...deps, businessFacts: async () => ({ timeZone: 'America/Lima' }) };
    expect((await effectiveBrandOf(ORG_A, withFacts)).brand).toMatchObject({
      brandName: 'A',
      timeZone: 'America/Lima',
      assistantName: 'GIA',
    });
  });

  it('applies platform, partner, customer, then white label, and only for its own white-label partner', async () => {
    const { deps, put, relate } = world();
    put(
      { level: 'commercial_account', commercialAccountId: PARTNER_A },
      { brandName: 'PA', productName: 'PA Office' },
    );
    put({ level: 'commercial_account', commercialAccountId: PARTNER_B }, { brandName: 'PB' });
    put({ level: 'organization', organizationId: ORG_A }, { brandName: 'Own A', country: 'PE' });
    put(
      { level: 'white_label', commercialAccountId: PARTNER_A, organizationId: ORG_A },
      { assistantName: 'Ava' },
    );
    put(
      { level: 'white_label', commercialAccountId: PARTNER_B, organizationId: ORG_A },
      { assistantName: 'Stolen' },
    );
    relate(PARTNER_A, ORG_A, 'white_label', ['branding']);
    relate(PARTNER_B, ORG_B, 'white_label', ['branding']);
    const a = await effectiveBrandOf(ORG_A, deps);
    expect(a.levels).toEqual(['commercial_account', 'organization', 'white_label']);
    expect(a.brand).toMatchObject({
      brandName: 'Own A',
      productName: 'PA Office',
      assistantName: 'Ava',
      country: 'PE',
    });
    // Partner B's level for Tenant A never applies: it has no relationship with it.
    expect(JSON.stringify(a.brand)).not.toContain('Stolen');
    expect(JSON.stringify(a.brand)).not.toContain('PB');
    expect((await effectiveBrandOf(ORG_B, deps)).brand).toMatchObject({ brandName: 'PB' });
  });

  it('drops the partner’s levels when the relationship is not white label, not active, or not unique', async () => {
    const { deps, put, relate, commercial } = world();
    put({ level: 'commercial_account', commercialAccountId: PARTNER_A }, { brandName: 'PA' });
    relate(PARTNER_A, ORG_A, 'reseller', ['branding']);
    expect((await effectiveBrandOf(ORG_A, deps)).levels).toEqual([]);
    relate(PARTNER_A, ORG_A, 'white_label', []);
    expect((await effectiveBrandOf(ORG_A, deps)).levels).toEqual(['commercial_account']);
    relate(PARTNER_B, ORG_A, 'white_label', []);
    expect((await effectiveBrandOf(ORG_A, deps)).levels).toEqual([]);
    relate(PARTNER_B, ORG_A, 'reseller', []);
    commercial.putAccount({
      id: PARTNER_A,
      type: 'partner',
      name: 'A',
      status: 'suspended',
      createdAt: T,
      updatedAt: T,
    });
    expect((await effectiveBrandOf(ORG_A, deps)).levels).toEqual([]);
  });
});

describe('domain resolution', () => {
  it('accepts hostnames in one form and targets of exactly one kind', () => {
    expect(parseHostname('App.Customer.COM')).toBe('app.customer.com');
    for (const bad of [
      '',
      'localhost',
      'a..b.com',
      '-a.com',
      'a.com.',
      '10.0.0.1',
      'a.com:443',
      'a b.com',
    ]) {
      expect(() => parseHostname(bad)).toThrow('invalid_hostname');
    }
    expect(parseDomainTarget({ type: 'organization', organizationId: ORG_A })).toEqual({
      type: 'organization',
      organizationId: ORG_A,
    });
    for (const bad of [
      { type: 'organization', organizationId: 'x' },
      { type: 'organization', organizationId: ORG_A, commercialAccountId: PARTNER_A },
      { type: 'tenant', organizationId: ORG_A },
    ]) {
      expect(() => parseDomainTarget(bad)).toThrow('invalid_domain_target');
    }
    expect(canChangeDomainStatus('pending_verification', 'active')).toBe(false);
    expect(canChangeDomainStatus('verified', 'active')).toBe(true);
    expect(canChangeDomainStatus('disabled', 'active')).toBe(false);
  });

  it('resolves only an active binding, only to its own active target (11)', async () => {
    const { deps, brands, put, orgs } = world();
    put({ level: 'organization', organizationId: ORG_A }, { brandName: 'A' });
    put({ level: 'organization', organizationId: ORG_B }, { brandName: 'B' });
    const bind = (hostname: string, target: object, status: string) =>
      brands.putDomain({
        hostname,
        target,
        status,
        createdAt: T,
        updatedAt: T,
        createdBy: USER,
      } as never);
    bind('a.example', { type: 'organization', organizationId: ORG_A }, 'active');
    bind('b.example', { type: 'organization', organizationId: ORG_B }, 'verified');
    bind('p.example', { type: 'commercial_account', commercialAccountId: PARTNER_A }, 'active');
    expect(await resolveDomain('A.example', deps)).toMatchObject({
      context: { type: 'organization', organizationId: ORG_A },
      brand: { brandName: 'A' },
    });
    for (const host of ['b.example', 'c.example', undefined, 'x', 'a.example.b.example']) {
      expect(await resolveDomain(host, deps)).toEqual({
        context: { type: 'platform' },
        brand: PLATFORM_BRAND,
      });
    }
    expect((await resolveDomain('p.example', deps)).context).toEqual({
      type: 'commercial_account',
      commercialAccountId: PARTNER_A,
    });
    // A suspended organization resolves to nothing.
    orgs.set(ORG_A, { ...(orgs.get(ORG_A) as Organization), status: 'suspended' } as Organization);
    expect((await resolveDomain('a.example', deps)).context).toEqual({ type: 'platform' });
  });
});
