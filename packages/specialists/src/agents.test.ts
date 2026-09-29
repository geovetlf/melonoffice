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
  SpecialistConfiguration,
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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentCapabilities, type ToolLookup } from './capabilities.js';
import { createSpecialistManagement } from './management.js';
import { InMemorySpecialistRepository } from './repository.js';
import { createSkillCatalogue, SKILL_CATALOGUE } from './skills.js';
import { AGENT_TEMPLATES } from './templates.js';

/** Agent Engine phase 1 (ADR-0062): catalogues, management and what an agent may do. */

const NOW = new Date('2026-09-29T12:00:00Z');
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

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const detail =
        'detail' in error && error.detail !== undefined ? `:${String(error.detail)}` : '';
      return `${String(error.code)}${detail}`;
    }
    throw error;
  }
  return 'accepted';
}

/** The two tools that exist today, as the tool registry describes them. */
const TOOLS: ToolLookup = (id, version) =>
  id === 'message_send' && version >= 1 && version <= 3
    ? { riskLevel: 'medium', approval: 'auto', permissions: ['conversation.send'] }
    : id === 'conversation_handoff' && version === 1
      ? { riskLevel: 'low', approval: 'auto', permissions: ['conversation.read'] }
      : id === 'follow_up_schedule' && version === 2
        ? { riskLevel: 'low', approval: 'approval_required', permissions: ['follow_up.manage'] }
        : undefined;

