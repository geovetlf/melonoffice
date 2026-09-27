import { openWallet } from '@melonoffice/credits';
import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  applyDepartmentStatus,
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  Department,
  DepartmentId,
  DepartmentTypeId,
  InitialBilling,
  IsoTimestamp,
  Organization,
  OrganizationId,
  Specialist,
  SpecialistId,
  SpecialistStatus,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createExecutionService,
  InMemoryExecutionRepository,
  type ExecutionRequest,
} from '@melonoffice/execution';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { decideEligibility } from './eligibility.js';
import { SpecialistError } from './errors.js';
import { canTakeNewWork, SPECIALIST_TRANSITIONS } from './lifecycle.js';
import {
  applySpecialistStatus,
  checkSpecialistWrite,
  checkStoredSpecialist,
  newSpecialist,
  reviseSpecialist,
} from './model.js';
import { InMemorySpecialistRepository } from './repository.js';
import { createSpecialistService } from './service.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const AT = NOW.toISOString() as IsoTimestamp;
const LATER = '2026-09-27T13:00:00.000Z' as IsoTimestamp;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

/** Tenancy needs billing to create an organization; specialists never read it. */
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

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

async function codeOf(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
}

const dep = (org: OrganizationId, type: string): DepartmentId =>
  departmentIdOf(org, type as DepartmentTypeId);

/** A configuration as a caller would describe it: references only, no engines behind them. */
const config = (org: OrganizationId, overrides: Record<string, unknown> = {}) => ({
  departmentId: dep(org, 'research'),
  mainRoleId: 'market_researcher',
  roleVersion: 2,
  purpose: 'Investigate markets for the Director',
  capabilities: ['summarise_sources'],
  skills: [{ id: 'web_research', version: 5 }],
  tools: [{ id: 'web_search', version: 1 }],
  permissions: ['organization.read'],
  policies: { model: { id: 'default_model', version: 1 }, budget: { id: 'small', version: 1 } },
  ...overrides,
});

