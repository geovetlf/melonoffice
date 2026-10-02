import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  InitialBilling,
  Organization,
  Specialist,
  SpecialistId,
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
import type { ToolLookup } from './capabilities.js';
import { isSpecialistError } from './errors.js';
import {
  AGENT_SCAN_MAX,
  checkAgentListQuery,
  indexedAgentFilter,
  SKILL_VERSIONS_QUERIED,
  decodeAgentCursor,
  encodeAgentCursor,
  pageOfAgents,
} from './listing.js';
import { createSpecialistManagement, type SpecialistWorkStop } from './management.js';
import { applySpecialistStatus, checkStoredSpecialist } from './model.js';
import { agentReadiness } from './readiness.js';
import { InMemorySpecialistRepository, SpecialistIndexUnavailable } from './repository.js';
import { createSpecialistService } from './service.js';
import { createSkillCatalogue } from './skills.js';

/**
 * Agent Engine AE-4 (ADR-0115): the lifecycle's effects, activation readiness and the agents'
 * pagination. Memory only here; the Firestore repository is tested in `@melonoffice/firestore`.
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

const TOOLS: ToolLookup = (id, version) =>
  id === 'follow_up_schedule' && version === 2
    ? {
        riskLevel: 'low',
        approval: 'approval_required',
        permissions: ['follow_up.manage'],
        active: true,
      }
    : undefined;

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isSpecialistError(error)) return error;
    throw error;
  }
  throw new Error('accepted');
}

async function world(
  options: {
    readonly roles?: Record<string, readonly string[]>;
    readonly tools?: ToolLookup;
    readonly work?: SpecialistWorkStop;
    readonly modelPolicyKnown?: (ref: { id: string; version: number }) => boolean;
  } = {},
) {
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
  const skills = createSkillCatalogue();
  const authorization = createAuthorizationService((options.roles ?? ROLES) as never);
  const management = createSpecialistManagement({
    repository,
    departments,
    organizations: tenancy,
    authorization,
    skills,
    tools: options.tools ?? TOOLS,
    ...(options.work === undefined ? {} : { work: options.work }),
    ...(options.modelPolicyKnown === undefined
      ? {}
      : { modelPolicyKnown: options.modelPolicyKnown }),
    now: () => NOW,
  });
  const service = createSpecialistService({
    repository,
    departments,
    organizations: tenancy,
    authorization,
  });
  return {
    audit,
    repository,
    departments,
    tenancy,
    orgA,
    orgB,
    skills,
    management,
    service,
    tenantA: await resolveTenant(as(ALICE), orgA, tenancy),
    tenantB: await resolveTenant(as(BOB), orgB, tenancy),
  };
}

/** Records every stop it is asked for, as the Agent Engine's work stop would receive them. */
function recordingStop(fail = false) {
  const calls: { specialistId: SpecialistId; reason: string }[] = [];
  const work: SpecialistWorkStop = {
    async stop(_tenant, specialistId, reason) {
      calls.push({ specialistId, reason });
      if (fail) throw new Error('should never surface');
      return { cancelled: 1, more: false };
    },
  };
  return { calls, work };
}

