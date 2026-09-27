import type { Plan, PlanStep, PlanVersion } from '@melonoffice/domain';
import { isPlanningError, type PlanService } from '@melonoffice/planning';
import { withCorrelation } from '@melonoffice/observability';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Plan routes (ADR-0028). Plans are made by the planner or a workflow on the server, never by a
 * client: there is no route that creates, runs or delegates a plan. A user may read plans
 * (`plan.read`) and approve or reject one exact version (`approval.approve`, acting directly,
 * never through GIA). The decision body carries only the version and digest the user saw; any
 * other field is refused. Another organization's plan answers exactly like a missing one.
 */
export function registerPlanRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly plans: PlanService },
): void {
  const { plans } = dependencies;
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
          const plan = await decide(tenant, c.req.param('planId') ?? '', seen);
          withCorrelation(c.get('logger'), { planId: plan.id }).info(`plan ${action}`);
          return toPlanView(plan);
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
  permission_denied: 403,
  plan_version_mismatch: 409,
  plan_concurrency_conflict: 409,
  invalid_plan_transition: 409,
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
  retry:
    s.retry === undefined
      ? null
      : { maxAttempts: s.retry.maxAttempts, backoffMs: s.retry.backoffMs },
  approvalRequired: s.approvalRequired,
  estimate: s.estimate === undefined ? null : { ...s.estimate },
});

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
    estimate: { ...v.estimate },
    source:
      v.source.kind === 'planner'
        ? {
            kind: 'planner',
            model: {
              provider: v.source.model.provider,
              id: v.source.model.id,
              version: v.source.model.version,
            },
            policy: { id: v.source.policy.id, version: v.source.policy.version },
          }
        : {
            kind: 'workflow',
            workflowId: v.source.workflowId,
            workflowVersion: v.source.workflowVersion,
          },
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  };
}
