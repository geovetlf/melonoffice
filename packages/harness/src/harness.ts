import {
  checkTaskCredits,
  checkTaskRequest,
  isAgentTaskError,
  type AgentTaskService,
} from '@melonoffice/agents';
import type { DecisionAgent, DecisionEngine, DecisionItem } from '@melonoffice/decisions';
import type {
  AIQualityTier,
  AIRoutingStrategy,
  DataSensitivity,
  Execution,
  ExecutionNode,
  OrganizationId,
  SpecialistId,
  SpecialistStatus,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { sensitivityOfData, type HarnessDataClass } from './data.js';
import { handoffTo, type HandoffToHuman } from './handoff.js';
import { classifyTask, departmentOf } from './intent.js';
import {
  checkHarnessLimits,
  DEFAULT_HARNESS_LIMITS,
  depthProblem,
  planLimitProblem,
  type HarnessLimitCode,
  type HarnessLimits,
} from './limits.js';
import {
  HarnessError,
  type ExecutionStrategy,
  type HarnessAgent,
  type HarnessExecutionContext,
  type HarnessTask,
  type HarnessVerdict,
  type TaskClassification,
} from './model.js';
import {
  checkProfilePolicy,
  contextPlanOf,
  DEFAULT_HARNESS_PROFILE_POLICY,
  modelProfileOf,
  needsPlan,
  type HarnessProfilePolicy,
} from './profile.js';
import type { HarnessPlanner } from './planning.js';
import { aiNeedOf } from './routing.js';
import { workingTimeMs } from './tool-loop.js';
import { harnessToolOf, type HarnessToolDirectory } from './tools.js';

/**
 * The Melon Agent Harness, block 1 (ADR-0099):
 *
 *   task → reading (intent, domains, complexity) → context plan → planner mode → agent
 *   → model profile → tools → budget → verdict → the existing agent task (runtime, AI Gateway,
 *   Tool Gate) → result.
 *
 * It decides and hands over; it never calls a model, runs a tool or moves a credit itself. The
 * agent is chosen by the Decision Engine's `agent.routing`, the task is created and started by
 * the Agent Engine's task service, the model is chosen by the AI Gateway's router under the
 * agent's model policy (the Harness only gives the order to try models in), the credits are the
 * Credits Engine's, and every tool call still passes the Tool Gate.
 */

/** Which agent should take a task. */
export interface HarnessAgentRouter {
  route(
    tenant: TenantContext,
    input: { readonly request: string; readonly department?: string },
  ): Promise<
    | { readonly status: 'routed'; readonly agent: HarnessAgent; readonly reason: string }
    | { readonly status: 'choose'; readonly candidates: readonly HarnessAgent[] }
    | { readonly status: 'none' }
  >;
}

/** The organization's active agents, read as the person. */
export interface HarnessAgentDirectory {
  active(tenant: TenantContext): Promise<readonly DecisionAgent[]>;
}

/** The Credits engine's balance, as the AI Gateway reads it (ADR-0023). */
export interface HarnessCredits {
  balanceOf(
    tenant: TenantContext,
  ): Promise<
    | { readonly status: 'present'; readonly balance: number }
    | { readonly status: 'unavailable'; readonly reason: string }
  >;
}

export interface AgentHarnessOptions {
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly router: HarnessAgentRouter;
  readonly directory: HarnessAgentDirectory;
  /** The Agent Engine's tasks: how a ready task starts. Absent: the Harness only prepares. */
  readonly tasks?: Pick<AgentTaskService, 'assign'>;
  /** Absent: no balance can be read, so no task is started (the gateway would deny it). */
  readonly credits?: HarnessCredits;
  /** Absent: no tools are listed. */
  readonly tools?: HarnessToolDirectory;
  readonly policy?: HarnessProfilePolicy;
  /**
   * How a multi-step task gets its plan (ADR-0101). Absent, or the person may not create plans:
   * a multi-step task runs as one agent task, as in block 1.
   */
  readonly planner?: HarnessPlanner;
  /** What one task may use at most. Absent: `DEFAULT_HARNESS_LIMITS`. */
  readonly limits?: HarnessLimits;
}

export interface HarnessStart {
  readonly strategy: ExecutionStrategy;
  /** The agent task the strategy started, when it was `ready`. */
  readonly task?: Awaited<ReturnType<AgentTaskService['assign']>>;
}

export interface AgentHarness {
  /** What the Harness would do with a task: nothing is started, no model is asked. */
  prepare(tenant: TenantContext, task: HarnessTask): Promise<ExecutionStrategy>;
  /** Prepares the task and, when it is `ready`, starts it as the chosen agent's task. */
  start(tenant: TenantContext, task: HarnessTask): Promise<HarnessStart>;
}

const DEPARTMENT = /^[a-z][a-z_]{0,63}$/;
/** What the routing decision reads of a request (ADR-0065). */
const ROUTING_REQUEST_LENGTH = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A task's content, checked the way the agent task checks it. */
export function checkHarnessTask(value: unknown): HarnessTask {
  if (!isRecord(value)) throw new HarnessError('invalid_task', 'body');
  for (const key of Object.keys(value)) {
    if (!['request', 'specialistId', 'department', 'idempotencyKey', 'maxCredits'].includes(key)) {
      throw new HarnessError('invalid_task', key);
    }
  }
  let request: string;
  try {
    request = checkTaskRequest(value.request);
  } catch (error) {
    if (isAgentTaskError(error)) throw new HarnessError('invalid_task', 'request');
    throw error;
  }
  let maxCredits: number | undefined;
  try {
    maxCredits = value.maxCredits === undefined ? undefined : checkTaskCredits(value.maxCredits);
  } catch (error) {
    if (isAgentTaskError(error)) throw new HarnessError('invalid_task', 'maxCredits');
    throw error;
  }
  const { specialistId, department, idempotencyKey } = value;
  if (specialistId !== undefined && typeof specialistId !== 'string') {
    throw new HarnessError('invalid_task', 'specialistId');
  }
  if (
    department !== undefined &&
    (typeof department !== 'string' || !DEPARTMENT.test(department))
  ) {
    throw new HarnessError('invalid_task', 'department');
  }
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
    throw new HarnessError('invalid_task', 'idempotencyKey');
  }
  return Object.freeze({
    request,
    ...(specialistId === undefined ? {} : { specialistId }),
    ...(department === undefined ? {} : { department }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(maxCredits === undefined ? {} : { maxCredits }),
  });
}

/**
 * The data of every task given today: the organization's own (ADR-0100). Never lowered on what a
 * request says, so the data policy always sees the task as private.
 */
const TASK_DATA: HarnessDataClass = 'company_private';

const contextOf = (tenant: TenantContext): HarnessExecutionContext =>
  Object.freeze({
    organizationId: tenant.organizationId as OrganizationId,
    userId: tenant.userId,
    actor: tenant.actor,
    role: tenant.role,
  });

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  const { authorization, router, directory, tasks, credits, tools, planner } = options;
  const policy = checkProfilePolicy(options.policy ?? DEFAULT_HARNESS_PROFILE_POLICY);
  const limits = checkHarnessLimits(options.limits ?? DEFAULT_HARNESS_LIMITS);
  /** Whether a multi-step task gets a plan: a planner, and a person who may create plans. */
  const plans = (tenant: TenantContext) =>
    planner !== undefined && authorization.authorize(tenant, 'plan.create').allowed;

  async function prepare(tenant: TenantContext, raw: HarnessTask): Promise<ExecutionStrategy> {
    if (!isResolvedTenant(tenant)) throw new HarnessError('unresolved_tenant');
    if (!authorization.authorize(tenant, 'specialist.read').allowed) {
      throw new HarnessError('permission_denied');
    }
    const task = checkHarnessTask(raw);
    const classification = classifyTask(task.request);
    const reasons: string[] = [];
    const plan = { mode: needsPlan(classification) ? 'multi_step' : 'single_step' } as const;
    if (plan.mode === 'multi_step') {
      reasons.push(plans(tenant) ? 'multi_step_needs_plan' : 'multi_step_runs_as_single_task');
    }
    let handoff: HandoffToHuman | null = null;
    let agent: HarnessAgent | null = null;
    let candidates: readonly HarnessAgent[] = [];
    const maxCredits = task.maxCredits ?? null;
    let budget: ExecutionStrategy['budget'] = { status: 'unavailable', maxCredits };

    const decide = async (): Promise<HarnessVerdict> => {
      // An agent's own work may not start another task: no chain of agents asking agents.
      const deep = depthProblem(tenant);
      if (deep !== undefined) {
        reasons.push(deep);
        return 'refused';
      }
      // A person asked for a person: nothing is routed and no model is asked.
      if (classification.asksForPerson) {
        reasons.push('person_requested');
        handoff = handoffTo('person_requested');
        return 'handoff_to_human';
      }
      // Credits before anything that may spend them (routing among several agents asks a model).
      const balance = credits === undefined ? undefined : await credits.balanceOf(tenant);
      if (balance === undefined || balance.status === 'unavailable') {
        reasons.push('credits_unavailable');
        return 'refused';
      }
      if (balance.balance <= 0) {
        budget = { status: 'insufficient', maxCredits };
        reasons.push('insufficient_credits');
        return 'refused';
      }
      budget = { status: 'available', maxCredits };
      // The balance is the real limit: a budget above it only says how far the task may go.
      if (maxCredits !== null && maxCredits > balance.balance) reasons.push('budget_above_balance');

      if (task.specialistId !== undefined) {
        const named = (await directory.active(tenant)).find((a) => a.id === task.specialistId);
        if (named === undefined) {
          reasons.push('named_agent_not_active');
          return 'no_agent';
        }
        agent = { id: named.id, name: named.name, department: named.department };
        reasons.push('agent_named_by_person');
        return 'ready';
      }
      const inferred = task.department === undefined ? departmentOf(classification) : undefined;
      const department = task.department ?? inferred;
      const request = [...task.request].slice(0, ROUTING_REQUEST_LENGTH).join('');
      let routed = await router.route(tenant, {
        request,
        ...(department === undefined ? {} : { department }),
      });
      // A department the Harness only inferred is a preference, not a limit.
      if (routed.status === 'none' && inferred !== undefined) {
        reasons.push('inferred_department_empty');
        routed = await router.route(tenant, { request });
      }
      if (routed.status === 'none') {
        reasons.push('no_active_agent');
        return 'no_agent';
      }
      if (routed.status === 'choose') {
        candidates = routed.candidates;
        reasons.push('several_agents_fit');
        return 'choose_agent';
      }
      agent = routed.agent;
      reasons.push(routed.reason);
      return 'ready';
    };
    const verdict = await decide();

    const chosen = agent as HarnessAgent | null;
    const granted =
      chosen === null || tools === undefined
        ? []
        : await tools.granted(tenant, chosen.id as SpecialistId);
    return Object.freeze({
      version: 1,
      context: contextOf(tenant),
      classification,
      plan: Object.freeze(plan),
      contextPlan: Object.freeze(contextPlanOf(classification)),
      agent: chosen === null ? null : Object.freeze({ ...chosen }),
      candidates: Object.freeze(candidates.map((c) => Object.freeze({ ...c }))),
      model: modelProfileOf(classification, policy),
      need: aiNeedOf('text'),
      tools: Object.freeze(granted.map(harnessToolOf)),
      data: Object.freeze({ class: TASK_DATA, sensitivity: sensitivityOfData(TASK_DATA) }),
      limits,
      budget: Object.freeze(budget),
      verdict,
      handoff: handoff as HandoffToHuman | null,
      reasons: Object.freeze(reasons),
    } satisfies ExecutionStrategy);
  }

  /** A multi-step task: the planner makes the plan, which then waits for a person (ADR-0101). */
  async function startPlan(
    tenant: TenantContext,
    task: HarnessTask,
    strategy: ExecutionStrategy,
    agent: HarnessAgent,
  ): Promise<HarnessStart> {
    const outcome = await (planner as HarnessPlanner).plan(tenant, {
      request: task.request,
      agentId: agent.id as SpecialistId,
      ...(task.idempotencyKey === undefined ? {} : { idempotencyKey: task.idempotencyKey }),
    });
    const settle = (
      verdict: HarnessVerdict,
      handoff: HandoffToHuman | null,
      reasons: readonly string[],
      plan: ExecutionStrategy['plan'],
    ): HarnessStart =>
      Object.freeze({
        strategy: Object.freeze({
          ...strategy,
          plan: Object.freeze(plan),
          verdict,
          handoff,
          reasons: Object.freeze([...strategy.reasons, ...reasons]),
        }),
      });
    if (outcome.status === 'failed') {
      return settle('handoff_to_human', handoffTo('plan_failed', outcome.reason), ['plan_failed'], {
        mode: 'multi_step',
      });
    }
    const planned = {
      mode: 'multi_step' as const,
      id: outcome.planId,
      status: outcome.planStatus,
      steps: outcome.steps.length,
    };
    const problem = planLimitProblem(outcome.steps, limits);
    if (problem !== undefined) {
      if (outcome.planStatus === 'approval_required') {
        await (planner as HarnessPlanner).cancel(tenant, outcome.planId, problem);
        planned.status = 'cancelled';
      }
      return settle('handoff_to_human', handoffTo('policy', problem), [problem], planned);
    }
    // Approved or rejected by a person already (a repeat of the same request): as it stands.
    if (outcome.planStatus !== 'approval_required') {
      return settle('ready', null, ['plan_decided'], planned);
    }
    return settle('needs_authorization', null, ['plan_awaits_approval'], planned);
  }

  return Object.freeze({
    prepare,
    async start(tenant: TenantContext, raw: HarnessTask): Promise<HarnessStart> {
      const strategy = await prepare(tenant, raw);
      if (strategy.verdict !== 'ready' || strategy.agent === null || tasks === undefined) {
        return Object.freeze({ strategy });
      }
      const task = checkHarnessTask(raw);
      if (strategy.plan.mode === 'multi_step' && plans(tenant)) {
        return startPlan(tenant, task, strategy, strategy.agent);
      }
      const started = await tasks.assign(tenant, strategy.agent.id, {
        request: task.request,
        ...(task.idempotencyKey === undefined ? {} : { idempotencyKey: task.idempotencyKey }),
        ...(task.maxCredits === undefined ? {} : { maxCredits: task.maxCredits }),
      });
      return Object.freeze({ strategy, task: started });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The Decision Engine as the Harness's agent router

const agentOfItem = (item: DecisionItem): HarnessAgent | undefined => {
  const department = item.evidence.find((e) => e.fact === 'department')?.value;
  if (item.subject.type !== 'specialist' || typeof department !== 'string') return undefined;
  return Object.freeze({
    id: item.subject.id as SpecialistId,
    name: item.subject.label ?? '',
    department,
  });
};

/**
 * Routing through `agent.routing` (ADR-0065): rules first, a model only among several agents,
 * audited as a decision. The person needs `decision.evaluate` and `specialist.read`; without them
 * the engine refuses, and so does the Harness.
 */
export function createDecisionAgentRouter(
  engine: Pick<DecisionEngine, 'evaluateDecision'>,
): HarnessAgentRouter {
  return Object.freeze({
    async route(tenant: TenantContext, input: { request: string; department?: string }) {
      const result = await engine.evaluateDecision(tenant, {
        type: 'agent.routing',
        input: {
          request: input.request,
          ...(input.department === undefined ? {} : { department: input.department }),
        },
      });
      const agents = result.items.flatMap((i) => {
        const agent = agentOfItem(i);
        return agent === undefined ? [] : [agent];
      });
      if (result.outcome === 'route_to_agent' && agents[0] !== undefined) {
        return {
          status: 'routed' as const,
          agent: agents[0],
          reason: result.reasons[0]?.code ?? 'routed',
        };
      }
      if (result.outcome === 'needs_person' && agents.length > 0) {
        return { status: 'choose' as const, candidates: agents };
      }
      return { status: 'none' as const };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The model profile on the runtime's call

/** The parts of an AI call the Harness may set. */
interface ShapeableWork {
  readonly sensitivity?: DataSensitivity;
  readonly strategy?: AIRoutingStrategy;
  readonly quality?: AIQualityTier;
  readonly maxCredits?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** The most labels a call carries (the AI Gateway's limit). */
const MAX_METADATA_ENTRIES = 20;

/**
 * A call with the Harness's model profile for its request: the order to try models in and, only
 * when the policy sets one, a quality floor. What the work already set stays: the Harness never
 * overrides a caller's explicit choice, and never names a model or a provider.
 */
/**
 * Why the Harness asked for the strongest model the policy allows instead of the cheapest that
 * fits (ADR-0100): the task is complex (analysis and planning always are). Recorded on the call's
 * trace. A model that fails is replaced by the gateway's fallback, recorded as `fallbackFrom`.
 */
export type HarnessEscalation = 'complex_task';

const escalationOf = (strategy: AIRoutingStrategy): HarnessEscalation | undefined =>
  strategy === 'quality_first' ? 'complex_task' : undefined;

const SENSITIVITIES: readonly DataSensitivity[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
];

/** The higher of two sensitivities: the Harness only ever raises what a call carries. */
const higher = (a: DataSensitivity | undefined, b: DataSensitivity): DataSensitivity =>
  a !== undefined && SENSITIVITIES.indexOf(a) > SENSITIVITIES.indexOf(b) ? a : b;

/**
 * Work the Harness has no request for (a conversation agent's turn, a plan's step): read as a
 * simple question, so it gets the cheapest model that fits and is never labelled as escalated.
 */
const ROUTINE_WORK: TaskClassification = Object.freeze({
  intent: 'question',
  domains: Object.freeze([]),
  complexity: 'simple',
  asksForPerson: false,
  signals: Object.freeze(['kind:routine_work']),
});

export function withHarnessProfile<W extends ShapeableWork>(
  work: W,
  request: string | TaskClassification,
  policy: HarnessProfilePolicy = DEFAULT_HARNESS_PROFILE_POLICY,
  budget?: { readonly remainingCredits: number },
  data: HarnessDataClass = TASK_DATA,
): W {
  const classification = typeof request === 'string' ? classifyTask(request) : request;
  const profile = modelProfileOf(classification, policy);
  // Only the Harness's own choice is an escalation: a strategy the caller set stays the caller's.
  const escalation = work.strategy === undefined ? escalationOf(profile.strategy) : undefined;
  const labels = {
    harnessIntent: classification.intent,
    harnessComplexity: classification.complexity,
    harnessPolicy: `${policy.id}@${policy.version}`,
    harnessData: data,
    ...(escalation === undefined ? {} : { harnessEscalation: escalation }),
  };
  const metadata = { ...labels, ...(work.metadata ?? {}) };
  return {
    ...work,
    // The data policy routes on this: never below what the task's data is.
    sensitivity: higher(work.sensitivity, sensitivityOfData(data)),
    strategy: work.strategy ?? profile.strategy,
    ...(work.quality === undefined && profile.minimumQuality !== undefined
      ? { quality: profile.minimumQuality }
      : {}),
    ...(Object.keys(metadata).length <= MAX_METADATA_ENTRIES ? { metadata } : {}),
    // What is left of the task's budget caps the call: the gateway then tries only models whose
    // estimate fits (a cheaper one when there is one) and refuses the call when none does.
    ...(budget === undefined
      ? {}
      : {
          maxCredits: Math.min(work.maxCredits ?? Infinity, Math.max(0, budget.remainingCredits)),
        }),
  };
}

/**
 * Why the Harness stops an agent that is no longer active (AE-4, ADR-0115): paused, disabled, or
 * anything else (archived, draft, gone). The same codes its executions are cancelled with.
 */
export type HarnessAgentStopCode = 'agent_paused' | 'agent_disabled' | 'agent_not_active';

/** Work the Harness stopped (the runtime fails the execution with this code, asking no model). */
export interface HarnessStop {
  readonly stop: HarnessLimitCode | HarnessAgentStopCode;
}

/** Where the Harness reads an agent's status: the specialists repository. */
export interface HarnessAgentStatus {
  find(
    organizationId: OrganizationId,
    id: SpecialistId,
  ): Promise<{ readonly status: SpecialistStatus } | undefined>;
}

/** The stop for an agent that may not work now, or none when it is active. */
export function agentStopOf(
  agent: { readonly status: SpecialistStatus } | undefined,
): HarnessAgentStopCode | undefined {
  if (agent?.status === 'active') return undefined;
  if (agent?.status === 'paused') return 'agent_paused';
  if (agent?.status === 'disabled') return 'agent_disabled';
  return 'agent_not_active';
}

/**
 * An agent work source whose model calls all go through the Harness (ADR-0100): the task's data
 * class (so the data policy applies before routing), its model profile, what is left of its
 * budget, and its time limit. There is no way around it: work with no request (a conversation
 * turn, a plan step) still gets the data class, the limits and the cheapest fitting model.
 *
 * `taskOf` gives the person's request and budget, from storage, when the execution has them.
 */
type AgentWorkSource = {
  agentWork(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<ShapeableWork | undefined>;
};

/** The call a work source makes. */
type WorkOf<S extends AgentWorkSource> = Exclude<Awaited<ReturnType<S['agentWork']>>, undefined>;

export function createHarnessAgentWork<S extends AgentWorkSource>(
  inner: S,
  options: {
    /** The person's request of the execution and its budget, from storage. */
    readonly taskOf?: (
      tenant: TenantContext,
      execution: Execution,
    ) => Promise<{ readonly request: string; readonly maxCredits?: number } | undefined>;
    /**
     * What the execution's AI calls already spent, in credits. Absent: nothing yet (one call per
     * task, as agent tasks are today).
     */
    readonly spent?: (tenant: TenantContext, execution: Execution) => Promise<number>;
    readonly policy?: HarnessProfilePolicy;
    readonly limits?: HarnessLimits;
    readonly now?: () => Date;
    /**
     * The agents' status (AE-4): every step of an agent's execution first checks its agent is
     * still active, so a paused or disabled agent asks no model and spends no credit, whatever
     * cancellation missed. Absent: not checked here (the tool gate still refuses its tools).
     */
    readonly agents?: HarnessAgentStatus;
  },
): Omit<S, 'agentWork'> & {
  agentWork(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<WorkOf<S> | HarnessStop | undefined>;
} {
  const policy = checkProfilePolicy(options.policy ?? DEFAULT_HARNESS_PROFILE_POLICY);
  const limits = checkHarnessLimits(options.limits ?? DEFAULT_HARNESS_LIMITS);
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    ...inner,
    async agentWork(tenant: TenantContext, execution: Execution, node: ExecutionNode) {
      // Time first: a task past its limit asks no model and reads nothing more. The time it
      // waited on a person's approval is not its own (ADR-0103).
      if (workingTimeMs(execution, now()) > limits.maxDurationMs) {
        return Object.freeze({ stop: 'task_time_limit_reached' as const });
      }
      // Then the agent: only an active one works, checked at every step (AE-4).
      if (options.agents !== undefined && execution.specialistId !== undefined) {
        const stop = agentStopOf(
          await options.agents.find(execution.organizationId, execution.specialistId),
        );
        if (stop !== undefined) return Object.freeze({ stop });
      }
      const work = (await inner.agentWork(tenant, execution, node)) as WorkOf<S> | undefined;
      if (work === undefined) return undefined;
      const task =
        options.taskOf === undefined ? undefined : await options.taskOf(tenant, execution);
      if (task === undefined) return withHarnessProfile(work, ROUTINE_WORK, policy);
      const budget =
        task.maxCredits === undefined
          ? undefined
          : {
              remainingCredits:
                task.maxCredits -
                (options.spent === undefined ? 0 : await options.spent(tenant, execution)),
            };
      return withHarnessProfile(work, task.request, policy, budget);
    },
  });
}
