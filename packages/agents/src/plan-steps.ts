import { promptLabel } from '@melonoffice/ai-gateway';
import type {
  Execution,
  ExecutionNode,
  OrganizationId,
  Plan,
  PlanStep,
  PlanVersion,
} from '@melonoffice/domain';
import type { AgentOutputStore, VerificationInput } from '@melonoffice/execution';
import { planStepOf, type PlanRepository } from '@melonoffice/planning';
import type { SkillCatalogue } from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import {
  AGENT_ANSWER_SCHEMA,
  AGENT_TASK_MAX_OUTPUT_TOKENS,
  AGENT_TASK_TYPE,
  agentTaskMessages,
  parseAgentAnswer,
  type AgentContextBlock,
  type AgentContextSource,
  type AgentTaskVerifier,
  type AgentTaskWork,
  type TaskSpecialists,
} from './work.js';
import { AGENT_TASK_PROMPT } from './prompts.js';

/**
 * How the runtime runs one step of an approved plan (WF-1, ADR-0070). A plan step is an agent
 * task whose request is the step itself: the same prompt, answer shape, model policy, Company
 * Brain context and verification as a task (ADR-0063), so a plan adds no second way to call a
 * model. What a step adds is the answers of the steps it depends on, as data. Nothing here acts:
 * a step answers, it calls no tool.
 */

/** A step's work: exactly what the stored plan version says, or nothing. */
interface StepFacts {
  readonly organizationId: OrganizationId;
  readonly version: PlanVersion;
  readonly step: PlanStep;
  /** The child executions of the plan's steps, by step id. */
  readonly children: ReadonlyMap<string, string>;
}

const organizationOfTenant = (tenant: TenantContext): OrganizationId | undefined =>
  isResolvedTenant(tenant) ? (tenant.organizationId as OrganizationId) : undefined;

/** The plan version this child was created for, from its own version snapshot. */
const planVersionOf = (execution: Execution, planId: string): number | undefined => {
  const ref = execution.versionSnapshot.components.find(
    (c) => c.kind === 'plan' && c.id === planId,
  );
  const version = ref === undefined ? NaN : Number(ref.version);
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
};

/**
 * The facts of a plan step's child execution, checked against the stored plan: the plan still
 * names this execution for this step, and the step is the specialist step of this agent.
 */
async function factsOf(
  plans: Pick<PlanRepository, 'find' | 'findVersion'>,
  tenant: TenantContext,
  execution: Execution,
): Promise<StepFacts | undefined> {
  const ref = planStepOf(execution);
  const organizationId = organizationOfTenant(tenant);
  if (ref === undefined || organizationId === undefined) return undefined;
  const pinned = planVersionOf(execution, ref.planId);
  const plan = await plans.find(organizationId, ref.planId);
  if (plan === undefined || pinned === undefined || plan.version !== pinned) return undefined;
  if (plan.executionId !== execution.parentExecutionId) return undefined;
  const version = await plans.findVersion(organizationId, plan.id, pinned);
  const step = version?.steps.find((s) => s.id === ref.stepId);
  if (
    version === undefined ||
    step?.kind !== 'specialist' ||
    step.specialist === undefined ||
    step.specialist.id !== execution.specialistId ||
    step.specialist.version !== execution.specialistVersion
  ) {
    return undefined;
  }
  const children = new Map(plan.delegations.map((d) => [d.stepId, d.executionId as string]));
  if (children.get(step.id) !== execution.id) return undefined;
  return { organizationId, version, step, children };
}

export interface PlanStepWorkOptions {
  readonly plans: Pick<PlanRepository, 'find' | 'findVersion'>;
  readonly specialists: TaskSpecialists;
  readonly skills: SkillCatalogue;
  readonly context: AgentContextSource;
  readonly outputs: Pick<AgentOutputStore, 'find'>;
  readonly describeSkill?: (id: string) => string;
}

/** The request a step's agent answers: the plan's objective and its own step, as data. */
export const planStepRequest = (version: PlanVersion, step: PlanStep): string =>
  `Plan objective: ${version.request.objective}\nYour step in this plan: ${step.label}`;

/**
 * The steps whose answers a step reads: the steps it depends on, looking through condition steps
 * (WF-4), which decide and have no answer of their own, to the steps they depend on. Each once, in
 * order. `undefined` when a step is missing from the version.
 */
export function answeringSteps(
  version: PlanVersion,
  step: PlanStep,
): readonly string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const before = version.steps.find((s) => s.id === id);
    if (before === undefined) return false;
    if (before.kind === 'condition') return before.dependsOn.every(visit);
    out.push(id);
    return true;
  };
  return step.dependsOn.every(visit) ? out : undefined;
}

/**
 * What a plan step's agent node works on. Anything missing (the plan, the step, the agent's
 * version, the answer of a step it depends on): nothing is asked of a model (`input_unavailable`).
 */
