import { parseAgentAnswer, readPlanTrace } from '@melonoffice/agents';
import type { AuditHistoryReader } from '@melonoffice/audit';
import type { Execution, Plan, PlanEstimate, PlanStep, PlanVersion } from '@melonoffice/domain';
import type { AgentOutputStore, ExecutionService } from '@melonoffice/execution';
import {
  conditionStepState,
  gatedStepState,
  isPlanningError,
  PlanningError,
  planStepStates,
  stepApprovalEntriesOf,
  stepApprovalOf,
  stepAttemptOf,
  stepExecutionOf,
  specialistStepState,
  unrunnableStepOf,
  waitStepState,
  type PlanConductor,
  type PlanService,
  type PlanStepState,
} from '@melonoffice/planning';
import type { TenantContext } from '@melonoffice/tenancy';
import { withCorrelation } from '@melonoffice/observability';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Plan routes (ADR-0028, ADR-0070). Plans are made by the planner, or by a person planning a
 * workflow (ADR-0071, workflow routes), never from a client's steps: no route here creates or
 * delegates a plan by itself. Approving one is what starts it, when the plan conductor is
 * configured. A user may read plans
 * (`plan.read`) and approve or reject one exact version (`approval.approve`, acting directly,
 * never through GIA). The decision body carries only the version and digest the user saw; any
 * other field is refused. Another organization's plan answers exactly like a missing one.
 */
export function registerPlanRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly plans: PlanService;
    /**
     * Runs an approved plan (WF-1, ADR-0070): approving starts it. Absent: an approval is
     * recorded and nothing runs, exactly as before.
     */
    readonly conductor?: Pick<PlanConductor, 'run'>;
    /** Reads each step's execution and answer, for `GET plans/:id/steps`. */
    readonly steps?: {
      readonly executions: Pick<ExecutionService, 'get'>;
      readonly outputs?: Pick<AgentOutputStore, 'find'>;
      /** The audit trail of the plan and its steps, for `GET plans/:id/trace` (ADR-0157). */
      readonly history?: AuditHistoryReader;
    };
  },
): void {
  const { plans, conductor, steps } = dependencies;
  const base = '/v1/organizations/:organizationId/plans';

  app.get(
    base,
    withPermission('plan.read', dependencies, async (c, tenant) =>
      c.json({ plans: (await plans.list(tenant)).map(toPlanView) }),
    ),
  );

  app.get(
    `${base}/:planId`,
    withPermission('plan.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const plan = await plans.get(tenant, c.req.param('planId') ?? '');
        const version = await plans.getVersion(tenant, plan.id, plan.version);
        return { ...toPlanView(plan), current: toVersionView(version) };
      }),
    ),
  );

  // Each step that runs, where it is by the conductor's own rule (ADR-0145): a specialist step
  // with its execution's state and, once it completed, its agent's answer; a check with what its
  // decision said; `awaiting_approval` or `declined` for a step that asked a person (ADR-0146);
  // and `skipped` for a step after a check or decline that ended its branch.
  if (steps !== undefined) {
    app.get(
      `${base}/:planId/steps`,
      withPermission('plan.read', dependencies, async (c, tenant) =>
        answer(c, async () => {
          const plan = await plans.get(tenant, c.req.param('planId') ?? '');
          const version = await plans.getVersion(tenant, plan.id, plan.version);
          const { views } = await readPlanSteps(tenant, plan, version, steps);
          return { planId: plan.id, status: plan.status, steps: views };
        }),
      ),
    );
  }

  // Everything that happened in the plan (ADR-0157): each step's runs, nodes, tools, approvals,
  // models, credits, times and errors, where it stopped, and its audit trail. Codes, ids, times
  // and numbers only, with each step's state by the plan engine's own rule.
  const outputs = steps?.outputs;
  if (steps !== undefined && outputs !== undefined) {
    app.get(
      `${base}/:planId/trace`,
      withPermission('plan.read', dependencies, async (c, tenant) =>
        answer(c, async () => {
          const plan = await plans.get(tenant, c.req.param('planId') ?? '');
          const version = await plans.getVersion(tenant, plan.id, plan.version);
          const trace = await readPlanTrace(tenant, plan.id, {
            plans,
            executions: steps.executions,
            outputs,
            ...(steps.history === undefined ? {} : { history: steps.history }),
          });
          const { views } = await readPlanSteps(tenant, plan, version, steps);
          const states = new Map(views.map((v) => [v.stepId, v.state]));
          return {
            ...trace,
            steps: trace.steps.map((s) => ({ ...s, state: states.get(s.stepId) ?? null })),
          };
        }),
      ),
    );
  }

  for (const [action, decide] of [
    ['approve', plans.approve],
    ['reject', plans.reject],
  ] as const) {
    app.post(
      `${base}/:planId/${action}`,
      withPermission('approval.approve', dependencies, async (c, tenant) => {
        const seen = await decisionOf(c);
        if (seen === undefined) return c.json({ error: 'invalid_request' }, 400);
        return answer(c, async () => {
          const planId = c.req.param('planId') ?? '';
          // Approving starts the plan: one that cannot run whole is refused before the decision,
          // so an approval never covers a plan that would stop halfway (ADR-0070).
          if (action === 'approve' && conductor !== undefined) {
            const current = await plans.get(tenant, planId);
            const version = await plans.getVersion(tenant, current.id, current.version);
            const unrunnable = unrunnableStepOf(version);
            if (unrunnable !== undefined) throw new PlanningError('plan_not_runnable', unrunnable);
          }
          const decided = await decide(tenant, planId, seen);
          const log = withCorrelation(c.get('logger'), { planId: decided.id });
          log.info(`plan ${action}`);
          if (decided.status !== 'approved' || conductor === undefined) return toPlanView(decided);
          const running = await conductor.run(tenant, decided.id);
          log.info('plan running');
          return toPlanView(running);
        });
      }),
    );
  }
}

