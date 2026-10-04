import type {
  Department,
  DepartmentId,
  OrganizationId,
  Plan,
  PlanVersion,
  Specialist,
  SpecialistConfiguration,
  SpecialistStatus,
  Workflow,
  WorkflowVersion,
} from '@melonoffice/domain';
import { createSkillCatalogue, type ToolLookup } from '@melonoffice/specialists';
import { createToolRegistry, isModelInvocable, TOOL_CATALOGUE } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import {
  auditAgents,
  moveImpact,
  removalImpact,
  upgradeImpact,
  type AgentAuditFacts,
  type AuditFinding,
} from './index.js';

/** The review of an organization's agents (G-1, ADR-0131): pure, deterministic, read-only. */

const ORG = '44444444-4444-4444-8444-444444444444' as OrganizationId;
const AT = '2026-10-03T12:00:00.000Z';
const registry = createToolRegistry(TOOL_CATALOGUE);
const tools: ToolLookup = (id, version) => {
  const found = registry.resolve(id, version)?.version;
  return found === undefined
    ? undefined
    : {
        riskLevel: found.riskLevel,
        approval: found.approvalPolicy,
        permissions: found.permissions,
        active: true,
      };
};
const ALL = new Set([
  'knowledge.read',
  'knowledge.propose',
  'contact.read',
  'opportunity.read',
  'follow_up.read',
  'follow_up.manage',
  'report.read',
  'conversation.read',
]);

const department = (type: string, status: Department['status'] = 'active'): Department => ({
  id: `${ORG}_${type}` as DepartmentId,
  organizationId: ORG,
  origin: { kind: 'catalog', typeId: type as never, typeVersion: 1 },
  status,
  revision: 1,
  createdAt: AT as never,
  updatedAt: AT as never,
});

/** A commercial agent as its template makes it, with what each test changes. */
function agent(
  id: string,
  over: {
    readonly status?: SpecialistStatus;
    readonly version?: number;
    readonly configuration?: Partial<SpecialistConfiguration>;
  } = {},
): Specialist {
  return {
    identity: { id, organizationId: ORG, createdAt: AT, createdBy: 'u' } as never,
    organizationId: ORG,
    status: over.status ?? 'active',
    version: over.version ?? 2,
    revision: 1,
    updatedAt: AT as never,
    configuration: {
      departmentId: `${ORG}_sales` as DepartmentId,
      mainRoleId: 'commercial_agent' as never,
      roleVersion: 1,
      capabilities: [],
      skills: [
        { id: 'company_knowledge', version: 3 },
        { id: 'customer_follow_up', version: 3 },
        { id: 'pipeline_analysis', version: 2 },
      ] as never,
      tools: [
        { id: 'knowledge_search', version: 1 },
        { id: 'follow_up_schedule', version: 3 },
        { id: 'customer_records_summary', version: 1 },
      ] as never,
      permissions: [
        'contact.read',
        'follow_up.manage',
        'follow_up.read',
        'knowledge.read',
        'opportunity.read',
        'report.read',
      ],
      policies: { model: { id: 'agent_task', version: 2 } } as never,
      ...over.configuration,
    },
  };
}

const facts = (over: Partial<AgentAuditFacts> = {}): AgentAuditFacts => ({
  agents: [],
  departments: [department('sales'), department('research')],
  skills: createSkillCatalogue(),
  tools,
  modelTool: (id, version) => {
    const found = registry.resolve(id, version)?.version;
    return found !== undefined && isModelInvocable(found);
  },
  held: ALL,
  outdatedPolicies: [
    { from: { id: 'agent_task', version: 1 }, to: { id: 'agent_task', version: 2 } },
  ],
  figures: [],
  workflows: [],
  plans: [],
  ...over,
});

const codes = (findings: readonly AuditFinding[]) =>
  findings.map((f) => `${f.subject.type}:${f.subject.id}:${f.code}:${f.severity}`);

