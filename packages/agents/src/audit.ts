import { figureContradictions, type FigureFact } from '@melonoffice/brain';
import type {
  Department,
  Plan,
  PlanVersion,
  Specialist,
  Workflow,
  WorkflowVersion,
} from '@melonoffice/domain';
import {
  agentReadiness,
  grantsOf,
  skillAllowedIn,
  toolKey,
  type ReadinessProblem,
  type SkillCatalogue,
  type ToolLookup,
} from '@melonoffice/specialists';
import { AGENT_FOLLOW_UP_TOOL } from './proposals.js';

/**
 * The review of an organization's agents (G-1, ADR-0131): what would make an agent, a workflow or
 * an approved plan fail, or work from outdated or contradictory instructions, found before it runs.
 * Read-only and deterministic: no model is asked, nothing is charged, and nothing is changed. Each
 * finding says what was found, the evidence, how serious it is and what a person can do. A person
 * decides; the review never acts.
 *
 * It adds no rule of its own: it runs the checks the engines already make (activation readiness,
 * eligibility, workflow binding, plan delegation) over everything at once, and compares agents'
 * instructions with Company Brain's figures.
 */

/** How serious a finding is. `critical`: work will fail or act on wrong data. */
export type AuditSeverity = 'info' | 'warning' | 'critical';

/** What a person can do about a finding, as a stable code a screen explains. */
export type AuditRecommendation =
  | 'fix_agent_configuration'
  | 'activate_department'
  | 'run_agent_policy_migration'
  | 'upgrade_skill'
  | 'review_instructions'
  | 'activate_or_assign_agent'
  | 'review_workflow'
  | 'replan';

export interface AuditFinding {
  readonly code: string;
  readonly severity: AuditSeverity;
  readonly subject: {
    readonly type: 'agent' | 'workflow' | 'plan';
    readonly id: string;
    readonly version: number;
    /** The agent's or workflow's name, so a person can tell which one it is. */
    readonly name?: string;
  };
  /** What was found, as plain values: codes, ids, versions and figures. Never free text. */
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly recommendation: AuditRecommendation;
}

/** Checks a review could not make, and why: the reader may not read what they need. */
export type AuditSkipped = 'company_brain' | 'workflows' | 'plans';

export interface AgentAudit {
  readonly findings: readonly AuditFinding[];
  readonly skipped: readonly AuditSkipped[];
  /** How many of each were reviewed. */
  readonly reviewed: {
    readonly agents: number;
    readonly workflows: number;
    readonly plans: number;
  };
}

/** A model policy agents made before the Harness still name, and the one that replaces it. */
export interface OutdatedPolicy {
  readonly from: { readonly id: string; readonly version: number };
  readonly to: { readonly id: string; readonly version: number };
}

export interface AgentAuditFacts {
  readonly agents: readonly Specialist[];
  readonly departments: readonly Department[];
  readonly skills: SkillCatalogue;
  readonly tools: ToolLookup;
  /** Whether a tool version is one an agent's model may ask for mid-task (ADR-0103). */
  readonly modelTool: (id: string, version: number) => boolean;
  /** The permissions of the person reading the review: an agent never acts beyond them. */
  readonly held: ReadonlySet<string>;
  readonly outdatedPolicies: readonly OutdatedPolicy[];
  /** Company Brain's facts with a figure. Absent: the reader may not read them (skipped). */
  readonly figures?: readonly FigureFact[];
  /** Active workflows with their current version. Absent: skipped. */
  readonly workflows?: readonly {
    readonly workflow: Workflow;
    readonly version: WorkflowVersion;
  }[];
  /** Plans with their current version. Absent: skipped. */
  readonly plans?: readonly { readonly plan: Plan; readonly version: PlanVersion }[];
}

/** Plans whose specialist steps have not been handed to their agents yet. */
const UNDELEGATED: ReadonlySet<Plan['status']> = new Set([
  'ready',
  'approval_required',
  'approved',
]);

const finding = (f: AuditFinding): AuditFinding =>
  Object.freeze({ ...f, evidence: Object.freeze({ ...f.evidence }) });