async function world(roles: Record<string, readonly string[]> = ROLES) {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const repository = new InMemorySpecialistRepository(audit);
  const tenancy = new InMemoryTenancyStore(() => NOW, audit, undefined, departments);
  const provision = (organization: Organization) =>
    provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
  const make = (who: UserId, name: string) =>
    createOrganization(as(who), { name }, tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
  const orgA = (await make(ALICE, 'A')).organization.id;
  const orgB = (await make(BOB, 'B')).organization.id;
  const skills = createSkillCatalogue();
  const authorization = createAuthorizationService(roles as never);
  const management = createSpecialistManagement({
    repository,
    departments,
    organizations: tenancy,
    authorization,
    skills,
    tools: TOOLS,
    now: () => NOW,
  });
  return {
    audit,
    repository,
    tenancy,
    orgA,
    orgB,
    skills,
    management,
    tenantA: await resolveTenant(as(ALICE), orgA, tenancy),
    tenantB: await resolveTenant(as(BOB), orgB, tenancy),
  };
}

describe('catalogues', () => {
  it('every template names known skills, one base role and a department of the catalogue', () => {
    const skills = createSkillCatalogue();
    const types = new Set(DEFAULT_DEPARTMENT_CATALOGUE.types.map((t) => t.id as string));
    expect(AGENT_TEMPLATES.map((t) => t.id)).toEqual([
      'commercial',
      'marketing',
      'creative',
      'operations',
      'finance',
      'research',
    ]);
    for (const template of AGENT_TEMPLATES) {
      expect(types.has(template.departmentTypeId)).toBe(true);
      expect(template.mainRoleId).toBe(`${template.id}_agent`);
      expect(template.purpose.es.length).toBeGreaterThan(0);
      expect(template.purpose.en.length).toBeGreaterThan(0);
      for (const ref of template.skills) {
        expect(skills.resolve(ref.id, ref.version)).toBeDefined();
      }
    }
    // GIA is the orchestrator, not an agent of a department.
    expect(AGENT_TEMPLATES.some((t) => t.id === 'gia')).toBe(false);
    expect(AGENT_TEMPLATES.some((t) => t.departmentTypeId === 'leadership')).toBe(false);
  });

  it('has every name and description in English and Spanish', () => {
    for (const lang of ['en', 'es']) {
      const messages = JSON.parse(
        readFileSync(new URL(`../../i18n/src/locales/${lang}.json`, import.meta.url), 'utf8'),
      ) as Record<string, string>;
      const keys = [
        ...AGENT_TEMPLATES.map((t) => t.nameKey),
        ...SKILL_CATALOGUE.flatMap((s) => [s.nameKey, s.descriptionKey]),
      ];
      for (const key of keys) expect(messages[key], `${lang} ${key}`).toBeTruthy();
    }
  });

  it('resolves only exact skill versions and refuses a duplicate', () => {
    const skills = createSkillCatalogue();
    expect(skills.resolve('customer_follow_up', 1)?.reads).toContain('follow_up.read');
    expect(skills.resolve('customer_follow_up', 2)?.actions).toEqual(['follow_up.schedule']);
    expect(skills.resolve('customer_follow_up', 3)).toBeUndefined();
    expect(skills.resolve('nope', 1)).toBeUndefined();
    expect(() =>
      createSkillCatalogue([...SKILL_CATALOGUE, ...SKILL_CATALOGUE.slice(0, 1)]),
    ).toThrow();
  });
});

describe('agent management', () => {
  it('creates an agent from a template, in draft, with the tools its skills grant, audited with the write', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'commercial',
      displayName: 'Lucía',
      locale: 'es',
    });
    expect(agent.status).toBe('draft');
    expect(agent.version).toBe(1);
    expect(agent.organizationId).toBe(w.orgA);
    expect(agent.configuration.departmentId).toBe(
      departmentIdOf(w.orgA, 'sales' as DepartmentTypeId),
    );
    expect(agent.configuration.mainRoleId).toBe('commercial_agent');
    // customer_follow_up@2 grants the agent's follow-up at one version (ADR-0084): assigned.
    expect(agent.configuration.skills).toEqual([
      { id: 'company_knowledge', version: 2 },
      { id: 'customer_follow_up', version: 2 },
      { id: 'pipeline_analysis', version: 1 },
    ]);
    expect(agent.configuration.tools).toEqual([{ id: 'follow_up_schedule', version: 2 }]);
    expect(agent.configuration.permissions).toEqual([
      'contact.read',
      'follow_up.manage',
      'follow_up.read',
      'knowledge.read',
      'opportunity.read',
      'report.read',
    ]);
    expect(await w.repository.findVersion(w.orgA, agent.identity.id, 1)).toBeDefined();
    const events = w.audit.events().filter((e) => e.action.startsWith('specialist.'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'specialist.created',
      organizationId: w.orgA,
      target: { type: 'specialist', id: agent.identity.id },
      targetVersion: 1,
      permission: 'specialist.manage',
    });
    // Never its name or purpose.
    expect(JSON.stringify(events)).not.toContain('Lucía');
  });

  it('refuses unknown templates, locales, fields and a body that is not an object', async () => {
    const w = await world();
    const create = (input: unknown) =>
      codeOf(() => w.management.create(w.tenantA, input as Record<string, unknown>));
    expect(await create({ templateId: 'gia', displayName: 'X' })).toBe(
      'invalid_specialist:templateId',
    );
    expect(await create({ templateId: 'finance', displayName: 'X', locale: 'fr' })).toBe(
      'invalid_specialist:locale',
    );
    expect(await create({ templateId: 'finance', displayName: 'X', tools: [] })).toBe(
      'invalid_specialist:tools',
    );
    expect(await create(null)).toBe('invalid_specialist:body');
    expect(await create({ templateId: 'finance', displayName: '' })).toMatch(/^invalid_specialist/);
    expect(w.audit.events().filter((e) => e.action.startsWith('specialist.'))).toEqual([]);
  });

  it('is a person with specialist.manage only: never the runtime, never without the permission', async () => {
    const w = await world();
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(
      await codeOf(() =>
        w.management.create(runtime, { templateId: 'finance', displayName: 'Ana' }),
      ),
    ).toBe('permission_denied');

    const limited = await world({
      ...ROLES,
      owner: ROLES.owner.filter((p) => p !== 'specialist.manage'),
    });
    expect(
      await codeOf(() =>
        limited.management.create(limited.tenantA, { templateId: 'finance', displayName: 'Ana' }),
      ),
    ).toBe('permission_denied');
  });

  it("never reaches another organization's agent", async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'research',
      displayName: 'Iris',
    });
    const id = agent.identity.id;
    expect(
      await codeOf(() => w.management.setStatus(w.tenantB, id, { from: 'draft', to: 'active' })),
    ).toBe('specialist_not_found');
    expect(
      await codeOf(() =>
        w.management.revise(w.tenantB, id, { fromVersion: 1, configuration: agent.configuration }),
      ),
    ).toMatch(/^invalid_specialist|^specialist_not_found|^department_not_assignable/);
    expect((await w.repository.find(w.orgA, id))?.status).toBe('draft');
  });

  it('changes the configuration as a new version and keeps what reaches outside', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'marketing',
      displayName: 'Mara',
    });
    const id = agent.identity.id;
    const configuration: SpecialistConfiguration = {
      ...agent.configuration,
      purpose: 'Atraer clientes en Lima',
    };
    const next = await w.management.revise(w.tenantA, id, { fromVersion: 1, configuration });
    expect(next.version).toBe(2);
    expect(next.configuration.purpose).toBe('Atraer clientes en Lima');
    expect((await w.repository.findVersion(w.orgA, id, 1))?.configuration.purpose).toBe(
      agent.configuration.purpose,
    );
    // A stale version is refused, as is adding a tool or an unknown skill.
    expect(
      await codeOf(() => w.management.revise(w.tenantA, id, { fromVersion: 1, configuration })),
    ).toBe('specialist_concurrency_conflict');
    expect(
      await codeOf(() =>
        w.management.revise(w.tenantA, id, {
          fromVersion: 2,
          configuration: {
            ...configuration,
            tools: [{ id: 'message_send', version: 1 }],
            permissions: [...configuration.permissions, 'conversation.send'],
          },
        }),
      ),
    ).toBe('invalid_specialist:tools.not_granted');
    // Even with the skill that grants it (SK-1), a revision never adds a tool that reaches out.
    expect(
      await codeOf(() =>
        w.management.revise(w.tenantA, id, {
          fromVersion: 2,
          configuration: {
            ...configuration,
            skills: [...configuration.skills, { id: 'conversation_reply', version: 1 }],
            tools: [
              { id: 'message_send', version: 2 },
              { id: 'conversation_handoff', version: 1 },
            ],
            permissions: [
              ...new Set([
                ...configuration.permissions,
                'conversation.read',
                'conversation.send',
                'conversation.manage',
              ]),
            ].sort(),
          },
        }),
      ),
    ).toBe('invalid_specialist:tools');
    expect(
      await codeOf(() =>
        w.management.revise(w.tenantA, id, {
          fromVersion: 2,
          configuration: { ...configuration, skills: [{ id: 'hacking', version: 1 }] },
        }),
      ),
    ).toBe('invalid_specialist:skills.unknown');
    // A skill's reads must stay listed, so eligibility checks them.
    expect(
      await codeOf(() =>
        w.management.revise(w.tenantA, id, {
          fromVersion: 2,
          configuration: { ...configuration, permissions: [] },
        }),
      ),
    ).toBe('invalid_specialist:permissions');
    expect(
      await codeOf(() => w.management.revise(w.tenantA, id, { fromVersion: 'x', configuration })),
    ).toBe('invalid_specialist:fromVersion');
    expect(
      w.audit
        .events()
        .filter((e) => e.action === 'specialist.version_created')
        .map((e) => e.targetVersion),
    ).toEqual([2]);
  });

  it('changes the status along the lifecycle and audits the transition', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'operations',
      displayName: 'Olga',
    });
    const id = agent.identity.id;
    const active = await w.management.setStatus(w.tenantA, id, { from: 'draft', to: 'active' });
    expect(active.status).toBe('active');
    expect(
      await codeOf(() => w.management.setStatus(w.tenantA, id, { from: 'draft', to: 'paused' })),
    ).toMatch(/^specialist_concurrency_conflict|^invalid_specialist_transition/);
    expect(
      await codeOf(() => w.management.setStatus(w.tenantA, id, { from: 'active', to: 'bogus' })),
    ).toMatch(/^invalid_specialist/);
    const event = w.audit.events().find((e) => e.action === 'specialist.status_changed');
    expect(event?.transition).toEqual({ from: 'draft', to: 'active' });
  });
});