describe('auditAgents (G-1, ADR-0131)', () => {
  it('a well-configured, up-to-date agent has nothing to report', () => {
    const audit = auditAgents(facts({ agents: [agent('a1')] }));
    expect(audit).toEqual({
      findings: [],
      skipped: [],
      reviewed: { agents: 1, workflows: 0, plans: 0 },
    });
  });

  it('finds the model policy from before the Harness, and says the migration moves it', () => {
    const old = agent('a1', {
      configuration: { policies: { model: { id: 'agent_task', version: 1 } } as never },
    });
    expect(auditAgents(facts({ agents: [old] })).findings).toEqual([
      {
        code: 'model_policy_outdated',
        severity: 'warning',
        subject: { type: 'agent', id: 'a1', version: 2 },
        evidence: { policy: 'agent_task@1', replacement: 'agent_task@2' },
        recommendation: 'run_agent_policy_migration',
      },
    ]);
  });

  it('offers newer skill versions, and says when its model tools never reach it', () => {
    // As the commercial template makes it, moved to company_knowledge@3 only.
    const lucia = agent('a1', {
      configuration: {
        skills: [
          { id: 'company_knowledge', version: 3 },
          { id: 'customer_follow_up', version: 2 },
          { id: 'pipeline_analysis', version: 2 },
        ] as never,
        tools: [
          { id: 'follow_up_schedule', version: 2 },
          { id: 'knowledge_search', version: 1 },
          { id: 'customer_records_summary', version: 1 },
        ] as never,
      },
    });
    const { findings } = auditAgents(facts({ agents: [lucia] }));
    expect(findings).toEqual([
      {
        code: 'model_tools_unreachable',
        severity: 'warning',
        subject: { type: 'agent', id: 'a1', version: 2 },
        evidence: { tools: 'knowledge_search@1', blockedBy: 'follow_up_schedule@2' },
        recommendation: 'upgrade_skill',
      },
      {
        code: 'skill_upgrade_available',
        severity: 'info',
        subject: { type: 'agent', id: 'a1', version: 2 },
        evidence: { skill: 'customer_follow_up', from: 2, to: 3 },
        recommendation: 'upgrade_skill',
      },
    ]);
    // A research agent is never offered customer_follow_up@3, which is for Comercial only.
    const iris = agent('a2', {
      configuration: {
        departmentId: `${ORG}_research` as DepartmentId,
        skills: [{ id: 'customer_follow_up', version: 2 }] as never,
        tools: [{ id: 'follow_up_schedule', version: 2 }] as never,
      },
    });
    expect(auditAgents(facts({ agents: [iris] })).findings).toEqual([]);
  });

  it('finds what would stop a working agent, and only notes it for one not working yet', () => {
    const broken = { configuration: { skills: [] as never, tools: [] as never } };
    const audit = auditAgents(
      facts({
        agents: [agent('a1', broken), agent('a2', { ...broken, status: 'draft' })],
        departments: [department('sales', 'paused')],
      }),
    );
    expect(codes(audit.findings)).toEqual([
      'agent:a1:agent_not_ready:critical',
      'agent:a1:agent_not_ready:critical',
      'agent:a2:agent_not_ready:info',
      'agent:a2:agent_not_ready:info',
    ]);
    expect(audit.findings.map((f) => [f.evidence.problem, f.recommendation])).toEqual([
      ['no_skills', 'fix_agent_configuration'],
      ['department_not_active', 'activate_department'],
      ['no_skills', 'fix_agent_configuration'],
      ['department_not_active', 'activate_department'],
    ]);
  });

  it('compares a conversation agent’s instructions with Company Brain’s figures', () => {
    const replies = agent('a1', {
      configuration: {
        conversation: {
          instructions: 'Saluda. El Combo Familiar cuesta S/ 30. El Pollo entero, S/ 60.',
          channels: ['whatsapp'],
          autonomy: 'supervised',
          maxRepliesPerConversation: 5,
        } as never,
      },
    });
    const figures = [
      {
        id: 'k1',
        label: 'Combo Familiar',
        value: { type: 'money' as const, amountMinor: 2500, currency: 'PEN' },
        confirmed: true,
      },
      {
        id: 'k2',
        label: 'Pollo entero',
        value: { type: 'money' as const, amountMinor: 6000, currency: 'PEN' },
        confirmed: true,
      },
    ];
    expect(auditAgents(facts({ agents: [replies], figures })).findings).toEqual([
      {
        code: 'instructions_contradict_company_brain',
        severity: 'critical',
        subject: { type: 'agent', id: 'a1', version: 2 },
        evidence: {
          fact: 'k1',
          label: 'Combo Familiar',
          recorded: 'PEN 25.00',
          stated: 's/ 30',
          confirmed: true,
        },
        recommendation: 'review_instructions',
      },
    ]);
    // An unconfirmed fact is a warning: the instructions may be the right ones.
    const unconfirmed = figures.map((f) => ({ ...f, confirmed: false }));
    expect(
      auditAgents(facts({ agents: [replies], figures: unconfirmed })).findings.map(
        (f) => f.severity,
      ),
    ).toEqual(['warning']);
  });

  it('finds workflow steps no working agent can take, and tools the bound agent lacks', () => {
    const workflow = {
      id: 'w1',
      organizationId: ORG,
      status: 'active',
      version: 1,
    } as unknown as Workflow;
    const version = {
      workflowId: 'w1',
      version: 1,
      steps: [
        {
          id: 's1',
          kind: 'specialist',
          assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
        },
        {
          id: 's2',
          kind: 'tool',
          performedBy: 's1',
          tool: { id: 'follow_up_schedule', version: 2 },
        },
      ],
    } as unknown as WorkflowVersion;
    const run = (agents: Specialist[]) =>
      codes(auditAgents(facts({ agents, workflows: [{ workflow, version }] })).findings);
    // A working agent without the tool the workflow's tool step needs.
    expect(run([agent('a1')])).toEqual(['workflow:w1:workflow_tool_missing:critical']);
    // With it, nothing.
    const withTool = agent('a1', {
      configuration: {
        skills: [
          { id: 'company_knowledge', version: 3 },
          { id: 'customer_follow_up', version: 2 },
        ] as never,
        tools: [{ id: 'follow_up_schedule', version: 2 }] as never,
      },
    });
    expect(run([withTool]).filter((c) => c.startsWith('workflow'))).toEqual([]);
    // Only a paused one: the step cannot be assigned.
    const audit = auditAgents(
      facts({ agents: [agent('a1', { status: 'paused' })], workflows: [{ workflow, version }] }),
    );
    expect(audit.findings).toEqual([
      {
        code: 'workflow_assignee_unavailable',
        severity: 'critical',
        subject: { type: 'workflow', id: 'w1', version: 1 },
        evidence: {
          step: 's1',
          departmentType: 'sales',
          role: 'commercial_agent',
          agentsNotWorking: 1,
        },
        recommendation: 'activate_or_assign_agent',
      },
    ]);
    // A paused workflow is not reviewed.
    const paused = { ...workflow, status: 'paused' } as Workflow;
    expect(run.length).toBe(1);
    expect(
      auditAgents(facts({ agents: [], workflows: [{ workflow: paused, version }] })).reviewed
        .workflows,
    ).toBe(0);
  });

  it('finds plans not yet handed out whose agent stopped working or changed version', () => {
    const plan = (status: Plan['status'], delegations: unknown[] = []) =>
      ({
        id: `p_${status}`,
        organizationId: ORG,
        status,
        version: 1,
        delegations,
      }) as unknown as Plan;
    const version = {
      version: 1,
      steps: [
        {
          id: 's1',
          kind: 'specialist',
          specialist: { id: 'a1', version: 1, departmentId: `${ORG}_sales` },
        },
      ],
    } as unknown as PlanVersion;
    const plans = [
      { plan: plan('approved'), version },
      { plan: plan('approval_required'), version },
      // Already handed out, or finished: its children run with the version they took.
      { plan: plan('approved', [{ stepId: 's1' }]), version },
      { plan: plan('completed'), version },
    ];
    expect(codes(auditAgents(facts({ agents: [agent('a1')], plans })).findings)).toEqual([
      'plan:p_approved:plan_agent_version_changed:critical',
      'plan:p_approval_required:plan_agent_version_changed:warning',
    ]);
    const paused = auditAgents(
      facts({ agents: [agent('a1', { status: 'paused', version: 1 })], plans }),
    );
    expect(codes(paused.findings)).toEqual([
      'plan:p_approved:plan_agent_not_active:critical',
      'plan:p_approval_required:plan_agent_not_active:warning',
    ]);
    expect(paused.reviewed.plans).toBe(2);
  });

  it('says which checks it could not make, and never reviews archived agents', () => {
    const audit = auditAgents({
      ...facts({ agents: [agent('a1', { status: 'archived', configuration: { skills: [] } })] }),
      figures: undefined,
      workflows: undefined,
      plans: undefined,
    } as never);
    expect(audit).toEqual({
      findings: [],
      skipped: ['company_brain', 'workflows', 'plans'],
      reviewed: { agents: 0, workflows: 0, plans: 0 },
    });
  });
});

