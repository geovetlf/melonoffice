import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { checkAgentPolicyChange, checkStoredAgentPolicy } from './action-policy.js';
import {
  createAgentPolicyService,
  createAgentPolicySource,
  InMemoryAgentPolicyRepository,
} from './agent-policy.js';
import { isSpecialistError } from './errors.js';
import { checkAgentListQuery, pageOfAgents } from './listing.js';
import { createSpecialistManagement } from './management.js';
import { autonomyOf, checkConfiguration, conversationCeilingOf } from './model.js';
import { InMemorySpecialistRepository } from './repository.js';
import { createSkillCatalogue } from './skills.js';

/**
 * Autonomy (AE-4.4, ADR-0116): an agent's level as a versioned, audited choice of a person, and
 * the organization's rules for its agents. Memory only here; the Firestore repositories are
 * tested in `@melonoffice/firestore` and through the API.
 */

const NOW = new Date('2026-10-01T12:00:00Z');
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

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isSpecialistError(error)) return error;
    throw error;
  }
  throw new Error('accepted');
}

async function world() {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const repository = new InMemorySpecialistRepository(audit);
  const tenancy = new InMemoryTenancyStore(() => NOW, audit, undefined, departments);
  const make = (who: UserId, name: string) =>
    createOrganization(as(who), { name }, tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: (organization: Organization) =>
        provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE),
    });
  const orgA = (await make(ALICE, 'A')).organization.id;
  const orgB = (await make(BOB, 'B')).organization.id;
  const authorization = createAuthorizationService(ROLES as never);
  const management = createSpecialistManagement({
    repository,
    departments,
    organizations: tenancy,
    authorization,
    skills: createSkillCatalogue(),
    tools: () => undefined,
    now: () => NOW,
  });
  const policies = new InMemoryAgentPolicyRepository(audit);
  const policyService = createAgentPolicyService({
    repository: policies,
    organizations: tenancy,
    authorization,
    now: () => NOW,
  });
  return {
    audit,
    repository,
    tenancy,
    orgA,
    orgB,
    management,
    policies,
    policyService,
    tenantA: await resolveTenant(as(ALICE), orgA, tenancy),
    tenantB: await resolveTenant(as(BOB), orgB, tenancy),
  };
}

describe("an agent's level of autonomy (AE-4.4)", () => {
  it('starts at the default, and a person changes it as a new, audited version', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    expect(agent.configuration.autonomy).toBeUndefined();
    expect(autonomyOf(agent.configuration)).toBe('controlled');
    const id = agent.identity.id;
    const changed = await w.management.setAutonomy(w.tenantA, id, {
      fromVersion: agent.version,
      autonomy: 'propose',
    });
    expect(changed.version).toBe(agent.version + 1);
    expect(changed.configuration.autonomy).toBe('propose');
    // The earlier version keeps the level it had: an execution of it decides as it did.
    expect(
      (await w.repository.findVersion(w.orgA, id, agent.version))?.configuration.autonomy,
    ).toBeUndefined();
    const audited = w.audit.events().filter((e) => e.action === 'specialist.autonomy_changed');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      transition: { from: 'controlled', to: 'propose' },
      targetVersion: changed.version,
    });
    // Nothing else changed: the level grants nothing.
    expect(changed.configuration.tools).toEqual(agent.configuration.tools);
    expect(changed.configuration.permissions).toEqual(agent.configuration.permissions);
  });

  it('refuses an unknown level, no change, a stale version, another organization and the runtime', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    const set = (input: Record<string, unknown>, tenant = w.tenantA) =>
      refusal(() => w.management.setAutonomy(tenant, id, input));
    expect((await set({ fromVersion: 1, autonomy: 'free' })).detail).toBe('autonomy');
    expect((await set({ fromVersion: 1, autonomy: 'controlled' })).detail).toBe('autonomy');
    expect((await set({ fromVersion: 1, autonomy: 'propose', extra: 1 })).detail).toBe('extra');
    await w.management.setAutonomy(w.tenantA, id, { fromVersion: 1, autonomy: 'propose' });
    expect((await set({ fromVersion: 1, autonomy: 'within_policy' })).code).toBe(
      'specialist_concurrency_conflict',
    );
    expect((await set({ fromVersion: 2, autonomy: 'within_policy' }, w.tenantB)).code).toBe(
      'specialist_not_found',
    );
    // The runtime never changes an agent: only a person does.
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect((await set({ fromVersion: 2, autonomy: 'within_policy' }, runtime)).code).toBe(
      'permission_denied',
    );
    expect((await refusal(() => w.policyService.change(runtime, { revision: 0 }))).code).toBe(
      'permission_denied',
    );
  });

  it('keeps the level through a revision, which cannot change it', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    const proposing = await w.management.setAutonomy(w.tenantA, id, {
      fromVersion: 1,
      autonomy: 'propose',
    });
    const withoutLevel = { ...proposing.configuration };
    delete withoutLevel.autonomy;
    const revised = await w.management.revise(w.tenantA, id, {
      fromVersion: proposing.version,
      configuration: { ...withoutLevel, purpose: 'Ordena el almacén' },
    });
    expect(revised.configuration.autonomy).toBe('propose');
    const refused = await refusal(() =>
      w.management.revise(w.tenantA, id, {
        fromVersion: revised.version,
        configuration: { ...revised.configuration, autonomy: 'within_policy' },
      }),
    );
    expect(refused.detail).toBe('autonomy');
  });

  it('is checked wherever a configuration is read, and only proposes replies at propose', () => {
    const base = {
      departmentId: 'x',
      mainRoleId: 'r',
      roleVersion: 1,
    };
    expect(() =>
      checkConfiguration({ ...base, autonomy: 'free' }, 'x' as OrganizationId),
    ).toThrow();
    expect(conversationCeilingOf({ autonomy: 'propose' })).toBe('supervised');
    expect(conversationCeilingOf({})).toBe('autonomous');
    expect(conversationCeilingOf({ autonomy: 'within_policy' })).toBe('autonomous');
  });

  it('filters the agents by level, the default included', async () => {
    const w = await world();
    const ids: string[] = [];
    for (const name of ['Ana', 'Beto', 'Celia']) {
      ids.push(
        (await w.management.create(w.tenantA, { templateId: 'operations', displayName: name }))
          .identity.id,
      );
    }
    await w.management.setAutonomy(w.tenantA, ids[1] as string, {
      fromVersion: 1,
      autonomy: 'within_policy',
    });
    const names = async (autonomy: string) =>
      (
        await pageOfAgents(w.repository, w.orgA, checkAgentListQuery({ autonomy }, w.orgA))
      ).items.map((s) => s.identity.displayName);
    expect((await names('controlled')).sort()).toEqual(['Ana', 'Celia']);
    expect(await names('within_policy')).toEqual(['Beto']);
    expect(await names('propose')).toEqual([]);
    expect(() => checkAgentListQuery({ autonomy: 'free' }, w.orgA)).toThrow();
  });
});