describe('lifecycle (AE-4.1)', () => {
  it('keeps who changed the status, when and why, and audits it without the words', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    await w.management.setStatus(w.tenantA, id, { from: 'draft', to: 'active' });
    const disabled = await w.management.setStatus(w.tenantA, id, {
      from: 'active',
      to: 'disabled',
      reason: '  Revisión de su trabajo  ',
    });
    expect(disabled.status).toBe('disabled');
    expect(disabled.lastStatusChange).toEqual({
      from: 'active',
      to: 'disabled',
      at: NOW.toISOString(),
      by: ALICE,
      reason: 'Revisión de su trabajo',
    });
    const events = w.audit.events().filter((e) => e.action === 'specialist.status_changed');
    expect(events.at(-1)?.transition).toEqual({ from: 'active', to: 'disabled' });
    expect(events.at(-1)?.reason).toBe('reason_given');
    expect(JSON.stringify(events)).not.toContain('Revisión');
    // Stored and read back exactly.
    expect((await w.repository.find(w.orgA, id))?.lastStatusChange?.reason).toBe(
      'Revisión de su trabajo',
    );
  });

  it('refuses to disable without a reason, and a reason that is too long or not text', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    await w.management.setStatus(w.tenantA, id, { from: 'draft', to: 'active' });
    for (const reason of [undefined, '', '   ', 'x'.repeat(501), 42]) {
      const error = await refusal(() =>
        w.management.setStatus(w.tenantA, id, { from: 'active', to: 'disabled', reason }),
      );
      expect([error.code, error.detail]).toEqual(['invalid_specialist', 'reason']);
    }
    // Pausing needs none.
    const paused = await w.management.setStatus(w.tenantA, id, { from: 'active', to: 'paused' });
    expect(paused.lastStatusChange?.reason).toBeUndefined();
    expect(
      (await refusal(() => w.management.setStatus(w.tenantA, id, { from: 'paused', to: 'x' })))
        .code,
    ).toBe('invalid_specialist_transition');
    expect(
      (
        await refusal(() =>
          w.management.setStatus(w.tenantA, id, { from: 'paused', to: 'active', extra: 1 }),
        )
      ).detail,
    ).toBe('extra');
  });

  it('stops the work in progress when paused, disabled or archived, and never when activated', async () => {
    const stop = recordingStop();
    const w = await world({ work: stop.work });
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    await w.management.setStatus(w.tenantA, id, { from: 'draft', to: 'active' });
    expect(stop.calls).toEqual([]);
    await w.management.setStatus(w.tenantA, id, { from: 'active', to: 'paused' });
    await w.management.setStatus(w.tenantA, id, { from: 'paused', to: 'active' });
    await w.management.setStatus(w.tenantA, id, {
      from: 'active',
      to: 'disabled',
      reason: 'audit',
    });
    await w.management.setStatus(w.tenantA, id, { from: 'disabled', to: 'archived' });
    expect(stop.calls).toEqual([
      { specialistId: id, reason: 'agent_paused' },
      { specialistId: id, reason: 'agent_disabled' },
      { specialistId: id, reason: 'agent_archived' },
    ]);
  });

  it('does not stop anything when the status change is refused', async () => {
    const stop = recordingStop();
    const w = await world({ work: stop.work });
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    await refusal(() =>
      w.management.setStatus(w.tenantA, agent.identity.id, { from: 'active', to: 'paused' }),
    );
    await refusal(() =>
      w.management.setStatus(w.tenantB, agent.identity.id, { from: 'draft', to: 'archived' }),
    );
    expect(stop.calls).toEqual([]);
  });

  it('never lets the runtime, GIA or another organization change a status', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(
      (await refusal(() => w.management.setStatus(runtime, id, { from: 'draft', to: 'active' })))
        .code,
    ).toBe('permission_denied');
    expect(
      (await refusal(() => w.management.setStatus(w.tenantB, id, { from: 'draft', to: 'active' })))
        .code,
    ).toBe('specialist_not_found');
  });

  it('reads a stored status change and refuses a malformed one', () => {
    const base = {
      identity: {
        id: '33333333-3333-4333-8333-333333333333',
        displayName: 'Olga',
        createdAt: NOW.toISOString(),
        createdBy: ALICE,
      },
      organizationId: '44444444-4444-4444-8444-444444444444',
      status: 'paused',
      version: 1,
      configuration: {
        departmentId: '44444444-4444-4444-8444-444444444444_operations',
        mainRoleId: 'operations_agent',
        roleVersion: 1,
        capabilities: [],
        skills: [],
        tools: [],
        permissions: [],
        policies: {},
      },
      revision: 2,
      updatedAt: NOW.toISOString(),
    } as unknown as Specialist;
    const change = { from: 'active', to: 'paused', at: NOW.toISOString(), by: ALICE };
    expect(checkStoredSpecialist({ ...base, lastStatusChange: change } as Specialist)).toBeTruthy();
    for (const bad of [
      { ...change, to: 'active' },
      { ...change, from: 'nope' },
      { ...change, at: 'yesterday' },
      { ...change, by: '' },
    ]) {
      expect(() =>
        checkStoredSpecialist({ ...base, lastStatusChange: bad } as unknown as Specialist),
      ).toThrow();
    }
    // A change without a person (a migration, a seed) keeps no record and needs no reason.
    const moved = applySpecialistStatus(
      { ...base, status: 'active' } as Specialist,
      { from: 'active', to: 'disabled' },
      NOW.toISOString() as never,
    );
    expect(moved.specialist.lastStatusChange).toBeUndefined();
  });
});