const DIGEST = /^[0-9a-f]{64}$/;

/** The decision body: exactly `{ version, digest }`. */
async function decisionOf(
  c: Context<AuthEnv>,
): Promise<{ version: number; digest: string } | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { version, digest, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return undefined;
  }
  if (typeof digest !== 'string' || !DIGEST.test(digest)) return undefined;
  return { version, digest };
}

const STATUS = {
  plan_not_found: 404,
  gia_cannot_decide: 403,
  runtime_cannot_decide: 403,
  permission_denied: 403,
  plan_version_mismatch: 409,
  plan_concurrency_conflict: 409,
  invalid_plan_transition: 409,
  plan_not_runnable: 409,
  specialist_not_eligible: 409,
  delegation_failed: 409,
  delegation_conflict: 409,
  execution_not_plannable: 409,
} as const;

async function answer(c: Context<AuthEnv>, work: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await work());
  } catch (error) {
    if (isPlanningError(error) && Object.hasOwn(STATUS, error.code)) {
      const code = error.code as keyof typeof STATUS;
      return c.json({ error: code }, STATUS[code]);
    }
    throw error;
  }
}

/** The public view of a plan. The revision is internal and not shown. */
export function toPlanView(plan: Plan) {
  return {
    id: plan.id,
    executionId: plan.executionId,
    status: plan.status,
    version: plan.version,
    delegations: plan.delegations.map((d) => ({ stepId: d.stepId, executionId: d.executionId })),
    delegationState: plan.delegationState ?? null,
    delegationFailure: plan.delegationFailure ?? null,
    decision:
      plan.decision === undefined
        ? null
        : {
            decision: plan.decision.decision,
            version: plan.decision.version,
            decidedBy: plan.decision.decidedBy,
            decidedAt: plan.decision.decidedAt,
          },
    createdAt: plan.createdAt,
    createdBy: plan.createdBy,
    updatedAt: plan.updatedAt,
  };
}

