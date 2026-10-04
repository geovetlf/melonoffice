import { parseAgentAnswer } from '@melonoffice/agents';
import type { Execution, Plan, PlanEstimate, PlanStep, PlanVersion } from '@melonoffice/domain';
import type { AgentOutputStore, ExecutionService } from '@melonoffice/execution';
import {
  conditionStepState,
  gatedStepState,
  isPlanningError,
  PlanningError,
  planStepStates,
  specialistStepState,
  unrunnableStepOf,
  type PlanConductor,
  type PlanService,
} from '@melonoffice/planning';
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
          const children = new Map<string, Execution>();
          for (const step of version.steps) {
            if (step.kind !== 'specialist') continue;
            const executionId = plan.delegations.find((d) => d.stepId === step.id)?.executionId;
            if (executionId === undefined) continue;
            children.set(step.id, await steps.executions.get(tenant, executionId));
          }
          const conditionOf = (id: string) => plan.conditions?.find((c) => c.stepId === id);
          const approvalOf = (id: string) => plan.stepApprovals?.find((a) => a.stepId === id);
          const states = planStepStates(version.steps, (step) => {
            if (step.kind === 'condition') return conditionStepState(conditionOf(step.id));
            const child = children.get(step.id);
            if (child === undefined) return 'waiting';
            // A step that asked a person (ADR-0146): waiting for them, or declined.
            const entry = approvalOf(step.id);
            return entry === undefined
              ? specialistStepState(child)
              : gatedStepState(child, entry.declined === undefined ? 'awaiting' : 'declined');
          });
          const out = [];
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
              // The approval a person decides it with, in the approvals inbox.
              approvalId: approvalOf(step.id)?.approvalId ?? null,
              // Why a declined step never ran: rejected, expired or withdrawn (ADR-0146).
              failure: approvalOf(step.id)?.declined?.reason ?? execution?.failure?.code ?? null,
              outcome: null,
              answer: answered?.answer ?? null,
              missing: answered === undefined ? [] : [...answered.missing],
            });
          }
          return { planId: plan.id, status: plan.status, steps: out };
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