describe('activation readiness (AE-4.2)', () => {
  it('activates an agent with everything it needs', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    const active = await w.management.setStatus(w.tenantA, agent.identity.id, {
      from: 'draft',
      to: 'active',
    });
    expect(active.status).toBe('active');
  });

  it('refuses a permission the person does not hold, naming it, and changes nothing', async () => {
    const roles = {
      ...ROLES,
      owner: ROLES.owner.filter((p) => p !== 'opportunity.read'),
    };
    const w = await world({ roles });
    const agent = await w.management.create(w.tenantA, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    const error = await refusal(() =>
      w.management.setStatus(w.tenantA, agent.identity.id, { from: 'draft', to: 'active' }),
    );
    expect(error.code).toBe('specialist_not_ready');
    expect(error.problems).toEqual([
      { kind: 'permission_not_held', permission: 'opportunity.read' },
    ]);
    expect((await w.repository.find(w.orgA, agent.identity.id))?.status).toBe('draft');
    expect(w.audit.events().some((e) => e.action === 'specialist.status_changed')).toBe(false);
  });

  it('refuses a tool that may not run now and a model policy the gateway does not know', async () => {
    const w = await world({
      tools: (id, version) =>
        id === 'follow_up_schedule' && version === 2
          ? {
              riskLevel: 'low',
              approval: 'approval_required',
              permissions: ['follow_up.manage'],
              active: false,
            }
          : undefined,
      modelPolicyKnown: () => false,
    });
    const agent = await w.management.create(w.tenantA, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    const error = await refusal(() =>
      w.management.setStatus(w.tenantA, agent.identity.id, { from: 'draft', to: 'active' }),
    );
    expect(error.problems).toEqual([
      { kind: 'tool_not_active', tool: 'follow_up_schedule' },
      { kind: 'model_policy_unknown', policy: 'agent_task@2' },
    ]);
  });

  it('refuses an agent whose department is not active', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const departmentId = agent.configuration.departmentId;
    const department = await w.departments.find(w.orgA, departmentId);
    w.departments.put({ ...(department as object), status: 'paused' } as never);
    const error = await refusal(() =>
      w.management.setStatus(w.tenantA, agent.identity.id, { from: 'draft', to: 'active' }),
    );
    expect(error.problems).toContainEqual({ kind: 'department_not_active' });
  });

  it('names every problem of a configuration, pure', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const broken: Specialist = {
      ...agent,
      configuration: {
        ...agent.configuration,
        skills: [],
        tools: [{ id: 'mystery' as never, version: 1 }],
      },
    };
    const readiness = agentReadiness(broken, {
      skills: w.skills,
      tools: TOOLS,
      held: new Set(),
      departmentActive: false,
    });
    expect(readiness.ready).toBe(false);
    expect([...new Set(readiness.problems.map((p) => p.kind))]).toEqual([
      'no_skills',
      'unknown_tool',
      'tool_not_granted_by_skill',
      'permission_not_held',
      'department_not_active',
    ]);
    // A skill its department may not have (ADR-0104).
    const misplaced: Specialist = {
      ...agent,
      configuration: {
        ...agent.configuration,
        departmentId: departmentIdOf(w.orgA, 'operations' as DepartmentTypeId),
        skills: [{ id: 'customer_follow_up' as never, version: 3 }],
      },
    };
    expect(
      agentReadiness(misplaced, {
        skills: w.skills,
        tools: TOOLS,
        held: new Set(['contact.read', 'opportunity.read', 'follow_up.read', 'knowledge.read']),
        departmentActive: true,
      }).problems,
    ).toContainEqual({ kind: 'skill_not_for_department', skill: 'customer_follow_up' });
  });
});