const stepView = (s: PlanStep) => ({
  id: s.id,
  kind: s.kind,
  label: s.label,
  dependsOn: [...s.dependsOn],
  specialist:
    s.specialist === undefined
      ? null
      : {
          id: s.specialist.id,
          version: s.specialist.version,
          departmentId: s.specialist.departmentId,
        },
  performedBy: s.performedBy ?? null,
  tool: s.tool === undefined ? null : { id: s.tool.id, version: s.tool.version },
  // A tool step's input (ADR-0151): data fixed when the plan was made, what the person approves.
  input: s.input === undefined ? null : structuredClone(s.input),
  // A wait step's length (ADR-0152).
  wait: s.wait === undefined ? null : { seconds: s.wait.seconds },
  verification:
    s.verification === undefined
      ? null
      : {
          policy: s.verification.policy,
          expectedOutput: s.verification.expectedOutput,
          requiredChecks: [...s.verification.requiredChecks],
        },
  condition:
    s.condition === undefined ? null : { step: s.condition.step, outcome: s.condition.outcome },
  // A check's decision (WF-4): short codes and numbers fixed when the plan was made.
  decision:
    s.decision === undefined
      ? null
      : {
          decision: s.decision.decision,
          continueOn: [...s.decision.continueOn],
          input: { ...s.decision.input },
        },
  retry:
    s.retry === undefined
      ? null
      : { maxAttempts: s.retry.maxAttempts, backoffMs: s.retry.backoffMs },
  approvalRequired: s.approvalRequired,
  estimate: s.estimate === undefined ? null : creditEstimate(s.estimate),
});

/** An estimate as a company sees it: in credits, never MelonOffice's internal cost (ADR-0082). */
const creditEstimate = (e: PlanEstimate) => ({ status: e.status, credits: e.credits });

/**
 * One version, with the digest a user sends back to approve exactly it. Estimates are shown as
 * estimates: `unknown` whenever a price or the credit rate is missing, never a charge.
 */
export function toVersionView(v: PlanVersion) {
  return {
    version: v.version,
    digest: v.digest,
    request: { summary: v.request.summary, objective: v.request.objective },
    steps: v.steps.map(stepView),
    riskLevel: v.riskLevel,
    approvalRequired: v.approvalRequired,
    estimate: creditEstimate(v.estimate),
    source:
      v.source.kind === 'planner'
        ? // Which provider, model and policy wrote the plan is the platform's, not the company's.
          { kind: 'planner' }
        : {
            kind: 'workflow',
            workflowId: v.source.workflowId,
            workflowVersion: v.source.workflowVersion,
          },
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  };
}

/** How the plan engine sees each step of one plan version, as `GET plans/:id/steps` shows it. */
export interface PlanStepRead {
  readonly stepId: string;
  readonly kind: 'condition' | 'specialist' | 'wait';
  readonly label: string;
  readonly state: PlanStepState;
  readonly executionId: string | null;
  readonly status: string | null;
  readonly approvalId: string | null;
  readonly failure: string | null;
  readonly outcome: string | null;
  readonly answer: string | null;
  readonly missing: string[];
  /**
   * On a wait step that started (ADR-0152): when the steps after it may start. On a step's next
   * attempt (ADR-0153): when it may start.
   */
  readonly until: string | null;
  /** On a specialist step: which run of it its child is, from 1 (ADR-0153). */
  readonly attempt: number | null;
}

/**
 * Each step of a plan with the state the plan engine gives it (ADR-0145, ADR-0146) and its
 * child execution: the one reading of a plan's steps, for the plan's page and for the list of
 * every agent's work (ADR-0149). Reads only; calls no model.
 */
