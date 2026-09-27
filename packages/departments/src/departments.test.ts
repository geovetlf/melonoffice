import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  Department,
  DepartmentType,
  DepartmentTypeId,
  InitialBilling,
  IsoTimestamp,
  MessageKey,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDepartmentCatalogue, DEFAULT_DEPARTMENT_CATALOGUE } from './catalogue.js';
import { DepartmentError } from './errors.js';
import {
  acceptsAssignments,
  applyDepartmentStatus,
  checkStoredDepartment,
  DEPARTMENT_TRANSITIONS,
  departmentIdOf,
  isDepartmentId,
  organizationOfDepartmentId,
  provisionDepartments,
} from './model.js';
import { InMemoryDepartmentRepository } from './repository.js';
import { createDepartmentService } from './service.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const LATER = '2026-09-27T13:00:00.000Z' as IsoTimestamp;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

/** Tenancy needs billing to create an organization; departments never read it. */
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

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const DEPARTMENTS = (organization: Organization) =>
  provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DepartmentError) return error.code;
    throw error;
  }
  return 'accepted';
}

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

async function world() {
  const repository = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(() => NOW, undefined, undefined, repository);
  const options = { billing: BILLING, departments: DEPARTMENTS };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
  const service = createDepartmentService({ repository, organizations: tenancy });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  return { repository, tenancy, service, a, b, orgA, orgB, tenantA, tenantB };
}

describe('department catalogue (D-11)', () => {
  it('holds the seven approved departments, with Finanzas apart from Consejo y Dirección', () => {
    expect(DEFAULT_DEPARTMENT_CATALOGUE.types.map((t) => t.id)).toEqual([
      'leadership',
      'operations',
      'sales',
      'marketing',
      'design_video',
      'research',
      'finance',
    ]);
    const leadership = must(DEFAULT_DEPARTMENT_CATALOGUE.find('leadership'));
    const finance = must(DEFAULT_DEPARTMENT_CATALOGUE.find('finance'));
    expect(leadership.nameKey).toBe('department.leadership.name');
    expect(finance.nameKey).toBe('department.finance.name');
    expect(leadership.nameKey).not.toBe(finance.nameKey);
    // GIA is not a department, and Sales is part of Comercial y Ventas.
    expect(DEFAULT_DEPARTMENT_CATALOGUE.find('gia')).toBeUndefined();
    expect(DEFAULT_DEPARTMENT_CATALOGUE.types.filter((t) => t.id === 'sales')).toHaveLength(1);
  });

  it.each(['en', 'es'])('has every name in the %s message catalogue (D-17)', (locale) => {
    const url = new URL(`../../i18n/src/locales/${locale}.json`, import.meta.url);
    const messages = JSON.parse(readFileSync(url, 'utf8')) as Record<string, string>;
    for (const type of DEFAULT_DEPARTMENT_CATALOGUE.types) {
      expect(messages[type.nameKey], type.nameKey).toBeTruthy();
      expect(messages[must(type.shortNameKey)], type.shortNameKey).toBeTruthy();
    }
    if (locale === 'es') {
      expect(messages['department.leadership.name']).toBe('Consejo y Dirección');
      expect(messages['department.finance.name']).toBe('Finanzas');
    }
  });

  it('takes new department types as data, with no code change', () => {
    const legal: DepartmentType = {
      id: 'legal' as DepartmentTypeId,
      nameKey: 'department.legal.name' as MessageKey,
      version: 1,
    };
    const extended = createDepartmentCatalogue([...DEFAULT_DEPARTMENT_CATALOGUE.types, legal]);
    expect(extended.types).toHaveLength(8);
    expect(extended.find('legal')).toEqual(legal);
    const organization = { id: '33333333-3333-4333-8333-333333333333', createdAt: LATER };
    expect(provisionDepartments(organization as never, extended).map((d) => d.id)).toContain(
      `${organization.id}_legal`,
    );
  });

  it('refuses duplicate or malformed types and versions', () => {
    const base = must(DEFAULT_DEPARTMENT_CATALOGUE.types[0]);
    expect(() => createDepartmentCatalogue([base, base])).toThrow(/duplicate/);
    expect(() => createDepartmentCatalogue([{ ...base, id: 'Bad Id' as never }])).toThrow();
    expect(() => createDepartmentCatalogue([{ ...base, version: 0 }])).toThrow();
  });
});