describe('pagination (AE-4.3)', () => {
  /** `count` agents of organization A, named Agent 0001…, spread over statuses and departments. */
  async function many(count: number) {
    const w = await world();
    const ids: string[] = [];
    const templates = ['operations', 'research', 'finance'];
    for (let i = 0; i < count; i += 1) {
      const agent = await w.management.create(w.tenantA, {
        templateId: templates[i % templates.length],
        displayName: `Agent ${String(i).padStart(4, '0')}${i % 7 === 0 ? ' Mónica' : ''}`,
      });
      if (i % 2 === 0) {
        await w.management.setStatus(w.tenantA, agent.identity.id, {
          from: 'draft',
          to: 'active',
        });
      }
      ids.push(agent.identity.id);
    }
    // Organization B's own agents must never appear in A's pages.
    await w.management.create(w.tenantB, { templateId: 'operations', displayName: 'Agent B' });
    return { ...w, ids: ids.sort() };
  }

  /** Every page of a query, following its cursors. */
  async function walk(
    w: Awaited<ReturnType<typeof many>>,
    params: Record<string, string>,
  ): Promise<{ pages: number; ids: string[] }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await w.service.page(w.tenantA, {
        ...params,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages += 1;
      ids.push(...page.items.map((s) => s.identity.id));
      if (page.nextCursor === null) return { pages, ids };
      cursor = page.nextCursor;
      if (pages > 1000) throw new Error('runaway');
    }
  }

  it('reads 1000 agents 25 at a time in a stable order, each exactly once', async () => {
    const w = await many(1000);
    let reads = 0;
    const page = w.repository.page.bind(w.repository);
    w.repository.page = async (organizationId, request) => {
      reads += 1;
      expect(request.limit).toBeLessThanOrEqual(100);
      return page(organizationId, request);
    };
    const all = await walk(w, { limit: '25' });
    expect(all.pages).toBe(40);
    expect(reads).toBe(40);
    expect(all.ids).toEqual(w.ids);
  }, 60_000);

  it('filters by status and department in the store, and by name and skill on top', async () => {
    const w = await many(60);
    const active = await walk(w, { status: 'active', limit: '7' });
    expect(active.ids).toHaveLength(30);
    const research = departmentIdOf(w.orgA, 'research' as DepartmentTypeId);
    const inResearch = await walk(w, { departmentId: research, limit: '100' });
    expect(inResearch.ids).toHaveLength(20);
    // Any case and accents: "monica" finds "Mónica".
    const named = await walk(w, { q: 'monica', limit: '3' });
    expect(named.ids).toHaveLength(9);
    const bySkill = await walk(w, { skill: 'finance_review', limit: '100' });
    expect(bySkill.ids).toHaveLength(20);
    const none = await w.service.page(w.tenantA, { q: 'nobody here' });
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  it('reads at most a bounded number of records per narrowed request and says where to go on', async () => {
    const w = await many(AGENT_SCAN_MAX + 20);
    let read = 0;
    const page = w.repository.page.bind(w.repository);
    w.repository.page = async (organizationId, request) => {
      const found = await page(organizationId, request);
      read += found.items.length;
      return found;
    };
    // Nothing matches: the first request stops at the scan limit with a cursor.
    const first = await w.service.page(w.tenantA, { q: 'zzz' });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(read).toBe(AGENT_SCAN_MAX);
    const second = await w.service.page(w.tenantA, { q: 'zzz', cursor: String(first.nextCursor) });
    expect(second).toEqual({ items: [], nextCursor: null });
  }, 60_000);

  it("never shows another organization's agents, and keeps the old whole list", async () => {
    const w = await many(5);
    const b = await w.service.page(w.tenantB, {});
    expect(b.items.map((s) => s.identity.displayName)).toEqual(['Agent B']);
    expect((await w.service.list(w.tenantA)).map((s) => s.identity.id).sort()).toEqual(w.ids);
    // A department of another organization is refused like a malformed one.
    const theirs = departmentIdOf(w.orgB, 'operations' as DepartmentTypeId);
    const error = await refusal(() => w.service.page(w.tenantA, { departmentId: theirs }));
    expect(error.detail).toBe('departmentId');
  });

  it('refuses malformed parameters and cursors', () => {
    const org = '44444444-4444-4444-8444-444444444444' as never;
    const detail = (params: Record<string, string>) => {
      try {
        checkAgentListQuery(params, org);
      } catch (error) {
        return isSpecialistError(error) ? error.detail : 'other';
      }
      return 'accepted';
    };
    expect(detail({})).toBe('accepted');
    expect(detail({ limit: '0' })).toBe('limit');
    expect(detail({ limit: '101' })).toBe('limit');
    expect(detail({ limit: '2.5' })).toBe('limit');
    expect(detail({ status: 'sleeping' })).toBe('status');
    expect(detail({ skill: 'Bad Skill' })).toBe('skill');
    expect(detail({ q: 'x'.repeat(101) })).toBe('q');
    expect(detail({ cursor: 'not-a-cursor' })).toBe('cursor');
    expect(detail({ departmentId: 'x' })).toBe('departmentId');
    const id = '33333333-3333-4333-8333-333333333333' as SpecialistId;
    expect(decodeAgentCursor(encodeAgentCursor(id))).toBe(id);
    expect(checkAgentListQuery({ limit: '10', q: '  Ana  ' }, org)).toEqual({
      limit: 10,
      q: 'Ana',
    });
  });

  it('pages a narrowed query without skipping a match at a page boundary', async () => {
    const w = await many(30);
    // Every agent matches "agent": the narrowed path must agree with the plain one.
    const plain = await walk(w, { limit: '4' });
    const narrowed = await walk(w, { q: 'agent', limit: '4' });
    expect(narrowed.ids).toEqual(plain.ids);
    expect(narrowed.ids).toEqual(w.ids);
    const direct = await pageOfAgents(w.repository, w.orgA, { limit: 30 });
    expect(direct.nextCursor).toBeNull();
  });
  // Stage 1 of the search beyond 500 agents (ADR-0118): a skill or an autonomy level is asked of
  // the store through its index; without the index the same request reads as before.

  /** Makes `w`'s store refuse skill and autonomy queries, as Firestore does without the index. */
  function withoutIndexes(w: Awaited<ReturnType<typeof many>>) {
    const page = w.repository.page.bind(w.repository);
    let refused = 0;
    w.repository.page = async (organizationId, request) => {
      if (request.skillRefs !== undefined || request.autonomy !== undefined) {
        refused += 1;
        throw new SpecialistIndexUnavailable();
      }
      return page(organizationId, request);
    };
    return { refused: () => refused };
  }

  /** What organization A's agents matching `test` are, by id, read straight from the store. */
  const expected = async (
    w: Awaited<ReturnType<typeof many>>,
    test: (s: Specialist) => boolean,
  ): Promise<string[]> =>
    (await w.repository.list(w.orgA))
      .filter(test)
      .map((s) => s.identity.id)
      .sort();

  const hasSkill = (skill: string) => (s: Specialist) =>
    s.configuration.skills.some((r) => r.id === skill);

  for (const count of [500, 501]) {
    it(`finds every match exactly once among ${String(count)} agents, indexed or not`, async () => {
      const w = await many(count);
      const finance = await expected(w, hasSkill('finance_review'));
      expect(finance.length).toBeGreaterThan(0);
      const requests: { skillRefs?: unknown; status?: unknown }[] = [];
      const page = w.repository.page.bind(w.repository);
      w.repository.page = async (organizationId, request) => {
        requests.push(request);
        return page(organizationId, request);
      };
      const all = await walk(w, { limit: '25' });
      expect(all.ids).toEqual(w.ids);
      expect(all.pages).toBe(Math.ceil(count / 25));
      requests.length = 0;
      const indexed = await walk(w, { skill: 'finance_review', limit: '25' });
      expect(indexed.ids).toEqual(finance);
      // Through the index every store request names the skill, and a page is a full page.
      expect(requests.every((r) => Array.isArray(r.skillRefs))).toBe(true);
      expect(indexed.pages).toBe(
        Math.ceil(finance.length / 25) + (finance.length % 25 === 0 ? 1 : 0),
      );
      const named = await walk(w, { q: 'monica', limit: '25' });
      expect(named.ids).toEqual(
        await expected(w, (s) => s.identity.displayName.includes('Mónica')),
      );
      const off = withoutIndexes(w);
      const fallback = await walk(w, { skill: 'finance_review', limit: '25' });
      expect(fallback.ids).toEqual(finance);
      expect(off.refused()).toBeGreaterThan(0);
    }, 120_000);
  }

  it('fills skill pages from matches only among 1200 agents, and loses or repeats none', async () => {
    const w = await many(1200);
    let read = 0;
    const page = w.repository.page.bind(w.repository);
    w.repository.page = async (organizationId, request) => {
      const found = await page(organizationId, request);
      read += found.items.length;
      return found;
    };
    const finance = await expected(w, hasSkill('finance_review'));
    expect(finance).toHaveLength(400);
    const indexed = await walk(w, { skill: 'finance_review', limit: '50' });
    expect(indexed.ids).toEqual(finance);
    expect(new Set(indexed.ids).size).toBe(400);
    // Only matching agents are read (plus one look-ahead per page), never the other 800.
    expect(read).toBeLessThanOrEqual(400 + indexed.pages);
    expect(indexed.pages).toBe(8);
    // Without the index: the same agents, each request bounded.
    withoutIndexes(w);
    read = 0;
    const fallback = await walk(w, { skill: 'finance_review', limit: '50' });
    expect(fallback.ids).toEqual(finance);
    // It reads every agent to find them, where the index read only the matches.
    expect(read).toBeGreaterThanOrEqual(1200);
  }, 180_000);

  it('asks for an autonomy level other than the default through the index, and reads the default', async () => {
    const w = await many(40);
    const chosen = w.ids.filter((_, i) => i % 5 === 0);
    for (const id of chosen) {
      await w.management.setAutonomy(w.tenantA, id as SpecialistId, {
        fromVersion: (await w.repository.find(w.orgA, id as SpecialistId))?.version ?? 1,
        autonomy: 'propose',
      });
    }
    const requests: { autonomy?: unknown }[] = [];
    const page = w.repository.page.bind(w.repository);
    w.repository.page = async (organizationId, request) => {
      requests.push(request);
      return page(organizationId, request);
    };
    const propose = await walk(w, { autonomy: 'propose', limit: '3' });
    expect(propose.ids).toEqual([...chosen].sort());
    expect(requests.every((r) => r.autonomy === 'propose')).toBe(true);
    requests.length = 0;
    // The default level is not stored on older agents: it is read, never asked of the index.
    const controlled = await walk(w, { autonomy: 'controlled', limit: '10' });
    expect(controlled.ids).toEqual(w.ids.filter((id) => !chosen.includes(id)));
    expect(requests.every((r) => r.autonomy === undefined)).toBe(true);
    withoutIndexes(w);
    expect((await walk(w, { autonomy: 'propose', limit: '3' })).ids).toEqual([...chosen].sort());
  }, 60_000);

  it('combines a skill with status, department, name and autonomy, and checks each one', async () => {
    const w = await many(90);
    const finance = departmentIdOf(w.orgA, 'finance' as DepartmentTypeId);
    const first = (await expected(w, hasSkill('finance_review')))[0] as SpecialistId;
    await w.management.setAutonomy(w.tenantA, first, {
      fromVersion: (await w.repository.find(w.orgA, first))?.version ?? 1,
      autonomy: 'within_policy',
    });
    const cases: [Record<string, string>, (s: Specialist) => boolean][] = [
      [
        { skill: 'finance_review', status: 'active' },
        (s) => hasSkill('finance_review')(s) && s.status === 'active',
      ],
      [
        { skill: 'finance_review', departmentId: finance },
        (s) => s.configuration.departmentId === finance,
      ],
      [
        { skill: 'finance_review', q: 'monica', status: 'draft' },
        (s) =>
          hasSkill('finance_review')(s) &&
          s.status === 'draft' &&
          s.identity.displayName.includes('Mónica'),
      ],
      [
        { skill: 'finance_review', autonomy: 'controlled' },
        (s) =>
          hasSkill('finance_review')(s) &&
          (s.configuration.autonomy ?? 'controlled') === 'controlled',
      ],
      [
        { autonomy: 'within_policy', status: 'active' },
        (s) => s.configuration.autonomy === 'within_policy' && s.status === 'active',
      ],
      [{ skill: 'operations_nothing' }, () => false],
    ];
    for (const [params, test] of cases) {
      const want = await expected(w, test);
      expect((await walk(w, { ...params, limit: '4' })).ids).toEqual(want);
    }
    withoutIndexes(w);
    for (const [params, test] of cases) {
      expect((await walk(w, { ...params, limit: '4' })).ids).toEqual(await expected(w, test));
    }
  }, 60_000);

  it('keeps cursors stable: a cursor goes on across the index appearing or disappearing, and new agents never repeat one', async () => {
    const w = await many(120);
    const finance = await expected(w, hasSkill('finance_review'));
    const first = await w.service.page(w.tenantA, { skill: 'finance_review', limit: '10' });
    // The index goes away between two requests: the cursor still goes on from the same agent.
    const off = withoutIndexes(w);
    const second = await w.service.page(w.tenantA, {
      skill: 'finance_review',
      limit: '10',
      cursor: String(first.nextCursor),
    });
    expect(off.refused()).toBe(1);
    expect([...first.items, ...second.items].map((s) => s.identity.id)).toEqual(
      finance.slice(0, 20),
    );
    // An agent added mid-walk is either after the cursor (and seen once) or before (and not seen).
    await w.management.create(w.tenantA, { templateId: 'finance', displayName: 'Late agent' });
    const rest = await walk(w, { skill: 'finance_review', limit: '10' });
    expect(new Set(rest.ids).size).toBe(rest.ids.length);
    expect(rest.ids).toEqual(await expected(w, hasSkill('finance_review')));
  }, 60_000);

  it("never returns another organization's agents through the index, even with its cursor", async () => {
    const w = await many(30);
    await w.management.create(w.tenantB, { templateId: 'finance', displayName: 'Finance B' });
    const a = await walk(w, { skill: 'finance_review', limit: '5' });
    expect(a.ids).toEqual(await expected(w, hasSkill('finance_review')));
    const b = await w.service.page(w.tenantB, { skill: 'finance_review' });
    expect(b.items.map((s) => s.identity.displayName)).toEqual(['Finance B']);
    // Organization A's cursor in B's request reads B's agents only.
    const fromA = await w.service.page(w.tenantA, { skill: 'finance_review', limit: '1' });
    const crossed = await w.service.page(w.tenantB, {
      skill: 'finance_review',
      cursor: String(fromA.nextCursor),
    });
    expect(crossed.items.every((s) => s.organizationId === w.orgB)).toBe(true);
    // A store that returned another organization's agent would still have it dropped.
    const page = w.repository.page.bind(w.repository);
    const intruder = (await w.repository.list(w.orgB))[0] as Specialist;
    w.repository.page = async (organizationId, request) => {
      const found = await page(organizationId, request);
      return { ...found, items: [intruder, ...found.items] };
    };
    const guarded = await w.service.page(w.tenantA, { skill: 'finance_review', limit: '100' });
    expect(guarded.items.some((s) => s.organizationId === w.orgB)).toBe(false);
  });

  it('asks a skill as its versions 1 to 30, and the default autonomy never through the index', () => {
    const filter = indexedAgentFilter({ skill: 'finance_review' });
    expect(filter?.skillRefs).toHaveLength(SKILL_VERSIONS_QUERIED);
    expect(filter?.skillRefs?.[0]).toEqual({ id: 'finance_review', version: 1 });
    expect(filter?.skillRefs?.[29]).toEqual({ id: 'finance_review', version: 30 });
    expect(indexedAgentFilter({ autonomy: 'controlled' })).toBeUndefined();
    expect(indexedAgentFilter({ autonomy: 'propose' })).toEqual({ autonomy: 'propose' });
    expect(indexedAgentFilter({})).toBeUndefined();
  });
});
