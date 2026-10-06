import { isApprovalError, type ApprovalService } from '@melonoffice/approvals';
import type { Approval } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Approval routes (ADR-0026). Tenancy picks the organization from the caller's membership and
 * RBAC checks `approval.read` or `approval.approve`; only then is the approval read or decided,
 * from the resolved tenant. Nothing is read from the body, query or headers: an approval is
 * decided by its id alone. Another organization's approval answers exactly like a missing one,
 * and GIA cannot approve or reject.
 */
export function registerApprovalRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly approvals: ApprovalService;
    /**
     * Told once a person decided an approval (CV-6B): an agent's turn waiting on it is handed back
     * to the worker. It never changes the answer.
     */
    readonly afterDecision?: (tenant: TenantContext, approval: Approval) => Promise<void>;
  },
): void {
  const { approvals, afterDecision } = dependencies;
  const decided = async (tenant: TenantContext, approval: Approval): Promise<Approval> => {
    await afterDecision?.(tenant, approval);
    return approval;
  };
  const base = '/v1/organizations/:organizationId/approvals';

  app.get(
    base,
    withPermission('approval.read', dependencies, async (c, tenant) =>
      c.json({ approvals: (await approvals.list(tenant)).map(toApprovalView) }),
    ),
  );

  app.get(
    `${base}/:approvalId`,
    withPermission('approval.read', dependencies, async (c, tenant) =>
      answer(c, () => approvals.get(tenant, c.req.param('approvalId') ?? '')),
    ),
  );

  app.post(
    `${base}/:approvalId/approve`,
    withPermission('approval.approve', dependencies, async (c, tenant) =>
      answer(c, async () =>
        decided(tenant, await approvals.approve(tenant, c.req.param('approvalId') ?? '')),
      ),
    ),
  );

  app.post(
    `${base}/:approvalId/reject`,
    withPermission('approval.approve', dependencies, async (c, tenant) =>
      answer(c, async () =>
        decided(tenant, await approvals.reject(tenant, c.req.param('approvalId') ?? '')),
      ),
    ),
  );
}

const STATUS = {
  approval_not_found: 404,
  approval_forbidden: 403,
  approval_not_pending: 409,
  approval_expired: 409,
  approval_concurrency_conflict: 409,
} as const;

async function answer(c: Context<AuthEnv>, work: () => Promise<Approval>): Promise<Response> {
  try {
    return c.json(toApprovalView(await work()));
  } catch (error) {
    if (isApprovalError(error) && Object.hasOwn(STATUS, error.code)) {
      const code = error.code as keyof typeof STATUS;
      return c.json({ error: code }, STATUS[code]);
    }
    throw error;
  }
}

/**
 * The public view: what is asked, for which exact tool version and execution node, and its
 * status. The input digest, binding digest and revision are internal and not shown.
 */
export function toApprovalView(approval: Approval) {
  const o = approval.operation;
  return {
    id: approval.id,
    status: approval.status,
    riskLevel: approval.riskLevel,
    reason: approval.reason,
    impact: approval.impact,
    estimatedCredits: approval.estimatedCredits ?? null,
    executionId: o.executionId,
    nodeId: o.nodeId,
    specialist: { id: o.specialistId, version: o.specialistVersion },
    tool: { id: o.toolId, version: o.toolVersion },
    action: o.action,
    requestedBy: approval.requestedBy,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    decidedAt: approval.decidedAt ?? null,
    decidedBy: approval.decidedBy ?? null,
    // Why it was withdrawn (ADR-0181), as a stable code.
    cancelReason: approval.cancelReason ?? null,
  };
}
