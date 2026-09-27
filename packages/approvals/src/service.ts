import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditResult,
  type AuditService,
} from '@melonoffice/audit';
import type { Approval, ApprovalId, OrganizationId } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { ApprovalError } from './errors.js';
import { decide, hasExpired, isApprovalId, newApproval, type ApprovalRequest } from './model.js';
import type { ApprovalRepository } from './repository.js';

export const MAX_APPROVALS_LISTED = 100;

/** What the tool gate gives to ask for an approval. The requester is the tenant's user. */
export type ApprovalRequestInput = Omit<ApprovalRequest, 'requestedBy'>;

/**
 * Tool approvals of an organization (ADR-0026). Every method works on the organization of a
 * resolved `TenantContext`, never on an id the caller passes. Approving and rejecting need
 * `approval.approve` and the user acting directly: GIA can ask for an approval on a user's
 * behalf, but never decide one.
 */
export interface ApprovalService {
  /** Server side only: the tool gate asks for an approval for exactly one operation. */
  request(tenant: TenantContext, request: ApprovalRequestInput): Promise<Approval>;
  list(tenant: TenantContext): Promise<readonly Approval[]>;
  /** `approval_not_found` for an unknown id or another organization's approval alike. */
  get(tenant: TenantContext, id: string): Promise<Approval>;
  approve(tenant: TenantContext, id: string): Promise<Approval>;
  reject(tenant: TenantContext, id: string): Promise<Approval>;
  /** Records the expiry of a pending approval whose time has passed. */
  expire(tenant: TenantContext, id: string): Promise<Approval>;
  /** Withdraws a pending approval, e.g. because its execution ended. `reason` is a stable code. */
  cancel(tenant: TenantContext, id: string, reason: string): Promise<Approval>;
}

export interface ApprovalServiceOptions {
  readonly repository: ApprovalRepository;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** Records refused decisions, which change nothing and so have no write of their own. */
  readonly audit?: AuditService;
  readonly now?: () => Date;
  readonly requestId?: string;
}

type ApprovalAction = Extract<AuditAction, `tool.approval_${string}`>;

export function createApprovalService({
  repository,
  organizations,
  authorization,
  audit,
  now = () => new Date(),
  requestId,
}: ApprovalServiceOptions): ApprovalService {
  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new ApprovalError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new ApprovalError('organization_inactive');
    }
    return organization.id;
  }

  const idOf = (id: string): ApprovalId => {
    // A malformed id cannot exist: answered like any unknown id, without a lookup.
    if (!isApprovalId(id)) throw new ApprovalError('approval_not_found');
    return id;
  };

  const event = (
    tenant: TenantContext,
    approval: Pick<Approval, 'id' | 'organizationId' | 'operation'>,
    action: ApprovalAction,
    result: AuditResult,
    at: Date,
    fields: { readonly from?: string; readonly to?: string; readonly reason?: string } = {},
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result,
        actor: actorOf(tenant),
        organizationId: approval.organizationId,
        target: { type: 'approval', id: approval.id },
        tool: { id: approval.operation.toolId, version: approval.operation.toolVersion },
        ...(fields.from !== undefined && fields.to !== undefined
          ? { transition: { from: fields.from, to: fields.to } }
          : {}),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  async function get(tenant: TenantContext, id: string): Promise<Approval> {
    const organizationId = await organizationOf(tenant);
    const approval = await repository.find(organizationId, idOf(id));
    if (approval === undefined) throw new ApprovalError('approval_not_found');
    return approval;
  }

  /** Records the expiry of a pending approval found expired, then refuses the decision. */
  async function expireThenRefuse(tenant: TenantContext, approval: Approval): Promise<never> {
    const at = now();
    await repository.update(approval.organizationId, approval.id, (current) => {
      const next = decide(current, 'expired', undefined, at);
      return {
        approval: next,
        events: [
          event(tenant, next, 'tool.approval_expired', 'success', at, {
            from: 'pending',
            to: 'expired',
          }),
        ],
      };
    });
    throw new ApprovalError('approval_expired');
  }

  async function decideByUser(
    tenant: TenantContext,
    id: string,
    to: 'approved' | 'rejected',
  ): Promise<Approval> {
    const organizationId = await organizationOf(tenant);
    const action = to === 'approved' ? 'tool.approval_approved' : 'tool.approval_rejected';
    const approval = await repository.find(organizationId, idOf(id));
    if (approval === undefined) throw new ApprovalError('approval_not_found');
    const refuse = async (reason: string): Promise<never> => {
      await audit?.record({
        action,
        result: 'denied',
        actor: actorOf(tenant),
        organizationId,
        target: { type: 'approval', id: approval.id },
        tool: { id: approval.operation.toolId, version: approval.operation.toolVersion },
        reason,
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      });
      throw new ApprovalError('approval_forbidden', reason);
    };
    // Only a user acting directly decides (ADR-0026, ADR-0029). The runtime acts for a user but is
    // never that user: it can not approve or reject, not even what the user who started it asked for.
    if (tenant.actor === 'runtime') return refuse('runtime_cannot_decide');
    if (tenant.actor !== 'user') return refuse('gia_cannot_decide');
    const decision = authorization.authorize(tenant, 'approval.approve', { organizationId });
    if (!decision.allowed) return refuse(decision.reason);
    if (approval.status === 'pending' && hasExpired(approval, now())) {
      return expireThenRefuse(tenant, approval);
    }
    const at = now();
    return repository.update(organizationId, approval.id, (current) => {
      const next = decide(current, to, tenant.userId, at);
      return {
        approval: next,
        events: [event(tenant, next, action, 'success', at, { from: current.status, to })],
      };
    });
  }

  return Object.freeze({
    async request(tenant: TenantContext, request: ApprovalRequestInput) {
      const organizationId = await organizationOf(tenant);
      // The organization comes from the tenant: an operation for any other one is refused.
      if (request.operation.organizationId !== organizationId) {
        throw new ApprovalError('invalid_approval', 'organizationId');
      }
      const at = now();
      const approval = newApproval({ ...request, requestedBy: tenant.userId }, at);
      await repository.create({
        approval,
        events: [event(tenant, approval, 'tool.approval_requested', 'success', at)],
      });
      return approval;
    },

    async list(tenant: TenantContext) {
      return repository.list(await organizationOf(tenant), MAX_APPROVALS_LISTED);
    },

    get,

    approve: (tenant: TenantContext, id: string) => decideByUser(tenant, id, 'approved'),
    reject: (tenant: TenantContext, id: string) => decideByUser(tenant, id, 'rejected'),

    async expire(tenant: TenantContext, id: string) {
      const organizationId = await organizationOf(tenant);
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        const next = decide(current, 'expired', undefined, at);
        return {
          approval: next,
          events: [
            event(tenant, next, 'tool.approval_expired', 'success', at, {
              from: 'pending',
              to: 'expired',
            }),
          ],
        };
      });
    },

    async cancel(tenant: TenantContext, id: string, reason: string) {
      const organizationId = await organizationOf(tenant);
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        const next = decide(current, 'cancelled', undefined, at);
        return {
          approval: next,
          events: [
            event(tenant, next, 'tool.approval_cancelled', 'success', at, {
              from: 'pending',
              to: 'cancelled',
              reason,
            }),
          ],
        };
      });
    },
  });
}