describe('upgradeImpact (G-2, ADR-0132)', () => {
  const workflow = {
    id: 'w1',
    organizationId: ORG,
    status: 'active',
    version: 1,
  } as unknown as Workflow;
  const version = {
    workflowId: 'w1',
    version: 1,
    name: 'Seguimiento semanal',
    steps: [
      {
        id: 's1',
        kind: 'specialist',
        assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
      },
      { id: 's2', kind: 'tool', performedBy: 's1', tool: { id: 'follow_up_schedule', version: 2 } },
    ],
  } as unknown as WorkflowVersion;
  const onTwo = agent('a1', {
    configuration: {
      skills: [
        { id: 'company_knowledge', version: 3 },
        { id: 'customer_follow_up', version: 2 },
      ] as never,
      tools: [{ id: 'follow_up_schedule', version: 2 }] as never,
    },
  });
  const base = {
    agent: onTwo,
    skillId: 'customer_follow_up',
    toVersion: 3,
    skills: createSkillCatalogue(),
    departments: [department('sales')],
  };

  it('names the tools an upgrade takes away and the workflow steps that need them', () => {
    expect(upgradeImpact({ ...base, workflows: [{ workflow, version }] })).toEqual({
      removes: ['follow_up_schedule@2'],
      breaks: [
        { workflowId: 'w1', name: 'Seguimiento semanal', step: 's2', tool: 'follow_up_schedule@2' },
      ],
    });
  });

  it('ignores paused workflows, other kinds of agents, and unread workflows', () => {
    const paused = { ...workflow, status: 'paused' } as unknown as Workflow;
    expect(upgradeImpact({ ...base, workflows: [{ workflow: paused, version }] }).breaks).toEqual(
      [],
    );
    const research = agent('a2', {
      configuration: { ...onTwo.configuration, departmentId: `${ORG}_research` as DepartmentId },
    });
    expect(
      upgradeImpact({
        ...base,
        agent: research,
        departments: [department('research')],
        workflows: [{ workflow, version }],
      }).breaks,
    ).toEqual([]);
    expect(upgradeImpact(base)).toEqual({ removes: ['follow_up_schedule@2'], breaks: [] });
  });

  it('names the workflows its kind of agent works in before it moves (ADR-0141)', () => {
    expect(moveImpact({ ...base, workflows: [{ workflow, version }] })).toEqual([
      { workflowId: 'w1', name: 'Seguimiento semanal' },
    ]);
    const paused = { ...workflow, status: 'paused' } as unknown as Workflow;
    expect(moveImpact({ ...base, workflows: [{ workflow: paused, version }] })).toEqual([]);
    expect(moveImpact(base)).toEqual([]);
  });

  it('warns the same way before a skill is removed (ADR-0141)', () => {
    const workflows = [{ workflow, version }];
    expect(removalImpact({ ...base, workflows })).toEqual({
      removes: ['follow_up_schedule@2'],
      breaks: [
        { workflowId: 'w1', name: 'Seguimiento semanal', step: 's2', tool: 'follow_up_schedule@2' },
      ],
    });
    expect(removalImpact({ ...base, skillId: 'company_knowledge', workflows })).toEqual({
      removes: [],
      breaks: [],
    });
  });
});