export function createPlanStepWork(options: PlanStepWorkOptions): AgentTaskWork {
  const { plans, specialists, skills, context, outputs } = options;
  const describe = options.describeSkill ?? ((id: string) => id.replace(/_/g, ' '));
  return Object.freeze({
    async needed() {
      return true;
    },
    async toolInput() {
      // A plan step in WF-1 has no tool node: plans with tool steps are refused before approval.
      return undefined;
    },
    async agentWork(tenant: TenantContext, execution: Execution, node: ExecutionNode) {
      const facts = await factsOf(plans, tenant, execution);
      if (facts === undefined || node.id !== facts.step.id || node.type !== 'agent') {
        return undefined;
      }
      const { organizationId, version, step } = facts;
      const specialistId = step.specialist?.id;
      if (specialistId === undefined) return undefined;
      const [agentVersion, agent] = await Promise.all([
        specialists.findVersion(organizationId, specialistId, step.specialist?.version ?? 0),
        specialists.find(organizationId, specialistId),
      ]);
      if (agentVersion === undefined || agent === undefined) return undefined;

      // The answers of the steps before this one, as data. One missing: nothing is invented.
      const answering = answeringSteps(version, step);
      if (answering === undefined) return undefined;
      const previous: AgentContextBlock[] = [];
      for (const id of answering) {
        const before = version.steps.find((s) => s.id === id);
        const child = facts.children.get(id);
        if (before === undefined || child === undefined) return undefined;
        const record = await outputs.find(tenant, child, id);
        const answer = record === undefined ? undefined : parseAgentAnswer(record.output);
        if (answer === undefined) return undefined;
        previous.push({ name: 'previous_step', text: `${before.label}: ${answer.answer}` });
      }

      const { configuration } = agentVersion;
      const known = configuration.skills
        .filter((s) => skills.resolve(s.id, s.version) !== undefined)
        .map((s) => ({ id: s.id as string, description: describe(s.id) }));
      const request = planStepRequest(version, step);
      const blocks = await context.read(tenant, { configuration, request });
      return {
        taskType: AGENT_TASK_TYPE,
        capability: 'text_generation',
        requirements: { structuredOutput: true },
        messages: agentTaskMessages(
          { name: agent.identity.displayName, configuration },
          known,
          [...blocks, ...previous],
          request,
        ),
        outputModality: 'text',
        maxOutputTokens: AGENT_TASK_MAX_OUTPUT_TOKENS,
        outputSchema: AGENT_ANSWER_SCHEMA,
        sensitivity: 'confidential',
        metadata: {
          skills: known.length,
          previousSteps: previous.length,
          prompt: promptLabel(AGENT_TASK_PROMPT),
        },
      } satisfies Awaited<ReturnType<AgentTaskWork['agentWork']>>;
    },
  });
}

/**
 * Checks a finished plan step as a task is checked (`output_schema`): its answer is kept and has
 * the answer's shape. The result is that answer.
 */
export function createPlanStepVerifier(options: {
  readonly outputs: Pick<AgentOutputStore, 'find'>;
}): AgentTaskVerifier {
  const { outputs } = options;
  return Object.freeze({
    async verify(tenant: TenantContext, execution: Execution) {
      const ref = planStepOf(execution);
      if (ref === undefined) return undefined;
      const node = execution.nodes.find((n) => n.id === ref.stepId);
      if (node?.status !== 'completed' || node.type !== 'agent') return undefined;
      const record = await outputs.find(tenant, execution.id, node.id);
      const passed = record !== undefined && parseAgentAnswer(record.output) !== undefined;
      const verification: VerificationInput = {
        correlationId: `step-${execution.id}`,
        nodes: [
          {
            nodeId: node.id,
            policy: 'output_schema',
            checks: [
              {
                code: 'agent_answer_valid',
                result: passed ? 'passed' : 'failed',
                evidence: node.output ?? { type: 'execution_node', id: node.id },
              },
            ],
          },
        ],
      };
      return {
        verification,
        ...(passed ? { result: { type: 'agent_output', id: `${execution.id}:${node.id}` } } : {}),
      };
    },
  });
}

/** One step of a plan as a person reads its result (ADR-0117). */
export interface PlanStepResult {
  readonly stepId: string;
  readonly label: string;
  readonly specialistId: string | null;
  readonly departmentId: string | null;
  /** Its execution's status, or `not_started` when it has none yet. */
  readonly status: string;
  /** The agent's verified answer, once its step completed. */
  readonly answer: string | null;
}

export interface PlanResults {
  readonly planId: string;
  readonly status: string;
  readonly steps: readonly PlanStepResult[];
}

/**
 * What the agents of a plan answered (ADR-0117), read as the person: the plan with `plan.read`,
 * each step's execution with `execution.read`, and only a completed step's verified answer. GIA
 * summarizes this for the person; nothing here runs or changes anything.
 */
export async function readPlanResults(
  tenant: TenantContext,
  planId: string,
  ports: {
    readonly plans: {
      get(tenant: TenantContext, id: string): Promise<Plan>;
      getVersion(tenant: TenantContext, id: string, version: number): Promise<PlanVersion>;
    };
    readonly executions: { get(tenant: TenantContext, id: string): Promise<Execution> };
    readonly outputs: Pick<AgentOutputStore, 'find'>;
  },
): Promise<PlanResults> {
  const plan = await ports.plans.get(tenant, planId);
  const version = await ports.plans.getVersion(tenant, plan.id, plan.version);
  const children = new Map(plan.delegations.map((d) => [d.stepId, d.executionId]));
  const steps = await Promise.all(
    version.steps
      .filter((s) => s.kind === 'specialist')
      .map(async (step): Promise<PlanStepResult> => {
        const childId = children.get(step.id);
        const child =
          childId === undefined
            ? undefined
            : await ports.executions.get(tenant, childId).catch(() => undefined);
        const node = child?.nodes.find((n) => n.id === step.id);
        const record =
          child?.status === 'completed' && node?.status === 'completed'
            ? await ports.outputs.find(tenant, child.id, step.id)
            : undefined;
        return Object.freeze({
          stepId: step.id,
          label: step.label,
          specialistId: step.specialist?.id ?? null,
          departmentId: step.specialist?.departmentId ?? null,
          status: child?.status ?? 'not_started',
          answer: record === undefined ? null : (parseAgentAnswer(record.output)?.answer ?? null),
        });
      }),
  );
  return Object.freeze({ planId: plan.id, status: plan.status, steps: Object.freeze(steps) });
}
