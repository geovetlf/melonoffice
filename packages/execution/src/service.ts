import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type { Execution, ExecutionId, IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { ExecutionError } from './errors.js';
import {
  addNodes,
  applyNodeChange,
  applyStatusChange,
  isExecutionId,
  newExecution,
  type NewExecution,
  type NodeChange,
  type NodeInput,
  type StatusChange,
} from './model.js';
import type { ExecutionRepository } from './repository.js';

/** What a caller gives to create an execution. The organization and user come from the tenant. */
export type ExecutionRequest = Omit<NewExecution, 'organizationId' | 'userId'>;

/**
 * Executions of an organization (ADR-0024). Every method works on the organization of a
 * resolved `TenantContext`, never on an id the caller passes, and records the tenant's user as
 * the actor. It runs nothing: planners, agents, tools and workflows will drive executions
 * through it. There is no client route that creates or changes one.
 */
export interface ExecutionService {
  create(tenant: TenantContext, request: ExecutionRequest): Promise<Execution>;
  /** `execution_not_found` for an unknown id or another organization's execution alike. */
  get(tenant: TenantContext, id: string): Promise<Execution>;
  changeStatus(tenant: TenantContext, id: string, change: StatusChange): Promise<Execution>;
  addNodes(tenant: TenantContext, id: string, nodes: readonly NodeInput[]): Promise<Execution>;
  changeNode(tenant: TenantContext, id: string, change: NodeChange): Promise<Execution>;
}

export interface ExecutionServiceOptions {
  readonly repository: ExecutionRepository;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly now?: () => Date;
  /** The request that asked, to correlate audit events and logs. */
  readonly requestId?: string;
}

export function createExecutionService({
  repository,
  organizations,
  now = () => new Date(),
  requestId,
}: ExecutionServiceOptions): ExecutionService {
  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new ExecutionError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new ExecutionError('organization_inactive');
    }
    return organization.id;
  }

  const idOf = (id: string): ExecutionId => {
    // A malformed id cannot exist: answered like any unknown id, without a lookup.
    if (!isExecutionId(id)) throw new ExecutionError('execution_not_found');
    return id;
  };

  const event = (
    tenant: TenantContext,
    execution: Execution,
    fields: Partial<Pick<AuditEvent, 'transition' | 'reason'>> & {
      action: 'execution.created' | 'execution.state_changed';
    },
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        action: fields.action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId: execution.organizationId,
        target: { type: 'execution', id: execution.id },
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  return {
    async create(tenant, request) {
      const organizationId = await organizationOf(tenant);
      const at = now();
      const execution = newExecution(
        {
          ...request,
          organizationId,
          userId: tenant.userId,
          ...(request.requestId === undefined && requestId !== undefined ? { requestId } : {}),
        },
        at.toISOString() as IsoTimestamp,
      );
      await repository.create({
        execution,
        events: [event(tenant, execution, { action: 'execution.created' }, at)],
      });
      return execution;
    },

    async get(tenant, id) {
      const organizationId = await organizationOf(tenant);
      const execution = await repository.find(organizationId, idOf(id));
      if (execution === undefined) throw new ExecutionError('execution_not_found');
      return execution;
    },

    async changeStatus(tenant, id, change) {
      const organizationId = await organizationOf(tenant);
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        const next = applyStatusChange(
          current,
          change,
          tenant.userId,
          at.toISOString() as IsoTimestamp,
        );
        const reason =
          next.cancellation?.reason ?? (change.to === 'failed' ? next.failure?.code : undefined);
        return {
          execution: next,
          events: [
            event(
              tenant,
              next,
              {
                action: 'execution.state_changed',
                transition: { from: current.status, to: next.status },
                ...(reason === undefined ? {} : { reason }),
              },
              at,
            ),
          ],
        };
      });
    },

    // Graph changes are operational detail: they live in the execution itself, not the audit log.
    async addNodes(tenant, id, nodes) {
      const organizationId = await organizationOf(tenant);
      const at = now().toISOString() as IsoTimestamp;
      return repository.update(organizationId, idOf(id), (current) => ({
        execution: addNodes(current, nodes, at),
        events: [],
      }));
    },

    async changeNode(tenant, id, change) {
      const organizationId = await organizationOf(tenant);
      const at = now().toISOString() as IsoTimestamp;
      return repository.update(organizationId, idOf(id), (current) => ({
        execution: applyNodeChange(current, change, at),
        events: [],
      }));
    },
  };
}
