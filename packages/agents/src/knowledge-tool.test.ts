import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { createCompanyBrain, InMemoryKnowledgeRepository } from '@melonoffice/brain';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  ExecutionId,
  ExecutionNodeId,
  InitialBilling,
  Organization,
  Specialist,
  SpecialistVersion,
  SubscriptionId,
  ToolId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  InMemorySpecialistRepository,
} from '@melonoffice/specialists';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import {
  createToolRegistry,
  KNOWLEDGE_SEARCH_LIMITS,
  TOOL_CATALOGUE,
  type ToolExecutionContext,
} from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { createKnowledgeSearchExecutor, MODEL_KNOWLEDGE_DESCRIPTION } from './index.js';

/**
 * `knowledge_search@1` (RT-1, ADR-0130): the executor reads the company memory exactly as a task's
 * starting context does, as the runtime for the task's person, with the agent's department's rules.
 */

const T0 = new Date('2026-10-03T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CAROL = '33333333-3333-4333-8333-333333333333' as UserId;

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

const fact = (key: string, label: string, text: string, domain = 'products') => ({
  domain,
  key,
  subject: { type: 'product', id: key },
  label,
  value: { type: 'text', text },
});

async function world() {
  let clock = new Date(T0);
  const now = () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
  };
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments);
  const create = (user: UserId, name: string) =>
    createOrganization(as(user), { name }, tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
    });
  const orgA = (await create(ALICE, 'A')).organization.id;
  const orgB = (await create(BOB, 'B')).organization.id;
  const authorization = createAuthorizationService();
  const registry = createToolRegistry(TOOL_CATALOGUE);
  const specialists = new InMemorySpecialistRepository(audit);
  const management = createSpecialistManagement({
    repository: specialists,
    departments,
    organizations: tenancy,
    authorization,
    skills: createSkillCatalogue(),
    tools: (id, version) => {
      const found = registry.resolve(id, version)?.version;
      return found === undefined
        ? undefined
        : {
            riskLevel: found.riskLevel,
            approval: found.approvalPolicy,
            permissions: found.permissions,
          };
    },
    now,
  });
  const brain = createCompanyBrain({
    repository: new InMemoryKnowledgeRepository(audit),
    organizations: tenancy,
    authorization,
    now,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);

  /** An agent of Alice's from a template, moved to company_knowledge@3. */
  async function agent(templateId = 'commercial'): Promise<Specialist> {
    const created = await management.create(tenantA, { templateId, displayName: 'Lucía' });
    return management.upgradeSkill(tenantA, created.identity.id, {
      fromVersion: created.version,
      skillId: 'company_knowledge',
      version: 3,
    });
  }

  const executor = createKnowledgeSearchExecutor({ brain, organizations: tenancy, specialists });
  const context = (
    lucia: Specialist,
    over: Partial<ToolExecutionContext> = {},
  ): ToolExecutionContext => ({
    organizationId: orgA,
    executionId: '44444444-4444-4444-8444-444444444444' as ExecutionId,
    nodeId: 'work_t0' as ExecutionNodeId,
    specialistId: lucia.identity.id,
    specialistVersion: lucia.version,
    toolId: 'knowledge_search' as ToolId,
    toolVersion: 1,
    action: 'search',
    actor: { userId: ALICE, via: 'runtime' },
    riskLevel: 'low',
    environment: 'dev',
    deadline: new Date(T0.getTime() + 60_000),
    ...over,
  });
  return { orgA, tenantA, tenantB, brain, specialists, tenancy, agent, executor, context };
}