describe('upgrading a skill (ADR-0084)', () => {
  /** An agent as it was before version 2: company_knowledge@1 and customer_follow_up@1. */
  async function legacy(w: Awaited<ReturnType<typeof world>>) {
    const agent = await w.management.create(w.tenantA, {
      templateId: 'finance',
      displayName: 'Fina',
    });
    return w.management.revise(w.tenantA, agent.identity.id, {
      fromVersion: 1,
      configuration: {
        ...agent.configuration,
        skills: [
          { id: 'company_knowledge', version: 1 },
          { id: 'finance_review', version: 1 },
          { id: 'customer_follow_up', version: 1 },
        ],
        permissions: [
          ...new Set([
            ...agent.configuration.permissions,
            'contact.read',
            'opportunity.read',
            'follow_up.read',
          ]),
        ].sort(),
      },
    });
  }

  it('moves one skill forward as a new version, assigning what it grants at one version', async () => {
    const w = await world();
    const agent = await legacy(w);
    const id = agent.identity.id;
    const next = await w.management.upgradeSkill(w.tenantA, id, {
      fromVersion: agent.version,
      skillId: 'customer_follow_up',
      version: 2,
    });
    expect(next.version).toBe(agent.version + 1);
    expect(next.configuration.skills).toContainEqual({ id: 'customer_follow_up', version: 2 });
    expect(next.configuration.skills).toContainEqual({ id: 'company_knowledge', version: 1 });
    expect(next.configuration.tools).toEqual([{ id: 'follow_up_schedule', version: 2 }]);
    expect(next.configuration.permissions).toContain('follow_up.manage');
    // The earlier version is kept as it was: the agent's past tasks read it.
    expect(
      (await w.repository.findVersion(w.orgA, id, agent.version))?.configuration.tools,
    ).toEqual([]);
    const events = w.audit.events().filter((e) => e.action === 'specialist.version_created');
    expect(events.at(-1)).toMatchObject({ targetVersion: next.version });
    // An action-only skill: nothing assigned, only the grant.
    const facts = await w.management.upgradeSkill(w.tenantA, id, {
      fromVersion: next.version,
      skillId: 'company_knowledge',
      version: 2,
    });
    expect(facts.configuration.tools).toEqual(next.configuration.tools);
  });

  it('refuses a skill the agent lacks, a version not newer, an unknown one, a stale agent and anyone but a person with specialist.manage', async () => {
    const w = await world();
    const agent = await legacy(w);
    const id = agent.identity.id;
    const up = (input: Record<string, unknown>, tenant = w.tenantA) =>
      codeOf(() => w.management.upgradeSkill(tenant, id, input));
    const v = agent.version;
    expect(await up({ fromVersion: v, skillId: 'pipeline_analysis', version: 1 })).toBe(
      'invalid_specialist:skillId',
    );
    expect(await up({ fromVersion: v, skillId: 'nope', version: 1 })).toBe(
      'invalid_specialist:version',
    );
    expect(await up({ fromVersion: v, skillId: 'customer_follow_up', version: 1 })).toBe(
      'invalid_specialist:version',
    );
    expect(await up({ fromVersion: v, skillId: 'customer_follow_up', version: 9 })).toBe(
      'invalid_specialist:version',
    );
    expect(await up({ fromVersion: v, skillId: 'customer_follow_up', version: 2, x: 1 })).toBe(
      'invalid_specialist:x',
    );
    expect(await up({ fromVersion: v - 1, skillId: 'customer_follow_up', version: 2 })).toBe(
      'specialist_concurrency_conflict',
    );
    expect(await up({ fromVersion: v, skillId: 'customer_follow_up', version: 2 }, w.tenantB)).toBe(
      'specialist_not_found',
    );
    const gia = await resolveTenant({ ...as(ALICE), actor: 'gia' }, w.orgA, w.tenancy);
    expect(await up({ fromVersion: v, skillId: 'customer_follow_up', version: 2 }, gia)).toBe(
      'permission_denied',
    );
    expect((await w.repository.find(w.orgA, id))?.version).toBe(v);
  });
});