describe('department ids', () => {
  const org = '33333333-3333-4333-8333-333333333333' as OrganizationId;

  it('derives a catalogue department id from its organization and type', () => {
    const id = departmentIdOf(org, 'finance' as DepartmentTypeId);
    expect(id).toBe(`${org}_finance`);
    expect(organizationOfDepartmentId(id)).toBe(org);
    expect(isDepartmentId(id)).toBe(true);
  });

  it.each([
    '',
    'finance',
    `${org}`,
    `${org}_`,
    `${org}_Finance`,
    `${org}_finance/../x`,
    `not-a-uuid_finance`,
    42,
    undefined,
  ])('does not take %j for a department id', (value) => {
    expect(isDepartmentId(value)).toBe(false);
    expect(organizationOfDepartmentId(value)).toBeUndefined();
  });
});

describe('provisioning with the organization', () => {
  it('creates one active department per catalogue type, in the same step', async () => {
    const { repository, orgA, a } = await world();
    const departments = await repository.list(orgA);
    expect(departments).toHaveLength(7);
    expect(a.departments).toHaveLength(7);
    for (const d of departments) {
      expect(d).toMatchObject({
        organizationId: orgA,
        status: 'active',
        revision: 1,
        createdAt: a.organization.createdAt,
      });
      expect(d.origin.kind).toBe('catalog');
      expect(d.purpose).toBeUndefined();
      expect(d.description).toBeUndefined();
    }
  });

  it('gives each organization its own departments', async () => {
    const { repository, orgA, orgB } = await world();
    const a = (await repository.list(orgA)).map((d) => d.id);
    const b = (await repository.list(orgB)).map((d) => d.id);
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it('is deterministic, so provisioning twice gives the same ids and nothing new', () => {
    const organization = { id: '33333333-3333-4333-8333-333333333333', createdAt: LATER };
    const first = provisionDepartments(organization as never, DEFAULT_DEPARTMENT_CATALOGUE);
    const second = provisionDepartments(organization as never, DEFAULT_DEPARTMENT_CATALOGUE);
    expect(second).toEqual(first);
    const repository = new InMemoryDepartmentRepository();
    repository.openNow(first);
    expect(() => repository.openNow(second)).toThrow(/already exists/);
  });

  it('creates nothing when the departments do not belong to the new organization', async () => {
    const repository = new InMemoryDepartmentRepository();
    const tenancy = new InMemoryTenancyStore(() => NOW, undefined, undefined, repository);
    const foreign = (organization: Organization): readonly Department[] =>
      DEPARTMENTS(organization).map((d) => ({
        ...d,
        organizationId: '33333333-3333-4333-8333-333333333333' as OrganizationId,
      }));
    await expect(
      createOrganization(as(ALICE), { name: 'A' }, tenancy, {
        billing: BILLING,
        departments: foreign,
      }),
    ).rejects.toThrow(/do not belong/);
    expect(await tenancy.membershipsOfUser(ALICE)).toEqual([]);
  });

  it('creates no departments when none are asked for', async () => {
    const repository = new InMemoryDepartmentRepository();
    const tenancy = new InMemoryTenancyStore(() => NOW, undefined, undefined, repository);
    const { organization, departments } = await createOrganization(
      as(ALICE),
      { name: 'A' },
      tenancy,
      {
        billing: BILLING,
      },
    );
    expect(departments).toEqual([]);
    expect(await repository.list(organization.id)).toEqual([]);
  });
});

describe('department lifecycle', () => {
  const department = (): Department =>
    must(
      provisionDepartments(
        {
          id: '33333333-3333-4333-8333-333333333333' as OrganizationId,
          createdAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
        },
        DEFAULT_DEPARTMENT_CATALOGUE,
      )[0],
    );

  it('allows exactly the transitions in the table', () => {
    expect(DEPARTMENT_TRANSITIONS).toEqual({
      active: ['paused', 'archived'],
      paused: ['active', 'archived'],
      archived: [],
    });
    const paused = applyDepartmentStatus(department(), { from: 'active', to: 'paused' }, LATER);
    expect(paused).toMatchObject({ status: 'paused', revision: 2, updatedAt: LATER });
    const active = applyDepartmentStatus(paused, { from: 'paused', to: 'active' }, LATER);
    expect(active.status).toBe('active');
  });

  it('keeps an archived department as history: nothing moves it again', () => {
    const archived = applyDepartmentStatus(department(), { from: 'active', to: 'archived' }, LATER);
    for (const to of ['active', 'paused', 'archived'] as const) {
      expect(() => applyDepartmentStatus(archived, { from: 'archived', to }, LATER)).toThrow(
        expect.objectContaining({ code: 'invalid_department_transition' }),
      );
    }
  });

  it('refuses a change built on a status the caller did not see', () => {
    expect(() =>
      applyDepartmentStatus(department(), { from: 'paused', to: 'active' }, LATER),
    ).toThrow(expect.objectContaining({ code: 'department_concurrency_conflict' }));
  });

  it('takes new assignments only while active', () => {
    const d = department();
    expect(acceptsAssignments(d)).toBe(true);
    expect(acceptsAssignments({ ...d, status: 'paused' })).toBe(false);
    expect(acceptsAssignments({ ...d, status: 'archived' })).toBe(false);
  });

  it('refuses stored records that are not valid, never repairing them', () => {
    const d = department();
    const other = '44444444-4444-4444-8444-444444444444' as OrganizationId;
    for (const bad of [
      { ...d, status: 'deleted' },
      { ...d, organizationId: other },
      { ...d, id: `${d.organizationId}_finance` },
      { ...d, origin: { kind: 'catalog', typeId: 'Bad', typeVersion: 1 } },
      { ...d, origin: { kind: 'other' } },
      { ...d, purpose: '' },
      { ...d, revision: 0 },
    ]) {
      expect(() => checkStoredDepartment(bad as Department)).toThrow(DepartmentError);
    }
    expect(checkStoredDepartment(d)).toBe(d);
  });
});

describe('department service: tenancy', () => {
  it("lists only the tenant's own departments", async () => {
    const { service, tenantA, orgA } = await world();
    const departments = await service.list(tenantA);
    expect(departments).toHaveLength(7);
    expect(departments.every((d) => d.organizationId === orgA)).toBe(true);
  });

  it("answers another organization's department exactly like a missing one", async () => {
    const { service, tenantA, tenantB, orgA, orgB } = await world();
    // A's finance department, an id A could have, and malformed ids: all the same answer to B.
    const own = departmentIdOf(orgA, 'finance' as DepartmentTypeId);
    expect((await service.get(tenantA, own)).id).toBe(own);
    for (const id of [
      own,
      departmentIdOf(orgA, 'legal' as DepartmentTypeId),
      `${orgB}_nothing`,
      'not-an-id',
      '',
    ]) {
      expect(await codeOf(service.get(tenantB, id))).toBe('department_not_found');
    }
  });

  it('refuses a context that was not resolved by tenancy', async () => {
    const { service, tenantA, tenantB } = await world();
    const forged = { ...tenantB, organizationId: tenantA.organizationId } as TenantContext;
    expect(await codeOf(service.list(forged))).toBe('unresolved_tenant');
    expect(await codeOf(service.get(forged, `${tenantA.organizationId}_finance`))).toBe(
      'unresolved_tenant',
    );
  });

  it('refuses an organization suspended after the tenant was resolved', async () => {
    const { service, tenancy, tenantA, a } = await world();
    tenancy.put({ ...a.organization, status: 'suspended' });
    expect(await codeOf(service.list(tenantA))).toBe('organization_inactive');
  });

  it('refuses a stored department of another organization under a forged id', async () => {
    const { repository, service, tenantA, orgA, orgB } = await world();
    const theirs = must((await repository.list(orgB))[0]);
    // A record claiming organization A under B's id is refused, never shown to A.
    repository.put({ ...theirs, organizationId: orgA });
    expect(await codeOf(service.get(tenantA, theirs.id))).toBe('department_not_found');
    await expect(repository.list(orgA)).rejects.toThrow(DepartmentError);
  });
});