/** A readiness problem as evidence: its kind and the one thing it names. */
function problemEvidence(problem: ReadinessProblem): Record<string, string> {
  const { kind, ...rest } = problem;
  return {
    problem: kind,
    ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
  };
}

const READINESS_RECOMMENDATION: Partial<Record<ReadinessProblem['kind'], AuditRecommendation>> = {
  department_not_active: 'activate_department',
};

export function auditAgents(facts: AgentAuditFacts): AgentAudit {
  const findings: AuditFinding[] = [];
  const skipped: AuditSkipped[] = [];
  const departments = new Map(facts.departments.map((d) => [d.id as string, d]));
  const agents = facts.agents.filter((a) => a.status !== 'archived');
  const byId = new Map(agents.map((a) => [a.identity.id as string, a]));

  for (const agent of agents) {
    const { configuration } = agent;
    const subject = {
      type: 'agent' as const,
      id: agent.identity.id,
      version: agent.version,
      name: agent.identity.displayName,
    };
    const department = departments.get(configuration.departmentId);
    const working = agent.status === 'active';

    // 1. What activation checks (AE-4): for a working agent its tasks would fail; for one that is
    //    not working yet, it could not be switched on.
    const readiness = agentReadiness(agent, {
      skills: facts.skills,
      tools: facts.tools,
      held: facts.held,
      departmentActive: department?.status === 'active',
    });
    for (const problem of readiness.problems) {
      findings.push(
        finding({
          code: 'agent_not_ready',
          severity: working ? 'critical' : 'info',
          subject,
          evidence: { status: agent.status, ...problemEvidence(problem) },
          recommendation: READINESS_RECOMMENDATION[problem.kind] ?? 'fix_agent_configuration',
        }),
      );
    }

    // 2. A model policy from before the Harness (ADR-0100): it pins one model until the agent
    //    policy migration moves it.
    const model = configuration.policies.model;
    const outdated = facts.outdatedPolicies.find(
      (p) => model?.id === p.from.id && model.version === p.from.version,
    );
    if (outdated !== undefined) {
      findings.push(
        finding({
          code: 'model_policy_outdated',
          severity: 'warning',
          subject,
          evidence: {
            policy: `${outdated.from.id}@${outdated.from.version}`,
            replacement: `${outdated.to.id}@${outdated.to.version}`,
          },
          recommendation: 'run_agent_policy_migration',
        }),
      );
    }

    // 3. A newer version of a skill it has, that its department may take (ADR-0084).
    for (const held of configuration.skills) {
      const newest = Math.max(
        ...facts.skills
          .list()
          .filter((s) => s.id === held.id && skillAllowedIn(s, configuration.departmentId))
          .map((s) => s.version),
      );
      if (newest > held.version) {
        findings.push(
          finding({
            code: 'skill_upgrade_available',
            severity: 'info',
            subject,
            evidence: { skill: held.id, from: held.version, to: newest },
            recommendation: 'upgrade_skill',
          }),
        );
      }
    }

    // 4. Tools its model may ask for that it is never offered: a task with the follow-up step of
    //    ADR-0084 (`follow_up_schedule@2`) is offered no tools (ADR-0103).
    const schedules = configuration.tools.some(
      (t) => t.id === AGENT_FOLLOW_UP_TOOL.id && t.version === AGENT_FOLLOW_UP_TOOL.version,
    );
    const unreachable = configuration.tools.filter((t) => facts.modelTool(t.id, t.version));
    if (schedules && unreachable.length > 0) {
      findings.push(
        finding({
          code: 'model_tools_unreachable',
          severity: 'warning',
          subject,
          evidence: {
            tools: unreachable.map((t) => toolKey(t.id, t.version)).join(','),
            blockedBy: toolKey(AGENT_FOLLOW_UP_TOOL.id, AGENT_FOLLOW_UP_TOOL.version),
          },
          recommendation: 'upgrade_skill',
        }),
      );
    }

    // 5. What the company tells its conversation agent against what Company Brain records.
    const instructions = configuration.conversation?.instructions;
    if (instructions !== undefined && facts.figures !== undefined) {
      for (const c of figureContradictions(instructions, facts.figures)) {
        findings.push(
          finding({
            code: 'instructions_contradict_company_brain',
            severity: c.confirmed ? 'critical' : 'warning',
            subject,
            evidence: {
              fact: c.factId,
              label: c.label,
              recorded: c.recorded,
              stated: c.stated,
              confirmed: c.confirmed,
            },
            recommendation: 'review_instructions',
          }),
        );
      }
    }
  }
  if (facts.figures === undefined) skipped.push('company_brain');

  // 6. Workflows: each assigned step binds, when the workflow runs, to an active agent with that
  //    main role in an active department of that type; its tool steps need that agent's tools.
  const departmentType = (a: Specialist): string | undefined => {
    const d = departments.get(a.configuration.departmentId);
    return d?.origin.kind === 'catalog' ? d.origin.typeId : undefined;
  };
  for (const { workflow, version } of facts.workflows ?? []) {
    if (workflow.status !== 'active') continue;
    const subject = {
      type: 'workflow' as const,
      id: workflow.id,
      version: version.version,
      name: version.name,
    };
    const boundTo = new Map<string, Specialist | undefined>();
    for (const step of version.steps) {
      if (step.assignee === undefined) continue;
      const { departmentTypeId, roleId } = step.assignee;
      const candidates = facts.agents
        .filter(
          (a) => a.configuration.mainRoleId === roleId && departmentType(a) === departmentTypeId,
        )
        .sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1));
      const working = candidates.find(
        (a) =>
          a.status === 'active' &&
          departments.get(a.configuration.departmentId)?.status === 'active',
      );
      boundTo.set(step.id, working);
      if (working === undefined) {
        findings.push(
          finding({
            code: 'workflow_assignee_unavailable',
            severity: 'critical',
            subject,
            evidence: {
              step: step.id,
              departmentType: departmentTypeId,
              role: roleId,
              agentsNotWorking: candidates.filter((a) => a.status !== 'archived').length,
            },
            recommendation: 'activate_or_assign_agent',
          }),
        );
      }
    }
    for (const step of version.steps) {
      if (step.tool === undefined || step.performedBy === undefined) continue;
      const agent = boundTo.get(step.performedBy);
      if (agent === undefined) continue;
      const has = agent.configuration.tools.some(
        (t) => t.id === step.tool?.id && t.version === step.tool.version,
      );
      if (!has) {
        findings.push(
          finding({
            code: 'workflow_tool_missing',
            severity: 'critical',
            subject,
            evidence: {
              step: step.id,
              tool: toolKey(step.tool.id, step.tool.version),
              agent: agent.identity.id,
              agentVersion: agent.version,
            },
            recommendation: 'review_workflow',
          }),
        );
      }
    }
  }
  if (facts.workflows === undefined) skipped.push('workflows');

  // 7. Plans not yet handed to their agents: delegation takes only an active agent at the exact
  //    version the plan names (ADR-0025 eligibility, ADR-0070).
  for (const { plan, version } of facts.plans ?? []) {
    if (!UNDELEGATED.has(plan.status) || plan.delegations.length > 0) continue;
    const subject = { type: 'plan' as const, id: plan.id, version: version.version };
    for (const step of version.steps) {
      if (step.specialist === undefined) continue;
      const agent = byId.get(step.specialist.id);
      if (agent === undefined || agent.status !== 'active') {
        findings.push(
          finding({
            code: 'plan_agent_not_active',
            severity: plan.status === 'approved' ? 'critical' : 'warning',
            subject,
            evidence: {
              step: step.id,
              agent: step.specialist.id,
              status: agent?.status ?? 'archived',
              planStatus: plan.status,
            },
            recommendation: 'replan',
          }),
        );
      } else if (agent.version !== step.specialist.version) {
        findings.push(
          finding({
            code: 'plan_agent_version_changed',
            severity: plan.status === 'approved' ? 'critical' : 'warning',
            subject,
            evidence: {
              step: step.id,
              agent: agent.identity.id,
              planned: step.specialist.version,
              current: agent.version,
              planStatus: plan.status,
            },
            recommendation: 'replan',
          }),
        );
      }
    }
  }
  if (facts.plans === undefined) skipped.push('plans');

  const order: Record<AuditSeverity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return Object.freeze({
    findings: Object.freeze(findings),
    skipped: Object.freeze(skipped),
    reviewed: Object.freeze({
      agents: agents.length,
      workflows: (facts.workflows ?? []).filter((w) => w.workflow.status === 'active').length,
      plans: (facts.plans ?? []).filter(
        (p) => UNDELEGATED.has(p.plan.status) && p.plan.delegations.length === 0,
      ).length,
    }),
  });
}