describe('what an agent may do', () => {
  it('lists skills, tools and permissions, and says what is missing', async () => {
    const w = await world();
    const agent = await w.management.create(w.tenantA, {
      templateId: 'finance',
      displayName: 'Fabia',
    });
    const all = new Set<string>(ROLES.owner);
    const draft = agentCapabilities(agent, { skills: w.skills, tools: TOOLS, held: all });
    expect(draft.ready).toBe(false);
    expect(draft.problems).toEqual([{ kind: 'not_active', status: 'draft' }]);
    expect(draft.permissions.required).toEqual(['credits.read', 'knowledge.read', 'report.read']);

    const active = await w.management.setStatus(w.tenantA, agent.identity.id, {
      from: 'draft',
      to: 'active',
    });
    expect(agentCapabilities(active, { skills: w.skills, tools: TOOLS, held: all }).ready).toBe(
      true,
    );
    const without = agentCapabilities(active, {
      skills: w.skills,
      tools: TOOLS,
      held: new Set(['report.read', 'knowledge.read']),
    });
    expect(without.ready).toBe(false);
    expect(without.permissions.missing).toEqual(['credits.read']);
    expect(without.problems).toEqual([{ kind: 'permission_not_held', permission: 'credits.read' }]);
  });

  it('finds a skill whose tools the version lacks, and tools the catalogue does not know', () => {
    const skills = createSkillCatalogue();
    const found = agentCapabilities(
      {
        status: 'active',
        configuration: {
          skills: [{ id: 'conversation_reply', version: 1 }],
          tools: [
            { id: 'message_send', version: 1 },
            { id: 'web_search', version: 1 },
          ],
          permissions: [],
        },
      } as never,
      { skills, tools: TOOLS, held: new Set(['conversation.read', 'conversation.send']) },
    );
    // The skill grants the reply at versions 2 and 3 only (SK-1): version 1 is a person's.
    expect(found.problems).toEqual([
      { kind: 'skill_tool_not_assigned', skill: 'conversation_reply', tool: 'message_send' },
      {
        kind: 'skill_tool_not_assigned',
        skill: 'conversation_reply',
        tool: 'conversation_handoff',
      },
      { kind: 'tool_not_granted_by_skill', tool: 'message_send' },
      { kind: 'unknown_tool', tool: 'web_search' },
      { kind: 'tool_not_granted_by_skill', tool: 'web_search' },
    ]);
    expect(found.tools[0]).toEqual({
      id: 'message_send',
      version: 1,
      known: true,
      riskLevel: 'medium',
      approval: 'auto',
    });
  });
});