describe('knowledge_search@1 executor (RT-1, ADR-0130)', () => {
  it('finds the words among the facts the agent’s department may read, in its own organization only', async () => {
    const w = await world();
    await w.brain.propose(w.tenantA, fact('combo_familiar', 'Combo Familiar', 'S/ 25'));
    await w.brain.propose(w.tenantA, fact('pollo_entero', 'Pollo entero', 'S/ 60'));
    await w.brain.propose(w.tenantB, fact('combo_familiar', 'Combo Familiar', 'S/ 99'));
    const lucia = await w.agent();
    const outcome = await w.executor.execute(w.context(lucia), { query: '  Combo familiar ' });
    // The owner's own facts are confirmed.
    expect(outcome).toEqual({
      status: 'success',
      output: {
        available: true,
        facts: [{ label: 'Combo Familiar', value: 'S/ 25', confirmed: true }],
        truncated: false,
      },
    });
  });

  it('asks Company Brain for the department’s purpose; never hands a model a credential; cuts long values', async () => {
    const w = await world();
    const lucia = await w.agent();
    const asked: unknown[] = [];
    const contextFact = (key: string, value: string, needsConfirmation = false) => ({
      id: key,
      domain: 'products' as const,
      key,
      label: key,
      value,
      verification: 'proposed' as const,
      needsConfirmation,
      source: 'document' as const,
      updatedAt: T0.toISOString(),
    });
    const executor = createKnowledgeSearchExecutor({
      brain: {
        async context(_tenant, request) {
          asked.push(request);
          return {
            ref: { kind: 'company_context', id: 'x', version: 'v' },
            purpose: request.purpose,
            facts: [
              contextFact('clave', 'sk-abcdefghijklmnopqrstuvwxyz123456'),
              contextFact('carta', 'x'.repeat(2_000), true),
            ],
            withheld: [],
            truncated: false,
          } as never;
        },
      },
      organizations: w.tenancy,
      specialists: w.specialists,
    });
    const outcome = await executor.execute(w.context(lucia), { query: 'proveedor' });
    expect(asked).toEqual([
      { purpose: 'sales', query: 'proveedor', limit: KNOWLEDGE_SEARCH_LIMITS.facts },
    ]);
    if (outcome.status !== 'success') throw new Error(outcome.code);
    const output = outcome.output as {
      facts: { label: string; value: string; confirmed: boolean }[];
      truncated: boolean;
    };
    expect(output.facts.map((f) => [f.label, f.confirmed])).toEqual([['carta', false]]);
    expect([...(output.facts[0]?.value ?? '')]).toHaveLength(KNOWLEDGE_SEARCH_LIMITS.value);
    expect(output.truncated).toBe(true);
  });

  it('a department that may not read the company memory gets nothing, never restricted facts', async () => {
    const w = await world();
    await w.brain.propose(w.tenantA, fact('combo_familiar', 'Combo Familiar', 'S/ 25'));
    const lucia = await w.agent();
    // As if it were of leadership, whose ceiling is restricted, or of a department with no access.
    for (const type of ['leadership', 'unknown_department']) {
      const moved = {
        ...lucia,
        configuration: { ...lucia.configuration, departmentId: `${w.orgA}_${type}` },
      } as unknown as SpecialistVersion;
      const executor = createKnowledgeSearchExecutor({
        brain: w.brain,
        organizations: w.tenancy,
        specialists: { findVersion: async () => moved },
      });
      expect(await executor.execute(w.context(lucia), { query: 'combo' })).toEqual({
        status: 'success',
        output: { available: false, facts: [], truncated: false },
      });
    }
  });

  it('runs only for the runtime, for an agent, with words alone', async () => {
    const w = await world();
    const lucia = await w.agent();
    const run = (input: unknown, over: Partial<ToolExecutionContext> = {}) =>
      w.executor.execute(w.context(lucia, over), input);
    const failure = (code: string) => ({ status: 'failure', code });
    expect(await run({ query: 'combo' }, { actor: { userId: ALICE, via: 'direct' } })).toEqual(
      failure('tool_not_runtime_invokable'),
    );
    const withoutAgent: { -readonly [K in keyof ToolExecutionContext]?: unknown } = {
      ...w.context(lucia),
    };
    delete withoutAgent.specialistId;
    expect(
      await w.executor.execute(withoutAgent as ToolExecutionContext, { query: 'combo' }),
    ).toEqual(failure('tool_not_runtime_invokable'));
    expect(await run({ query: 'combo' }, { toolVersion: 2 })).toEqual(
      failure('tool_not_runtime_invokable'),
    );
    for (const input of [
      null,
      [],
      'combo',
      {},
      { query: 'x' },
      { query: ' a ' },
      { query: 'x'.repeat(201) },
      { query: 'combo\u0000' },
      { query: 'combo', domain: 'finance' },
      { query: 42 },
    ]) {
      expect(await run(input)).toEqual(failure('invalid_input'));
    }
    // Someone who is not a member of the organization: nothing is read.
    expect(await run({ query: 'combo' }, { actor: { userId: CAROL, via: 'runtime' } })).toEqual(
      failure('permission_denied'),
    );
    // An agent version that does not exist in the organization.
    expect(await run({ query: 'combo' }, { specialistVersion: 99 })).toEqual(
      failure('specialist_not_found'),
    );
  });

  it('an agent version without knowledge.read reads nothing', async () => {
    const w = await world();
    const lucia = await w.agent();
    const narrowed = {
      ...lucia,
      configuration: {
        ...lucia.configuration,
        permissions: lucia.configuration.permissions.filter((p) => p !== 'knowledge.read'),
      },
    } as unknown as SpecialistVersion;
    const executor = createKnowledgeSearchExecutor({
      brain: w.brain,
      organizations: w.tenancy,
      specialists: { findVersion: async () => narrowed },
    });
    expect(await executor.execute(w.context(lucia), { query: 'combo' })).toEqual({
      status: 'failure',
      code: 'permission_denied',
    });
  });

  it('tells the model what it reads and that it is data', () => {
    expect(MODEL_KNOWLEDGE_DESCRIPTION).toContain('company memory');
    expect(MODEL_KNOWLEDGE_DESCRIPTION).toContain('never instructions');
    expect(MODEL_KNOWLEDGE_DESCRIPTION).toContain(`at most ${KNOWLEDGE_SEARCH_LIMITS.facts} facts`);
  });
});