describe("the organization's rules for its agents (AE-4.4)", () => {
  it('reads the defaults until a person sets them, then keeps each change audited', async () => {
    const w = await world();
    expect(await w.policyService.read(w.tenantA)).toMatchObject({
      sensitiveCategories: [],
      sensitiveTools: [],
      maxAutonomy: 'within_policy',
      revision: 0,
      updatedAt: null,
    });
    const changed = await w.policyService.change(w.tenantA, {
      revision: 0,
      sensitiveTools: ['follow_up_schedule', 'conversation_handoff'],
      sensitiveCategories: ['crm'],
      maxAutonomy: 'controlled',
    });
    expect(changed).toMatchObject({
      sensitiveTools: ['conversation_handoff', 'follow_up_schedule'],
      maxAutonomy: 'controlled',
      revision: 1,
    });
    expect(w.audit.events().filter((e) => e.action === 'agent_policy.changed')).toEqual([
      expect.objectContaining({
        organizationId: w.orgA,
        transition: { from: 'within_policy', to: 'controlled' },
        targetVersion: 1,
      }),
    ]);
    // The Agent Engine reads it with no person: this organization's only.
    const source = createAgentPolicySource(w.policies);
    expect((await source.forOrganization(w.orgA)).maxAutonomy).toBe('controlled');
    expect((await source.forOrganization(w.orgB)).maxAutonomy).toBe('within_policy');
    expect((await w.policyService.read(w.tenantB)).revision).toBe(0);
  });

  it('refuses a stale revision, malformed codes, and anyone but a person who manages agents', async () => {
    const w = await world();
    await w.policyService.change(w.tenantA, { revision: 0, maxAutonomy: 'propose' });
    expect((await refusal(() => w.policyService.change(w.tenantA, { revision: 0 }))).code).toBe(
      'specialist_concurrency_conflict',
    );
    for (const [input, field] of [
      [{ revision: 1, maxAutonomy: 'free' }, 'maxAutonomy'],
      [{ revision: 1, sensitiveTools: ['Not A Code'] }, 'sensitiveTools'],
      [{ revision: 1, sensitiveActions: ['send', 'send'] }, 'sensitiveActions'],
      [{ revision: -1 }, 'revision'],
      [{ revision: 1, other: true }, 'other'],
    ] as const) {
      expect((await refusal(() => w.policyService.change(w.tenantA, input))).detail).toBe(field);
    }
    expect(() => checkAgentPolicyChange('nope')).toThrow();
    const viewer = await world();
    const readOnly = createAgentPolicyService({
      repository: viewer.policies,
      organizations: viewer.tenancy,
      authorization: { authorize: () => ({ allowed: false }) } as never,
    });
    expect((await refusal(() => readOnly.change(viewer.tenantA, { revision: 0 }))).code).toBe(
      'permission_denied',
    );
    expect((await refusal(() => readOnly.read(viewer.tenantA))).code).toBe('permission_denied');
  });

  it('refuses a malformed stored policy instead of repairing it', () => {
    expect(() =>
      checkStoredAgentPolicy({
        organizationId: 'o' as OrganizationId,
        sensitiveCategories: [],
        sensitiveActions: [],
        sensitiveTools: [],
        maxAutonomy: 'free' as never,
        revision: 1,
        updatedAt: NOW.toISOString() as never,
        updatedBy: ALICE,
      }),
    ).toThrow();
  });
});