async function world(options: { roles?: Record<string, readonly string[]> } = {}) {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const repository = new InMemorySpecialistRepository();
  const tenancy = new InMemoryTenancyStore(() => NOW, audit, undefined, departments);
  const provision = (organization: Organization) =>
    provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  const authorization = createAuthorizationService(options.roles as never);
  const service = createSpecialistService({
    repository,
    departments,
    organizations: tenancy,
    authorization,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const department = async (org: OrganizationId, type: string): Promise<Department> =>
    must(await departments.find(org, dep(org, type)));

  /** Creates a specialist the way a future admin route will, then moves it to `status`. */
  async function seed(
    org: OrganizationId,
    status: SpecialistStatus = 'active',
    overrides: Record<string, unknown> = {},
  ): Promise<Specialist> {
    const configuration = config(org, overrides);
    const write = newSpecialist(
      { organizationId: org, displayName: 'María', configuration },
      await department(org, (configuration.departmentId as string).split('_')[1] ?? ''),
      ALICE,
      AT,
    );
    await repository.create(write);
    let current = write.specialist;
    const path: Record<SpecialistStatus, SpecialistStatus[]> = {
      draft: [],
      active: ['active'],
      paused: ['active', 'paused'],
      disabled: ['active', 'disabled'],
      archived: ['archived'],
    };
    for (const to of path[status]) {
      current = await repository.update(org, current.identity.id, (s) =>
        applySpecialistStatus(s, { from: s.status, to }, AT),
      );
    }
    return current;
  }

  const executions = createExecutionService({
    repository: new InMemoryExecutionRepository(audit),
    organizations: tenancy,
    assignments: service.assignments,
    now: () => NOW,
  });

  return {
    audit,
    departments,
    repository,
    tenancy,
    service,
    executions,
    a,
    b,
    orgA,
    orgB,
    tenantA,
    tenantB,
    department,
    seed,
  };
}

describe('specialist = agent (D-28)', () => {
  it('creates a draft at version 1, with its configuration as that version', async () => {
    const { orgA, department } = await world();
    const { specialist, version } = newSpecialist(
      { organizationId: orgA, displayName: ' María ', configuration: config(orgA) },
      await department(orgA, 'research'),
      ALICE,
      AT,
    );
    expect(specialist).toMatchObject({
      identity: { displayName: 'María', createdBy: ALICE, createdAt: AT },
      organizationId: orgA,
      status: 'draft',
      version: 1,
      revision: 1,
    });
    expect(version).toEqual({
      specialistId: specialist.identity.id,
      organizationId: orgA,
      version: 1,
      configuration: specialist.configuration,
      createdAt: AT,
      createdBy: ALICE,
    });
    expect(specialist.configuration).toEqual({
      departmentId: dep(orgA, 'research'),
      mainRoleId: 'market_researcher',
      roleVersion: 2,
      purpose: 'Investigate markets for the Director',
      capabilities: ['summarise_sources'],
      skills: [{ id: 'web_research', version: 5 }],
      tools: [{ id: 'web_search', version: 1 }],
      permissions: ['organization.read'],
      policies: { model: { id: 'default_model', version: 1 }, budget: { id: 'small', version: 1 } },
    });
  });

  it.each([
    [
      'a department of another organization',
      (b: OrganizationId) => ({ departmentId: dep(b, 'research') }),
    ],
    ['a malformed department', () => ({ departmentId: 'research' })],
    ['a permission RBAC does not know', () => ({ permissions: ['specialist.execute'] })],
    ['a policy kind that does not exist', () => ({ policies: { magic: { id: 'x', version: 1 } } })],
    ['a skill without a version', () => ({ skills: [{ id: 'web_research' }] })],
    [
      'a duplicated tool',
      () => ({
        tools: [
          { id: 't', version: 1 },
          { id: 't', version: 2 },
        ],
      }),
    ],
    ['a malformed capability', () => ({ capabilities: ['Do Anything'] })],
    ['no main role', () => ({ mainRoleId: undefined })],
    ['a control character in the purpose', () => ({ purpose: 'a\u0000b' })],
  ])('refuses %s', async (_name, overrides) => {
    const { orgA, orgB, department } = await world();
    const research = await department(orgA, 'research');
    expect(
      await codeOf(() =>
        newSpecialist(
          {
            organizationId: orgA,
            displayName: 'María',
            configuration: config(orgA, overrides(orgB)),
          },
          research,
          ALICE,
          AT,
        ),
      ),
    ).toBe('invalid_specialist');
  });

  it('refuses new specialists in an archived or paused department', async () => {
    const { orgA, department } = await world();
    const research = await department(orgA, 'research');
    for (const to of ['archived', 'paused'] as const) {
      const closed = applyDepartmentStatus(research, { from: 'active', to }, LATER);
      expect(
        await codeOf(() =>
          newSpecialist(
            { organizationId: orgA, displayName: 'María', configuration: config(orgA) },
            closed,
            ALICE,
            AT,
          ),
        ),
      ).toBe('department_not_assignable');
    }
  });
});

describe('specialist lifecycle', () => {
  it('allows exactly the transitions in the table', () => {
    expect(SPECIALIST_TRANSITIONS).toEqual({
      draft: ['active', 'archived'],
      active: ['paused', 'disabled', 'archived'],
      paused: ['active', 'disabled', 'archived'],
      disabled: ['active', 'archived'],
      archived: [],
    });
    expect(
      (['draft', 'active', 'paused', 'disabled', 'archived'] as const).filter(canTakeNewWork),
    ).toEqual(['active']);
  });

  it('changes status without creating a version', async () => {
    const { orgA, seed, repository } = await world();
    const paused = await seed(orgA, 'paused');
    expect(paused).toMatchObject({ status: 'paused', version: 1, revision: 3 });
    expect(await repository.findVersion(orgA, paused.identity.id, 2)).toBeUndefined();
  });

  it('keeps an archived specialist as history: no status or configuration change', async () => {
    const { orgA, seed, department } = await world();
    const archived = await seed(orgA, 'archived');
    for (const to of ['draft', 'active', 'paused', 'disabled', 'archived'] as const) {
      expect(
        await codeOf(() => applySpecialistStatus(archived, { from: 'archived', to }, LATER)),
      ).toBe('specialist_archived');
    }
    expect(
      await codeOf(() =>
        reviseSpecialist(
          archived,
          { fromVersion: 1, configuration: config(orgA, { roleVersion: 3 }) },
          ALICE,
          LATER,
        ),
      ),
    ).toBe('specialist_archived');
    expect((await department(orgA, 'research')).status).toBe('active');
  });

  it('refuses a transition the table does not allow, and a stale status', async () => {
    const { orgA, seed } = await world();
    const draft = await seed(orgA, 'draft');
    expect(
      await codeOf(() => applySpecialistStatus(draft, { from: 'draft', to: 'paused' }, LATER)),
    ).toBe('invalid_specialist_transition');
    expect(
      await codeOf(() => applySpecialistStatus(draft, { from: 'active', to: 'paused' }, LATER)),
    ).toBe('specialist_concurrency_conflict');
  });
});

describe('specialist versioning', () => {
  it('creates a new version for every configuration change and keeps the old one intact', async () => {
    const { orgA, seed, repository, department } = await world();
    const specialist = await seed(orgA);
    const v1 = must(await repository.findVersion(orgA, specialist.identity.id, 1));
    const updated = await repository.update(orgA, specialist.identity.id, (s) =>
      reviseSpecialist(
        s,
        {
          fromVersion: 1,
          configuration: config(orgA, { skills: [{ id: 'web_research', version: 6 }] }),
        },
        BOB,
        LATER,
      ),
    );
    expect(updated).toMatchObject({ version: 2, revision: 3, status: 'active' });
    const v2 = must(await repository.findVersion(orgA, specialist.identity.id, 2));
    expect(v2.configuration.skills).toEqual([{ id: 'web_research', version: 6 }]);
    expect(v2.createdBy).toBe(BOB);
    expect(await repository.findVersion(orgA, specialist.identity.id, 1)).toEqual(v1);
    expect(v1.configuration.skills).toEqual([{ id: 'web_research', version: 5 }]);
    // Moving needs the department it moves to, and that department must be the one named.
    const research = await department(orgA, 'research');
    for (const wrong of [undefined, research]) {
      expect(
        await codeOf(
          repository.update(orgA, specialist.identity.id, (s) =>
            reviseSpecialist(
              s,
              {
                fromVersion: 2,
                configuration: config(orgA, {
                  departmentId: dep(orgA, 'marketing'),
                  skills: [{ id: 'web_research', version: 6 }],
                }),
                ...(wrong === undefined ? {} : { department: wrong }),
              },
              BOB,
              LATER,
            ),
          ),
        ),
      ).toBe('invalid_specialist');
    }
    const marketing = await department(orgA, 'marketing');
    // Moving to another active department is a new version too.
    const movedOk = await repository.update(orgA, specialist.identity.id, (s) =>
      reviseSpecialist(
        s,
        {
          fromVersion: 2,
          configuration: config(orgA, {
            departmentId: marketing.id,
            skills: [{ id: 'web_research', version: 6 }],
          }),
          department: marketing,
        },
        BOB,
        LATER,
      ),
    );
    expect(movedOk).toMatchObject({ version: 3, configuration: { departmentId: marketing.id } });
  });

  it('refuses a change that says nothing new, or is built on an older version', async () => {
    const { orgA, seed } = await world();
    const specialist = await seed(orgA);
    expect(
      await codeOf(() =>
        reviseSpecialist(specialist, { fromVersion: 1, configuration: config(orgA) }, ALICE, LATER),
      ),
    ).toBe('invalid_specialist');
    expect(
      await codeOf(() =>
        reviseSpecialist(
          specialist,
          { fromVersion: 0, configuration: config(orgA, { roleVersion: 3 }) },
          ALICE,
          LATER,
        ),
      ),
    ).toBe('specialist_concurrency_conflict');
  });

  it('refuses to move a specialist into an archived department', async () => {
    const { orgA, seed, department } = await world();
    const specialist = await seed(orgA);
    const finance = applyDepartmentStatus(
      await department(orgA, 'finance'),
      { from: 'active', to: 'archived' },
      LATER,
    );
    expect(
      await codeOf(() =>
        reviseSpecialist(
          specialist,
          {
            fromVersion: 1,
            configuration: config(orgA, { departmentId: finance.id }),
            department: finance,
          },
          ALICE,
          LATER,
        ),
      ),
    ).toBe('department_not_assignable');
  });

  it('never stores a silent configuration change, a skipped version or a rewritten one', async () => {
    const { orgA, seed, repository } = await world();
    const specialist = await seed(orgA);
    const id = specialist.identity.id;
    const changed = { ...specialist.configuration, roleVersion: 9 };
    // A configuration change without a new version.
    expect(
      await codeOf(
        repository.update(orgA, id, (s) => ({
          specialist: { ...s, configuration: changed, revision: s.revision + 1 },
        })),
      ),
    ).toBe('specialist_concurrency_conflict');
    // Jumping from version 1 to 3.
    expect(
      await codeOf(
        repository.update(orgA, id, (s) => ({
          specialist: { ...s, version: 3, configuration: changed, revision: s.revision + 1 },
          version: {
            specialistId: id,
            organizationId: orgA,
            version: 3,
            configuration: changed,
            createdAt: LATER,
            createdBy: ALICE,
          },
        })),
      ),
    ).toBe('specialist_concurrency_conflict');
    // A version whose configuration differs from the specialist's.
    expect(() =>
      checkSpecialistWrite(specialist, {
        specialist: { ...specialist, version: 2, configuration: changed, revision: 4 },
        version: {
          specialistId: id,
          organizationId: orgA,
          version: 2,
          configuration: specialist.configuration,
          createdAt: LATER,
          createdBy: ALICE,
        },
      }),
    ).toThrow(SpecialistError);
    // Re-writing version 1 after it exists.
    repository.put({ ...specialist, version: 0 } as never);
    await expect(repository.find(orgA, id)).rejects.toThrow(SpecialistError);
    repository.put(specialist);
    expect(await repository.findVersion(orgA, id, 1)).toMatchObject({ version: 1 });
  });

  it('refuses stored records that are not valid', async () => {
    const { orgA, seed } = await world();
    const specialist = await seed(orgA);
    for (const bad of [
      { ...specialist, status: 'deleted' },
      { ...specialist, version: 0 },
      { ...specialist, identity: { ...specialist.identity, id: 'x' } },
      { ...specialist, configuration: { ...specialist.configuration, permissions: ['all'] } },
    ]) {
      expect(() => checkStoredSpecialist(bad as Specialist)).toThrow(SpecialistError);
    }
  });
});

describe('specialist service: tenancy', () => {
  it("lists and reads only the tenant's own specialists", async () => {
    const { orgA, orgB, seed, service, tenantA, tenantB } = await world();
    const mine = await seed(orgA);
    const theirs = await seed(orgB);
    expect((await service.list(tenantA)).map((s) => s.identity.id)).toEqual([mine.identity.id]);
    expect((await service.get(tenantA, mine.identity.id)).identity.id).toBe(mine.identity.id);
    for (const id of [theirs.identity.id, '99999999-9999-4999-8999-999999999999', 'x', '']) {
      expect(await codeOf(service.get(tenantA, id))).toBe('specialist_not_found');
    }
    expect(await codeOf(service.getVersion(tenantB, mine.identity.id, 1))).toBe(
      'specialist_not_found',
    );
    expect((await service.getVersion(tenantA, mine.identity.id, 1)).version).toBe(1);
    expect(await codeOf(service.getVersion(tenantA, mine.identity.id, 2))).toBe(
      'specialist_not_found',
    );
  });

  it('refuses a forged or unresolved tenant, and a suspended organization', async () => {
    const { orgA, seed, service, tenantA, tenantB, tenancy, a } = await world();
    const mine = await seed(orgA);
    const forged = { ...tenantB, organizationId: orgA } as never;
    expect(await codeOf(service.get(forged, mine.identity.id))).toBe('unresolved_tenant');
    expect(await codeOf(service.list(forged))).toBe('unresolved_tenant');
    tenancy.put({ ...a.organization, status: 'suspended' });
    expect(await codeOf(service.list(tenantA))).toBe('organization_inactive');
    expect(
      await codeOf(
        service.eligibility(tenantA, {
          specialistId: mine.identity.id,
          departmentId: mine.configuration.departmentId,
        }),
      ),
    ).toBe('organization_inactive');
  });
});

describe('eligibility', () => {
  const ask = (s: Specialist, overrides: { departmentId?: string; version?: number } = {}) => ({
    specialistId: s.identity.id,
    departmentId: s.configuration.departmentId,
    ...overrides,
  });

  it('accepts an active specialist in its active department, with the versions it names', async () => {
    const { orgA, seed, service, tenantA } = await world();
    const s = await seed(orgA);
    expect(await service.eligibility(tenantA, ask(s, { version: 1 }))).toEqual({
      eligible: true,
      assignment: {
        specialistId: s.identity.id,
        specialistVersion: 1,
        departmentId: dep(orgA, 'research'),
      },
      components: [
        { kind: 'specialist', id: s.identity.id, version: '1' },
        { kind: 'role', id: 'market_researcher', version: '2' },
        { kind: 'skill', id: 'web_research', version: '5' },
        { kind: 'tool', id: 'web_search', version: '1' },
        { kind: 'model_policy', id: 'default_model', version: '1' },
        { kind: 'budget_policy', id: 'small', version: '1' },
      ],
    });
  });

  it.each(['draft', 'paused', 'disabled', 'archived'] as const)(
    'refuses a %s specialist',
    async (status) => {
      const { orgA, seed, service, tenantA } = await world();
      const s = await seed(orgA, status);
      expect(await service.eligibility(tenantA, ask(s))).toEqual({
        eligible: false,
        reason: 'specialist_not_active',
      });
    },
  );

  it("refuses another organization's specialist exactly like a missing one", async () => {
    const { orgB, seed, service, tenantA } = await world();
    const theirs = await seed(orgB);
    for (const specialistId of [theirs.identity.id, '99999999-9999-4999-8999-999999999999', 'x']) {
      expect(await service.eligibility(tenantA, { ...ask(theirs), specialistId })).toEqual({
        eligible: false,
        reason: 'specialist_not_found',
      });
    }
  });

  it('refuses a specialist asked for in another department, or a forged department id', async () => {
    const { orgA, orgB, seed, service, tenantA } = await world();
    const s = await seed(orgA);
    for (const departmentId of [dep(orgA, 'finance'), dep(orgB, 'research'), 'research', '']) {
      expect(await service.eligibility(tenantA, ask(s, { departmentId }))).toEqual({
        eligible: false,
        reason: 'department_mismatch',
      });
    }
  });

  it('refuses a specialist whose department is paused or archived', async () => {
    const { orgA, seed, service, tenantA, departments, department } = await world();
    const s = await seed(orgA);
    for (const to of ['paused', 'archived'] as const) {
      departments.put(
        applyDepartmentStatus(await department(orgA, 'research'), { from: 'active', to }, LATER),
      );
      expect(await service.eligibility(tenantA, ask(s))).toEqual({
        eligible: false,
        reason: 'department_not_active',
      });
      departments.put({ ...(await department(orgA, 'research')), status: 'active' });
    }
  });

  it('refuses a version that is not the current one, or is not stored', async () => {
    const { orgA, seed, service, tenantA, repository } = await world();
    const s = await seed(orgA);
    for (const version of [2, 0]) {
      expect(await service.eligibility(tenantA, ask(s, { version }))).toEqual({
        eligible: false,
        reason: 'version_not_current',
      });
    }
    // The specialist claims version 2, which was never stored.
    repository.put({ ...s, version: 2 });
    expect(await service.eligibility(tenantA, ask(s))).toEqual({
      eligible: false,
      reason: 'version_not_found',
    });
  });

  it('refuses a specialist whose work needs a permission the user does not hold (D-25)', async () => {
    // A test role catalogue, not a production role: owner here lacks billing.read.
    const { orgA, seed, service, tenantA } = await world({
      roles: { owner: ['organization.read', 'execution.read'] },
    });
    const s = await seed(orgA, 'active', { permissions: ['organization.read', 'billing.read'] });
    expect(await service.eligibility(tenantA, ask(s))).toEqual({
      eligible: false,
      reason: 'permission_not_held',
    });
    const ok = await seed(orgA, 'active', { permissions: ['organization.read'] });
    expect((await service.eligibility(tenantA, ask(ok))).eligible).toBe(true);
  });

  it('decides from the facts alone, with no lookup and no AI', () => {
    expect(
      decideEligibility({
        request: { specialistId: 'x', departmentId: 'y' },
        specialist: undefined,
        version: undefined,
        department: undefined,
        permissions: new Set(),
      }),
    ).toEqual({ eligible: false, reason: 'specialist_not_found' });
  });
});

describe('execution integration', () => {
  const request = (
    s: Specialist,
    components: readonly { kind: string; id: string; version: string }[],
    overrides: Partial<ExecutionRequest> = {},
  ): ExecutionRequest => ({
    mode: 'delegate',
    input: { type: 'task', id: 'task-1' },
    specialistId: s.identity.id,
    specialistVersion: s.version,
    departmentId: s.configuration.departmentId,
    versionSnapshot: { schemaVersion: 1, components },
    nodes: [
      {
        id: 'work',
        type: 'agent',
        label: 'Work',
        owner: { kind: 'specialist', id: s.identity.id, version: String(s.version) },
      },
    ],
    ...overrides,
  });

  it('rebuilds organization → department → specialist → version → execution, with no AI', async () => {
    const { orgA, seed, service, executions, tenantA, departments } = await world();
    const s = await seed(orgA);
    const decision = await service.eligibility(tenantA, {
      specialistId: s.identity.id,
      departmentId: s.configuration.departmentId,
    });
    if (!decision.eligible) throw new Error('expected an eligible specialist');
    const execution = await executions.create(tenantA, {
      ...request(s, decision.components),
      ...decision.assignment,
    });
    expect(execution).toMatchObject({
      status: 'pending',
      specialistId: s.identity.id,
      specialistVersion: 1,
      departmentId: dep(orgA, 'research'),
    });
    // Who should run it, rebuilt from stored records only.
    const stored = await executions.get(tenantA, execution.id);
    const department = must(await departments.find(orgA, must(stored.departmentId)));
    const specialist = await service.get(tenantA, must(stored.specialistId));
    const version = await service.getVersion(
      tenantA,
      specialist.identity.id,
      must(stored.specialistVersion),
    );
    expect({
      organization: stored.organizationId,
      department: department.origin.kind === 'catalog' ? department.origin.typeId : undefined,
      specialist: specialist.identity.displayName,
      version: version.version,
      role: `${version.configuration.mainRoleId}@${version.configuration.roleVersion}`,
      snapshot: stored.versionSnapshot.components.find((c) => c.kind === 'specialist')?.version,
    }).toEqual({
      organization: orgA,
      department: 'research',
      specialist: 'María',
      version: 1,
      role: 'market_researcher@2',
      snapshot: '1',
    });
  });

  it('keeps meaning the version it recorded after the specialist changes', async () => {
    const { orgA, seed, service, executions, tenantA, repository } = await world();
    const s = await seed(orgA);
    const execution = await executions.create(
      tenantA,
      request(s, [{ kind: 'specialist', id: s.identity.id, version: '1' }]),
    );
    await repository.update(orgA, s.identity.id, (current) =>
      reviseSpecialist(
        current,
        { fromVersion: 1, configuration: config(orgA, { roleVersion: 3 }) },
        ALICE,
        LATER,
      ),
    );
    const stored = await executions.get(tenantA, execution.id);
    const used = await service.getVersion(tenantA, s.identity.id, must(stored.specialistVersion));
    expect(used.configuration.roleVersion).toBe(2);
    expect((await service.get(tenantA, s.identity.id)).version).toBe(2);
  });

  it('refuses to create an execution for a specialist that is not eligible', async () => {
    const { orgA, orgB, seed, executions, tenantA } = await world();
    const paused = await seed(orgA, 'paused');
    const theirs = await seed(orgB);
    for (const s of [paused, theirs]) {
      expect(
        await codeOf(
          executions.create(
            tenantA,
            request(s, [{ kind: 'specialist', id: s.identity.id, version: '1' }]),
          ),
        ),
      ).toBe('specialist_not_eligible');
    }
  });

  it('refuses an assignment that is incomplete or disagrees with the snapshot', async () => {
    const { orgA, seed, executions, tenantA } = await world();
    const s = await seed(orgA);
    const snapshot = [{ kind: 'specialist', id: s.identity.id, version: '1' }];
    const cases: Record<string, unknown>[] = [
      { specialistVersion: undefined },
      { departmentId: undefined },
      { versionSnapshot: { schemaVersion: 1, components: [] } },
      {
        versionSnapshot: {
          schemaVersion: 1,
          components: [{ kind: 'specialist', id: s.identity.id, version: '2' }],
        },
      },
    ];
    for (const overrides of cases) {
      const { specialistVersion, departmentId, ...rest } = {
        ...request(s, snapshot),
        ...overrides,
      };
      const asked = {
        ...rest,
        ...(specialistVersion === undefined ? {} : { specialistVersion }),
        ...(departmentId === undefined ? {} : { departmentId }),
      };
      expect(await codeOf(executions.create(tenantA, asked as ExecutionRequest))).toBe(
        'invalid_execution',
      );
    }
  });

  it('refuses any assignment when no guard is configured', async () => {
    const { orgA, seed, tenancy, tenantA, audit } = await world();
    const s = await seed(orgA);
    const unguarded = createExecutionService({
      repository: new InMemoryExecutionRepository(audit),
      organizations: tenancy,
    });
    expect(
      await codeOf(
        unguarded.create(
          tenantA,
          request(s, [{ kind: 'specialist', id: s.identity.id, version: '1' }]),
        ),
      ),
    ).toBe('specialist_not_eligible');
  });
});

// Keep the fixtures honest: the specialist ids they create are real UUIDs.
it('creates specialist ids that are UUIDs', async () => {
  const { orgA, seed } = await world();
  const { identity } = await seed(orgA);
  expect(identity.id as SpecialistId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