export async function readPlanSteps(
  tenant: TenantContext,
  plan: Plan,
  version: PlanVersion,
  steps: {
    readonly executions: Pick<ExecutionService, 'get'>;
    readonly outputs?: Pick<AgentOutputStore, 'find'>;
  },
): Promise<{ readonly views: PlanStepRead[]; readonly children: ReadonlyMap<string, Execution> }> {
  const children = new Map<string, Execution>();
  for (const step of version.steps) {
    if (step.kind !== 'specialist') continue;
    // The step's current child: its latest attempt's, else its delegation's (ADR-0153).
    const executionId = stepExecutionOf(plan, step.id);
    if (executionId === undefined) continue;
    // An attempt whose child the worker has not created yet reads as not started.
    const child = await steps.executions.get(tenant, executionId).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 'execution_not_found') return undefined;
      throw error;
    });
    if (child !== undefined) children.set(step.id, child);
  }
  const attemptOf = (id: string) => (plan.attempts ?? []).filter((a) => a.stepId === id).at(-1);
  const conditionOf = (id: string) => plan.conditions?.find((c) => c.stepId === id);
  // Every approval a step waits for: its own (ADR-0146) and its tool steps' (ADR-0151). The one
  // shown is the first still open, else the declined one, which says why it never ran.
  const approvalOf = (id: string) => {
    const entries = stepApprovalEntriesOf(plan, id);
    return entries.find((a) => a.declined === undefined) ?? entries[0];
  };
  const declineOf = (id: string) =>
    stepApprovalEntriesOf(plan, id).find((a) => a.declined !== undefined)?.declined;
  const waitOf = (id: string) => plan.waits?.find((w) => w.stepId === id);
  const at = new Date();
  const states = planStepStates(version.steps, (step) => {
    if (step.kind === 'condition') return conditionStepState(conditionOf(step.id));
    if (step.kind === 'wait') return waitStepState(waitOf(step.id), at);
    const child = children.get(step.id);
    const attempt = attemptOf(step.id);
    // A step's next attempt waits out its backoff (ADR-0153).
    const delayed = attempt !== undefined && Date.parse(attempt.notBefore) > at.getTime();
    if (child === undefined) return delayed ? 'delayed' : 'waiting';
    // A step that asked people (ADR-0146, ADR-0151): waiting for them, or declined.
    const approval = stepApprovalOf(plan, step.id);
    const own = approval === 'none' ? specialistStepState(child) : gatedStepState(child, approval);
    return own === 'waiting' && delayed ? 'delayed' : own;
  });
  const out: PlanStepRead[] = [];
  for (const step of version.steps) {
    const state = states.get(step.id);
    if (state === undefined) continue;
    if (step.kind === 'condition') {
      const decided = conditionOf(step.id);
      out.push({
        stepId: step.id,
        kind: 'condition',
        label: step.label,
        state,
        executionId: null,
        status: null,
        approvalId: null,
        failure: decided?.failure ?? null,
        // Only what the decision said; its reasons stay in the decision's own record.
        outcome: decided?.decision?.outcome ?? null,
        answer: null,
        missing: [],
        until: null,
        attempt: null,
      });
      continue;
    }
    if (step.kind === 'wait') {
      out.push({
        stepId: step.id,
        kind: 'wait',
        label: step.label,
        state,
        executionId: null,
        status: null,
        approvalId: null,
        failure: null,
        outcome: null,
        answer: null,
        missing: [],
        until: waitOf(step.id)?.until ?? null,
        attempt: null,
      });
      continue;
    }
    const execution = children.get(step.id);
    const record =
      execution?.status === 'completed' && steps.outputs !== undefined
        ? await steps.outputs.find(tenant, execution.id, step.id)
        : undefined;
    const answered = record === undefined ? undefined : parseAgentAnswer(record.output);
    out.push({
      stepId: step.id,
      kind: 'specialist',
      label: step.label,
      state,
      executionId: execution?.id ?? null,
      status: execution?.status ?? null,
      // The approval a person decides it with, in the approvals inbox: once it started, the one
      // its tool call waits on (ADR-0155).
      approvalId:
        (execution?.status === 'waiting_approval'
          ? execution.nodes.find((n) => n.status === 'pending' && n.approvalId !== undefined)
              ?.approvalId
          : undefined) ??
        approvalOf(step.id)?.approvalId ??
        null,
      // Why a declined step never ran: rejected, expired or withdrawn (ADR-0146).
      failure: declineOf(step.id)?.reason ?? execution?.failure?.code ?? null,
      outcome: null,
      answer: answered?.answer ?? null,
      missing: answered === undefined ? [] : [...answered.missing],
      until: state === 'delayed' ? (attemptOf(step.id)?.notBefore ?? null) : null,
      attempt: stepAttemptOf(plan, step.id),
    });
  }
  return { views: out, children };
}