/** A workflow step an upgrade would leave without its tool. */
export interface UpgradeBreak {
  readonly workflowId: string;
  readonly name: string;
  readonly step: string;
  readonly tool: string;
}

/**
 * What moving an agent's skill to a newer version would take away, before a person confirms it
 * (G-2, ADR-0132): the tools the agent would no longer have (exactly as `upgradeSkill` keeps them)
 * and the steps of active workflows that this kind of agent performs and that need one of them.
 * A warning, never a refusal: the person decides.
 */
export function upgradeImpact(
  facts: ImpactFacts & { readonly skillId: string; readonly toVersion: number },
): SkillChangeImpact {
  return skillChangeImpact(
    facts,
    facts.agent.configuration.skills.map((s) =>
      s.id === facts.skillId ? { id: s.id, version: facts.toVersion } : s,
    ),
  );
}

/**
 * What removing one of an agent's skills would take away (ADR-0141), the same warning as an
 * upgrade's (G-2): the tools no other skill of the agent grants, and the steps of active
 * workflows that need them.
 */
export function removalImpact(
  facts: ImpactFacts & { readonly skillId: string },
): SkillChangeImpact {
  return skillChangeImpact(
    facts,
    facts.agent.configuration.skills.filter((s) => s.id !== facts.skillId),
  );
}

