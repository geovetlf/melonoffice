import { DEFAULT_DEPARTMENT_CATALOGUE, departmentIdOf } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistStatus,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService } from '@melonoffice/execution';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  newSpecialist,
  reviseSpecialist,
} from '@melonoffice/specialists';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
const LATER = '2026-09-27T13:00:00.000Z' as IsoTimestamp;
const MISSING = '99999999-9999-4999-8999-999999999999';

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
}

const dep = (org: OrganizationId, type: string) => departmentIdOf(org, type as DepartmentTypeId);

describe.each(STORES)('departments and specialists with storage in %s', (_name, createStores) => {
  async function setup(options: { authorization?: AuthorizationService } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(stores, options.authorization);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
    const create = async (token: string, name: string) =>
      (
        (await (
          await ctx.app.request(
            '/v1/organizations',
            ctx.as(token, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }),
          )
        ).json()) as { organization: { id: string } }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'A');
    const orgB = await create('token-bob', 'B');
    const get = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    /** Creates a specialist the way a future admin route will: server side, never by a client. */
    async function seed(
      org: OrganizationId,
      status: SpecialistStatus = 'active',
      type = 'research',
    ): Promise<Specialist> {
      const department = must(await stores.departments.find(org, dep(org, type)));
      const write = newSpecialist(
        {
          organizationId: org,
          displayName: 'María',
          configuration: {
            departmentId: department.id,
            mainRoleId: 'market_researcher',
            roleVersion: 2,
            purpose: 'Investigate markets',
            capabilities: ['summarise_sources'],
            skills: [{ id: 'web_research', version: 5 }],
            tools: [{ id: 'secret_tool', version: 1 }],
            permissions: ['organization.read'],
            policies: { budget: { id: 'hidden_budget', version: 1 } },
          },
        },
        department,
        aliceId,
        AT,
      );
      await stores.specialists.create(write);
      let current = write.specialist;
      for (const to of status === 'draft'
        ? []
        : status === 'active'
          ? ['active']
          : ['active', status]) {
        current = await stores.specialists.update(org, current.identity.id, (s) =>
          applySpecialistStatus(s, { from: s.status, to: to as SpecialistStatus }, AT),
        );
      }
      return current;
    }
    const tenantOf = (userId: UserId, org: OrganizationId) =>
      resolveTenant({ actor: 'user', userId, emailVerified: true }, org, stores.tenancy);
    return { ...ctx, stores, aliceId, bobId, orgA, orgB, get, seed, tenantOf };
  }

  describe('provisioning', () => {
    it('gives a new organization the six catalogue departments (ADR-0047), stored with it, and no retired one', async () => {
      const { get, orgA } = await setup();
      const { status, body } = await get('token-alice', `/v1/organizations/${orgA}/departments`);
      expect(status).toBe(200);
      const departments = body.departments as Record<string, unknown>[];
      expect(departments.map((d) => d.typeId).sort()).toEqual(
        DEFAULT_DEPARTMENT_CATALOGUE.types.map((t) => t.id).sort(),
      );
      expect(departments).toHaveLength(6);
      expect(departments.some((d) => d.typeId === 'design_video')).toBe(false);
      expect(departments.find((d) => d.typeId === 'finance')).toEqual({
        id: dep(orgA, 'finance'),
        origin: 'catalog',
        typeId: 'finance',
        nameKey: 'department.finance.name',
        shortNameKey: 'department.finance.short',
        name: null,
        status: 'active',
        purpose: null,
        description: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      // Consejo y Dirección and Finanzas are two departments, never one.
      const leadership = departments.find((d) => d.typeId === 'leadership');
      expect(leadership?.id).not.toBe(dep(orgA, 'finance'));
      expect(JSON.stringify(body)).not.toMatch(/revision|organizationId/);
    });
  });

  describe('tenant isolation', () => {
    it("answers another organization's department or specialist exactly like a missing one", async () => {
      const { get, orgA, orgB, seed } = await setup();
      const theirs = await seed(orgB);
      const departments = [dep(orgB, 'finance'), dep(orgA, 'legal'), MISSING, 'x', '%00'];
      for (const id of departments) {
        expect(await get('token-alice', `/v1/organizations/${orgA}/departments/${id}`)).toEqual({
          status: 404,
          body: { error: 'department_not_found' },
        });
      }
      for (const id of [theirs.identity.id, MISSING, 'x']) {
        expect(await get('token-alice', `/v1/organizations/${orgA}/specialists/${id}`)).toEqual({
          status: 404,
          body: { error: 'specialist_not_found' },
        });
      }
      const list = await get('token-alice', `/v1/organizations/${orgA}/specialists`);
      expect(list).toEqual({ status: 200, body: { specialists: [] } });
    });

    it("refuses another organization's path, whatever the body, query or headers say", async () => {
      const { get, orgA, orgB } = await setup();
      for (const path of ['departments', 'specialists']) {
        expect(await get('token-alice', `/v1/organizations/${orgB}/${path}`)).toEqual({
          status: 403,
          body: { error: 'organization_forbidden' },
        });
        const forged = await get(
          'token-alice',
          `/v1/organizations/${orgA}/${path}?organizationId=${orgB}`,
          { headers: { 'x-organization-id': orgB } },
        );
        expect(forged.status).toBe(200);
        expect(JSON.stringify(forged.body)).not.toContain(orgB);
      }
    });

    it('refuses a request without a valid token', async () => {
      const { app, orgA } = await setup();
      const response = await app.request(`/v1/organizations/${orgA}/specialists`);
      expect(response.status).toBe(401);
    });
  });

  describe('RBAC', () => {
    it('refuses a member whose role lacks the read permission, and audits it', async () => {
      // A test role catalogue, not a production role.
      const { get, orgA, stores } = await setup({
        authorization: createAuthorizationService({ owner: ['organization.read'] }),
      });
      for (const [path, permission] of [
        ['departments', 'department.read'],
        ['specialists', 'specialist.read'],
      ] as const) {
        expect(await get('token-alice', `/v1/organizations/${orgA}/${path}`)).toEqual({
          status: 403,
          body: { error: 'permission_denied' },
        });
        expect(await stores.auditEvents()).toContainEqual(
          expect.objectContaining({
            action: 'authorization.check',
            permission,
            reason: 'permission_denied',
          }),
        );
      }
    });
  });

  describe('specialists', () => {
    it('shows a safe view: no tools, permissions, policies, creator or revision', async () => {
      const { get, orgA, seed } = await setup();
      const s = await seed(orgA);
      const { status, body } = await get(
        'token-alice',
        `/v1/organizations/${orgA}/specialists/${s.identity.id}`,
      );
      expect(status).toBe(200);
      expect(body).toEqual({
        id: s.identity.id,
        departmentId: dep(orgA, 'research'),
        displayName: 'María',
        avatar: null,
        status: 'active',
        version: 1,
        role: { id: 'market_researcher', version: 2 },
        purpose: 'Investigate markets',
        description: null,
        capabilities: ['summarise_sources'],
        skills: [{ id: 'web_research', version: 5 }],
        createdAt: AT,
        updatedAt: AT,
      });
      expect(JSON.stringify(body)).not.toMatch(
        /secret_tool|hidden_budget|organization\.read|permissions|policies|tools|createdBy|revision/,
      );
      const list = await get('token-alice', `/v1/organizations/${orgA}/specialists`);
      expect(list.body).toEqual({ specialists: [body] });
    });

    it('lists specialists in every status, so history stays visible', async () => {
      const { get, orgA, seed } = await setup();
      for (const status of ['draft', 'paused', 'disabled', 'archived'] as const)
        await seed(orgA, status);
      const { body } = await get('token-alice', `/v1/organizations/${orgA}/specialists`);
      expect((body.specialists as { status: string }[]).map((s) => s.status).sort()).toEqual([
        'archived',
        'disabled',
        'draft',
        'paused',
      ]);
    });

    // Creating and changing an agent is `specialist.manage` (ADR-0062, agents.test.ts).
    it('has no route that replaces, deletes or runs a specialist', async () => {
      const { app, as, orgA, seed } = await setup();
      const s = await seed(orgA);
      const base = `/v1/organizations/${orgA}/specialists`;
      const attempts: [string, string][] = [
        ['PUT', `${base}/${s.identity.id}`],
        ['DELETE', `${base}/${s.identity.id}`],
        ['POST', `${base}/${s.identity.id}/execute`],
        ['POST', `${base}/${s.identity.id}/run`],
        ['POST', `/v1/organizations/${orgA}/departments`],
        ['DELETE', `/v1/organizations/${orgA}/departments/${dep(orgA, 'finance')}`],
        ['POST', `/v1/organizations/${orgA}/executions`],
      ];
      for (const [method, path] of attempts) {
        const response = await app.request(path, as('token-alice', { method }));
        expect([404, 405], `${method} ${path}`).toContain(response.status);
      }
    });
  });

  describe('persistence', () => {
    it('writes each version once and never changes it', async () => {
      const { stores, orgA, seed } = await setup();
      const s = await seed(orgA);
      const v1 = must(await stores.specialists.findVersion(orgA, s.identity.id, 1));
      await stores.specialists.update(orgA, s.identity.id, (current) =>
        reviseSpecialist(
          current,
          {
            fromVersion: 1,
            configuration: { ...current.configuration, roleVersion: 3 },
          },
          current.identity.createdBy,
          LATER,
        ),
      );
      expect(await stores.specialists.findVersion(orgA, s.identity.id, 1)).toEqual(v1);
      expect(
        (await stores.specialists.findVersion(orgA, s.identity.id, 2))?.configuration.roleVersion,
      ).toBe(3);
      // Re-creating version 2 is refused: the stored version stays as it was.
      expect(
        await codeOf(
          stores.specialists.update(orgA, s.identity.id, (current) => ({
            specialist: { ...current, revision: current.revision + 1 },
            version: {
              specialistId: s.identity.id,
              organizationId: orgA,
              version: 2,
              configuration: current.configuration,
              createdAt: LATER,
              createdBy: current.identity.createdBy,
            },
          })),
        ),
      ).toBe('specialist_concurrency_conflict');
    });

    it('never lets one organization read or change another organization’s specialist', async () => {
      const { stores, orgA, orgB, seed } = await setup();
      const s = await seed(orgA);
      expect(await stores.specialists.find(orgB, s.identity.id)).toBeUndefined();
      expect(await stores.specialists.findVersion(orgB, s.identity.id, 1)).toBeUndefined();
      expect(await stores.specialists.list(orgB)).toEqual([]);
      expect(
        await codeOf(
          stores.specialists.update(orgB, s.identity.id, (current) =>
            applySpecialistStatus(current, { from: 'active', to: 'paused' }, LATER),
          ),
        ),
      ).toBe('specialist_not_found');
      expect((await stores.specialists.find(orgA, s.identity.id))?.status).toBe('active');
    });

    it('lets exactly one of two concurrent status changes win', async () => {
      const { stores, orgA, seed } = await setup();
      const s = await seed(orgA);
      const results = await Promise.all(
        (['paused', 'disabled'] as const).map((to) =>
          codeOf(
            stores.specialists.update(orgA, s.identity.id, (current) =>
              applySpecialistStatus(current, { from: 'active', to }, LATER),
            ),
          ),
        ),
      );
      expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
      expect(results.filter((r) => r === 'specialist_concurrency_conflict')).toHaveLength(1);
      expect((await stores.specialists.find(orgA, s.identity.id))?.revision).toBe(3);
    });

    it('refuses a malformed stored department or specialist instead of showing it', async () => {
      const { stores, get, orgA, seed } = await setup();
      const s = await seed(orgA);
      await stores.putStructure({ ...s, status: 'deleted' as never });
      expect(
        (await get('token-alice', `/v1/organizations/${orgA}/specialists/${s.identity.id}`)).status,
      ).toBe(500);
      const finance = must(await stores.departments.find(orgA, dep(orgA, 'finance')));
      await stores.putStructure({ ...finance, status: 'gone' as never });
      expect((await get('token-alice', `/v1/organizations/${orgA}/departments`)).status).toBe(500);
    });
  });

  describe('execution', () => {
    it('records department → specialist → version on an execution and shows it', async () => {
      const { stores, get, orgA, aliceId, seed, tenantOf } = await setup();
      const s = await seed(orgA);
      const tenant = await tenantOf(aliceId, orgA);
      const specialists = createSpecialistService({
        repository: stores.specialists,
        departments: stores.departments,
        organizations: stores.tenancy,
        authorization: createAuthorizationService(),
      });
      const executions = createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
      });
      const decision = await specialists.eligibility(tenant, {
        specialistId: s.identity.id,
        departmentId: dep(orgA, 'research'),
      });
      if (!decision.eligible) throw new Error('expected an eligible specialist');
      const execution = await executions.create(tenant, {
        mode: 'delegate',
        input: { type: 'task', id: 'task-7' },
        ...decision.assignment,
        versionSnapshot: { schemaVersion: 1, components: decision.components },
      });
      const { status, body } = await get(
        'token-alice',
        `/v1/organizations/${orgA}/executions/${execution.id}`,
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({
        specialistId: s.identity.id,
        specialistVersion: 1,
        departmentId: dep(orgA, 'research'),
      });
      expect((body.versionSnapshot as { components: unknown[] }).components).toContainEqual({
        kind: 'specialist',
        id: s.identity.id,
        version: '1',
      });
      // A paused specialist gets no new execution; the recorded one keeps its assignment.
      await stores.specialists.update(orgA, s.identity.id, (current) =>
        applySpecialistStatus(current, { from: 'active', to: 'paused' }, LATER),
      );
      expect(
        await codeOf(
          executions.create(tenant, {
            mode: 'delegate',
            input: { type: 'task', id: 'task-8' },
            ...decision.assignment,
            versionSnapshot: { schemaVersion: 1, components: decision.components },
          }),
        ),
      ).toBe('specialist_not_eligible');
      expect((await executions.get(tenant, execution.id)).specialistVersion).toBe(1);
    });
  });
});
