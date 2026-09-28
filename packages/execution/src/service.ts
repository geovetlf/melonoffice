import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type {
  Execution,
  ExecutionId,
  ExecutionNode,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { ExecutionError, isExecutionError } from './errors.js';
import { isTerminal } from './lifecycle.js';
import {
  addNodes,
  applyNodeChange,
  applyStatusChange,
  assignmentOf,
  checkSnapshot,
  isExecutionId,
  markOutcomeUnknown,
  newExecution,
  recordVerification,
  retryNode,
  retryRuleOf,
  startExecution,
  type NewExecution,
  type NodeChange,
  type NodeInput,
  type SpecialistAssignment,
  type StatusChange,
  type VerificationInput,
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
  /**
   * The planning lifecycle (ADR-0028, ADR-0031): status changes of a planning execution
   * (`mode: plan`), made by the planner and plan decisions for a user or GIA, and withdrawing an
   * execution that never started (`pending → cancelled`). Everything else is refused
   * (`actor_not_allowed`): the runtime drives executions with `runtimeChangeStatus`, and a
   * person starts and cancels with `start` and `cancel`.
   */
  changeStatus(tenant: TenantContext, id: string, change: StatusChange): Promise<Execution>;
  addNodes(tenant: TenantContext, id: string, nodes: readonly NodeInput[]): Promise<Execution>;
  /**
   * The runtime moves an execution while it processes it (ADR-0031): only a `runtime` context.
   * Cancelling is never the runtime's, and the X1/X6a model rules apply unchanged (no
   * `verifying` with unfinished nodes, no `completed` without passing evidence).
   */
  runtimeChangeStatus(tenant: TenantContext, id: string, change: StatusChange): Promise<Execution>;
  /**
   * The runtime moves one node (ADR-0031): only a `runtime` context, recorded as
   * `execution.node_changed` in the same write. There is no other way to change a node's status
   * than this and the tool gate, which is itself runtime only.
   */
  runtimeChangeNode(tenant: TenantContext, id: string, change: NodeChange): Promise<Execution>;
  /**
   * A user's start (ADR-0029): `pending → running`. Only a user acting directly, with
   * `execution.start`; GIA, the planner, delegation and the runtime never start anything. A
   * second start, or a concurrent one, returns the execution already started and changes nothing.
   */
  start(tenant: TenantContext, id: string): Promise<Execution>;
  /**
   * A delegated start (ADR-0043): `pending → running` by the runtime, on behalf of the person
   * whose runtime context it is, for work that person configured to start by itself (an agent's
   * turn on a conversation). Only a `runtime` context, and its person must still hold
   * `execution.start`: the runtime never starts what that person could not. Idempotent as `start`.
   */
  runtimeStart(tenant: TenantContext, id: string): Promise<Execution>;
  /**
   * A user's cancellation (ADR-0029), cooperative: the execution is marked `cancelled` and every
   * child its delegation created is cancelled with it. Nothing is killed; work still running
   * finds the execution ended and its late result is discarded. Cancelling again changes nothing
   * but reaches any child created since.
   */
  cancel(tenant: TenantContext, id: string, reason: string): Promise<Execution>;
  /** The runtime records a verifier's evidence for the current `verifying` pass (ADR-0029). */
  recordVerification(
    tenant: TenantContext,
    id: string,
    verification: VerificationInput,
  ): Promise<Execution>;
  /** The runtime re-runs a failed node, when the attempt rules allow it (ADR-0029). */
  retryNode(tenant: TenantContext, id: string, nodeId: string): Promise<Execution>;
  /** The runtime records that a running node's outcome is unknown; it is never re-run. */
  markOutcomeUnknown(tenant: TenantContext, id: string, nodeId: string): Promise<Execution>;
}

/**
 * Finds the children an execution's delegation created, so a cancellation reaches them
 * (ADR-0029). Planning implements it from the plan's delegations and cancels the plan itself;
 * executions only ask. It returns child ids, never changes an execution.
 */
export interface CancellationCascade {
  cancelled(
    tenant: TenantContext,
    execution: Execution,
    reason: string,
  ): Promise<readonly ExecutionId[]>;
}

/** The part of RBAC this service asks (ADR-0019). */
export interface ExecutionAuthorization {
  authorize(
    tenant: TenantContext,
    permission: 'execution.start' | 'execution.cancel',
    resource: { readonly organizationId: OrganizationId },
  ): { readonly allowed: boolean; readonly reason?: string };
}

/** Where refusals are recorded. Successful changes are written with the execution instead. */
export interface ExecutionAuditLog {
  record(input: Parameters<typeof buildAuditEvent>[0]): Promise<unknown>;
}

/**
 * Confirms that a tenant may give an execution to one specialist version (ADR-0025). The
 * specialists package implements it; executions only ask. It throws
 * `specialist_not_eligible` when the specialist cannot take the work.
 */
export interface AssignmentGuard {
  confirm(tenant: TenantContext, assignment: SpecialistAssignment): Promise<void>;
}

export interface ExecutionServiceOptions {
  readonly repository: ExecutionRepository;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  /**
   * Checks an execution's specialist before it is created. Without it, an execution that names
   * a specialist is refused: nothing is assigned unchecked.
   */
  readonly assignments?: AssignmentGuard;
  /** Checks `execution.start` and `execution.cancel`. Without it, both are refused. */
  readonly authorization?: ExecutionAuthorization;
  /** Records refused starts and cancellations. Without it, both are refused. */
  readonly audit?: ExecutionAuditLog;
  /** Reaches the children of a cancelled execution. Without it, only the execution is cancelled. */
  readonly cascade?: CancellationCascade;
  readonly now?: () => Date;
  /** The request that asked, to correlate audit events and logs. */
  readonly requestId?: string;
}

/** A cancellation reaches children, and their children, this deep at most. */
const MAX_CASCADE_DEPTH = 4;
const CODE = /^[a-z][a-z_]{0,63}$/;

export function createExecutionService({
  repository,
  organizations,
  assignments,
  authorization,
  audit,
  cascade,
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
    fields: Partial<Pick<AuditEvent, 'transition' | 'reason' | 'nodeId'>> & {
      action:
        | 'execution.created'
        | 'execution.state_changed'
        | 'execution.node_changed'
        | 'execution.verification_recorded'
        | 'execution.node_retried'
        | 'execution.node_outcome_unknown';
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
        ...(fields.nodeId === undefined ? {} : { nodeId: fields.nodeId }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  /**
   * Who may control an execution: a user acting directly, holding the permission. GIA and the
   * runtime are refused before RBAC is asked, and every refusal is recorded.
   */
  async function authorizeControl(
    tenant: TenantContext,
    organizationId: OrganizationId,
    id: ExecutionId,
    kind: 'start' | 'cancel',
    delegated = false,
  ): Promise<void> {
    const reason =
      delegated && tenant.actor !== 'runtime'
        ? 'runtime_only'
        : !delegated && tenant.actor === 'runtime'
          ? `runtime_cannot_${kind}`
          : !delegated && tenant.actor !== 'user'
            ? `gia_cannot_${kind}`
            : authorization === undefined || audit === undefined
              ? 'not_configured'
              : (() => {
                  const decision = authorization.authorize(tenant, `execution.${kind}`, {
                    organizationId,
                  });
                  return decision.allowed ? undefined : (decision.reason ?? 'permission_denied');
                })();
    if (reason === undefined) return;
    if (audit !== undefined) {
      await audit.record({
        action: kind === 'start' ? 'execution.start_denied' : 'execution.cancel_denied',
        result: 'denied',
        actor: actorOf(tenant),
        organizationId,
        target: { type: 'execution', id },
        reason,
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      });
    }
    if (reason.endsWith(`_cannot_${kind}`) || reason === 'runtime_only') {
      throw new ExecutionError('actor_not_allowed', reason);
    }
    throw new ExecutionError('permission_denied', reason);
  }

  /** Runtime-only operations: the runtime records evidence and retries; people and GIA do not. */
  function requireRuntime(tenant: TenantContext): void {
    if (tenant.actor !== 'runtime') throw new ExecutionError('actor_not_allowed', 'runtime_only');
  }

  /** Cancels one execution, as `userId` asked, unless it already ended. Returns its state. */
  async function cancelOne(
    tenant: TenantContext,
    organizationId: OrganizationId,
    id: ExecutionId,
    reason: string,
  ): Promise<Execution> {
    const at = now();
    try {
      return await repository.update(organizationId, id, (current) => {
        const next = applyStatusChange(
          current,
          { from: current.status, to: 'cancelled', reason },
          tenant.userId as UserId,
          at.toISOString() as IsoTimestamp,
        );
        return {
          execution: next,
          events: [
            event(
              tenant,
              next,
              {
                action: 'execution.state_changed',
                transition: { from: current.status, to: 'cancelled' },
                reason,
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      if (!isExecutionError(error) || error.code !== 'execution_already_terminal') throw error;
      const ended = await repository.find(organizationId, id);
      if (ended === undefined) throw new ExecutionError('execution_not_found');
      return ended;
    }
  }

  /** Cancels an execution's children, and theirs, through the cascade. Idempotent. */
  async function cascadeFrom(
    tenant: TenantContext,
    organizationId: OrganizationId,
    parent: Execution,
    reason: string,
    depth: number,
  ): Promise<void> {
    if (cascade === undefined || depth > MAX_CASCADE_DEPTH) return;
    const children = await cascade.cancelled(tenant, parent, reason);
    for (const childId of children) {
      const child = await repository.find(organizationId, childId);
      // A child the delegation has not created yet can never start: its parent has ended.
      if (child === undefined || child.parentExecutionId !== parent.id) continue;
      const ended = isTerminal(child.status)
        ? child
        : await cancelOne(tenant, organizationId, child.id, 'parent_cancelled');
      if (ended.status === 'cancelled') {
        await cascadeFrom(tenant, organizationId, ended, 'parent_cancelled', depth + 1);
      }
    }
  }

  /** A runtime change to one execution, recorded with one audit event. */
  async function runtimeChange(
    tenant: TenantContext,
    id: string,
    action:
      | 'execution.verification_recorded'
      | 'execution.node_retried'
      | 'execution.node_outcome_unknown',
    apply: (current: Execution, at: IsoTimestamp) => { next: Execution; reason: string },
    nodeId?: string,
  ): Promise<Execution> {
    requireRuntime(tenant);
    const organizationId = await organizationOf(tenant);
    const at = now();
    return repository.update(organizationId, idOf(id), (current) => {
      const { next, reason } = apply(current, at.toISOString() as IsoTimestamp);
      return {
        execution: next,
        events: [
          event(tenant, next, { action, reason, ...(nodeId === undefined ? {} : { nodeId }) }, at),
        ],
      };
    });
  }

  /** A status change and its event, in one write. The model decides whether it is allowed. */
  function statusWrite(tenant: TenantContext, change: StatusChange, at: Date) {
    return (current: Execution) => {
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
    };
  }

  /** A start, by a user (`start`) or by the runtime on its person's behalf (`runtimeStart`). */
  async function startOne(
    tenant: TenantContext,
    id: string,
    delegated: boolean,
  ): Promise<Execution> {
    const organizationId = await organizationOf(tenant);
    const executionId = idOf(id);
    // A forged or foreign id is unknown before anyone is asked about permissions.
    const found = await repository.find(organizationId, executionId);
    if (found === undefined) throw new ExecutionError('execution_not_found');
    await authorizeControl(tenant, organizationId, executionId, 'start', delegated);
    // The runtime starts only what its own person created: never another person's work.
    if (delegated && found.userId !== tenant.userId) {
      throw new ExecutionError('actor_not_allowed', 'not_own_execution');
    }
    const started = (execution: Execution): boolean =>
      execution.startedAt !== undefined && !isTerminal(execution.status);
    if (started(found)) return found;
    if (isTerminal(found.status)) throw new ExecutionError('execution_already_terminal');
    if (found.parentExecutionId !== undefined) {
      const parent = await repository.find(organizationId, found.parentExecutionId);
      if (parent === undefined || isTerminal(parent.status)) {
        throw new ExecutionError('execution_parent_ended');
      }
    }
    const at = now();
    try {
      return await repository.update(organizationId, executionId, (current) => {
        const next = startExecution(current, at.toISOString() as IsoTimestamp);
        return {
          execution: next,
          events: [
            event(
              tenant,
              next,
              {
                action: 'execution.state_changed',
                transition: { from: current.status, to: next.status },
                reason: delegated ? 'delegated_start' : 'user_started',
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      // Another start won: the execution runs once, and this caller sees it running.
      if (!isExecutionError(error) || error.code !== 'execution_concurrency_conflict') throw error;
      const fresh = await repository.find(organizationId, executionId);
      if (fresh !== undefined && started(fresh)) return fresh;
      throw error;
    }
  }

  return {
    async create(tenant, request) {
      const organizationId = await organizationOf(tenant);
      const assignment = assignmentOf(request, checkSnapshot(request.versionSnapshot));
      if (assignment !== undefined) {
        if (assignments === undefined) {
          throw new ExecutionError('specialist_not_eligible', 'no_assignment_guard');
        }
        await assignments.confirm(tenant, assignment);
      }
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
      // Cancelling is a person's call: the runtime finds an execution cancelled, it never
      // cancels one (ADR-0029). And the runtime has its own, runtime-only method (ADR-0031).
      if (tenant.actor === 'runtime') {
        throw new ExecutionError(
          'actor_not_allowed',
          change.to === 'cancelled' ? 'runtime_cannot_cancel' : 'runtime_uses_runtime_change',
        );
      }
      const organizationId = await organizationOf(tenant);
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        // Only the planning lifecycle, and withdrawing work that never started. Running work is
        // the runtime's (ADR-0031); starting and cancelling it is a person's (ADR-0029).
        const withdrawn = change.to === 'cancelled' && current.status === 'pending';
        if (current.mode !== 'plan' && !withdrawn) {
          throw new ExecutionError('actor_not_allowed', 'runtime_transition');
        }
        return statusWrite(tenant, change, at)(current);
      });
    },

    async runtimeChangeStatus(tenant, id, change) {
      requireRuntime(tenant);
      if (change.to === 'cancelled') {
        throw new ExecutionError('actor_not_allowed', 'runtime_cannot_cancel');
      }
      const organizationId = await organizationOf(tenant);
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        // The runtime drives work, not plans: a planning execution runs nothing itself.
        if (current.mode === 'plan')
          throw new ExecutionError('actor_not_allowed', 'plan_execution');
        return statusWrite(tenant, change, at)(current);
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

    async runtimeChangeNode(tenant, id, change) {
      requireRuntime(tenant);
      const organizationId = await organizationOf(tenant);
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        if (current.mode === 'plan')
          throw new ExecutionError('actor_not_allowed', 'plan_execution');
        const next = applyNodeChange(current, change, at.toISOString() as IsoTimestamp);
        const reason = change.to === 'failed' ? change.error?.code : undefined;
        return {
          execution: next,
          events: [
            event(
              tenant,
              next,
              {
                action: 'execution.node_changed',
                nodeId: change.nodeId,
                transition: { from: change.from, to: change.to },
                ...(reason === undefined ? {} : { reason }),
              },
              at,
            ),
          ],
        };
      });
    },

    start: (tenant, id) => startOne(tenant, id, false),

    runtimeStart: (tenant, id) => startOne(tenant, id, true),

    async cancel(tenant, id, reason) {
      const organizationId = await organizationOf(tenant);
      const executionId = idOf(id);
      const found = await repository.find(organizationId, executionId);
      if (found === undefined) throw new ExecutionError('execution_not_found');
      await authorizeControl(tenant, organizationId, executionId, 'cancel');
      if (typeof reason !== 'string' || !CODE.test(reason)) {
        throw new ExecutionError('invalid_execution', 'reason');
      }
      if (isTerminal(found.status) && found.status !== 'cancelled') {
        throw new ExecutionError('execution_already_terminal');
      }
      const cancelled =
        found.status === 'cancelled'
          ? found
          : await cancelOne(tenant, organizationId, executionId, reason);
      if (cancelled.status !== 'cancelled') throw new ExecutionError('execution_already_terminal');
      await cascadeFrom(tenant, organizationId, cancelled, reason, 1);
      return cancelled;
    },

    recordVerification: (tenant, id, verification) =>
      runtimeChange(tenant, id, 'execution.verification_recorded', (current, at) => {
        const next = recordVerification(current, verification, at);
        return { next, reason: `verification_${next.verification?.result ?? 'failed'}` };
      }),

    retryNode: (tenant, id, nodeId) =>
      runtimeChange(
        tenant,
        id,
        'execution.node_retried',
        (current, at) => {
          const next = retryNode(current, nodeId, at);
          // retryNode accepted it, so the node exists and was failed: name the rule that allowed it.
          const node = current.nodes.find((n) => n.id === nodeId) as ExecutionNode;
          return { next, reason: retryRuleOf(node) };
        },
        nodeId,
      ),

    markOutcomeUnknown: (tenant, id, nodeId) =>
      runtimeChange(
        tenant,
        id,
        'execution.node_outcome_unknown',
        (current, at) => ({
          next: markOutcomeUnknown(current, nodeId, at),
          reason: 'outcome_unknown',
        }),
        nodeId,
      ),
  };
}