interface ImpactFacts {
  readonly agent: Specialist;
  readonly skills: SkillCatalogue;
  readonly departments: readonly Department[];
  readonly workflows?: readonly {
    readonly workflow: Workflow;
    readonly version: WorkflowVersion;
  }[];
}

export interface SkillChangeImpact {
  readonly removes: readonly string[];
  readonly breaks: readonly UpgradeBreak[];
}

function skillChangeImpact(
  facts: ImpactFacts,
  nextSkills: Specialist['configuration']['skills'],
): SkillChangeImpact {
  const { configuration } = facts.agent;
  const granted = grantsOf(nextSkills, facts.skills).tools;
  const removes = configuration.tools
    .map((t) => toolKey(t.id, t.version))
    .filter((key) => !granted.has(key));
  const department = facts.departments.find((d) => d.id === configuration.departmentId);
  const typeId = department?.origin.kind === 'catalog' ? department.origin.typeId : undefined;
  const breaks: UpgradeBreak[] = [];
  if (removes.length > 0 && typeId !== undefined) {
    const gone = new Set(removes);
    for (const { workflow, version } of facts.workflows ?? []) {
      if (workflow.status !== 'active') continue;
      const performs = new Set(
        version.steps
          .filter(
            (s) =>
              s.assignee?.departmentTypeId === typeId &&
              s.assignee.roleId === configuration.mainRoleId,
          )
          .map((s) => s.id as string),
      );
      for (const step of version.steps) {
        if (step.tool === undefined || step.performedBy === undefined) continue;
        if (!performs.has(step.performedBy)) continue;
        const key = toolKey(step.tool.id, step.tool.version);
        if (gone.has(key)) {
          breaks.push({ workflowId: workflow.id, name: version.name, step: step.id, tool: key });
        }
      }
    }
  }
  return Object.freeze({ removes: Object.freeze(removes), breaks: Object.freeze(breaks) });
}
