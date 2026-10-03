import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import { acceptsAssignments, departmentIdOf } from '@melonoffice/departments';
import type {
  AgentHandoff,
  AgentHandoffReason,
  AgentHandoffState,
  AgentTask,
  DepartmentTypeId,
  Execution,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistId,
} from '@melonoffice/domain';
import type { AgentOutputStore } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import { canTakeNewWork, workSettingOf, type SpecialistRepository } from '@melonoffice/specialists';
import type { DepartmentRepository } from '@melonoffice/departments';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { AI_REVIEW_NODE } from './ai-review.js';
import type { AgentNotifier } from './notifications.js';
import { AgentTaskError } from './errors.js';
import type { AgentTaskRepository, AgentTaskService } from './tasks.js';

/**
 * Agents working together (ADR-0117). At the end of a task, an agent whose `collaboration`
 * setting is on may propose to hand part of it to an agent of another department. The agent only
 * proposes, in its answer; MelonOffice decides everything else:
 *
 * - which agent receives it: an active agent of an active department of the same organization,
 *   never the first agent, chosen in a stable order;
 * - whether it may: the person the task is for must be allowed to ask agents for work, and a task
 *   that was itself handed never hands on (one level, the Harness's depth, ADR-0101);
 * - what it may spend: never more than the first task had left of its budget, so no agent gets
 *   round a budget through another;
 * - and a person accepts or declines it. Accepted, the receiving agent gets a task of its own, a
 *   child of the first, which it does with its own version's permissions, skills, tools,
 *   autonomy and policy, through the same Harness, Tool Gate and approvals: nothing is inherited.
 *
 * `agentHandoffs/{parentTaskId}` keeps each handoff: who asked whom, why, with what, its state,
 * who decided, the receiving agent's permissions, and what the receiving task spent.
 */

export const HANDOFF_LIMITS = Object.freeze({
  request: 1000,
  context: 1000,
  /**
   * How long a proposed handoff waits for a person (ADR-0119). After that it is expired: read as
   * refused (`expired`), and accepting or declining it is refused with `handoff_expired`. Nothing
   * sweeps it: it is recorded as refused the first time a person tries to decide it.
   */
  expiryDays: 7,
});

/** Whether a proposed handoff waited longer than it may for a person (ADR-0119). */
export const isHandoffExpired = (
  handoff: Pick<AgentHandoff, 'state' | 'createdAt'>,
  now: Date,
): boolean =>
  handoff.state === 'proposed' &&
  now.getTime() - Date.parse(handoff.createdAt) > HANDOFF_LIMITS.expiryDays * 86_400_000;

/** A handoff as it stands at `now`: one that expired reads as refused, without a write. */
export const handoffAsOf = (handoff: AgentHandoff, now: Date): AgentHandoff =>
  isHandoffExpired(handoff, now)
    ? Object.freeze({ ...handoff, state: 'refused' as const, refusal: 'expired' })
    : handoff;
export const HANDOFF_REASONS: readonly AgentHandoffReason[] = Object.freeze([
  'outside_role',
  'needs_specialist',
  'next_step',
]);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TYPE = /^[a-z][a-z_]{0,40}$/;

/** A handoff an agent asked for in its answer, as far as it can be read. */
export interface ProposedHandoff {
  readonly department: string;
  readonly reason: AgentHandoffReason;
  readonly request: string;
  readonly context: string;
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max || CONTROL.test(trimmed)
    ? undefined
    : trimmed;
};

/** The handoff an answer asked for, or `undefined` when it asked for none or not in shape. */
export function parseProposedHandoff(value: unknown): ProposedHandoff | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { department, reason, request, context } = value as Record<string, unknown>;
  if (typeof department !== 'string' || !TYPE.test(department)) return undefined;
  if (!HANDOFF_REASONS.includes(reason as AgentHandoffReason)) return undefined;
  const asked = text(request, HANDOFF_LIMITS.request);
  const known = text(context, HANDOFF_LIMITS.context) ?? '';
  if (asked === undefined) return undefined;
  return Object.freeze({
    department,
    reason: reason as AgentHandoffReason,
    request: asked,
    context: known,
  });
}

/** The answer's field for a handoff, naming only the departments offered. */
export const handoffSchema = (departments: readonly string[]) =>
  Object.freeze({
    type: ['object', 'null'],
    required: ['department', 'reason', 'request', 'context'],
    properties: {
      department: { type: 'string', enum: [...departments] },
      reason: { type: 'string', enum: [...HANDOFF_REASONS] },
      request: { type: 'string', maxLength: HANDOFF_LIMITS.request },
      context: { type: 'string', maxLength: HANDOFF_LIMITS.context },
    },
  });

/** What the model is told about handing work on. */
export const handoffRules = (departments: readonly string[]): readonly string[] =>
  Object.freeze([
    `You may propose to hand part of this task to an agent of another department, one of: ${departments.join(', ')}. Only when the request needs work outside your role that one of them does ("outside_role"), a specialist's work ("needs_specialist"), or a next step after yours ("next_step"); otherwise handoff is null. A person decides, so never say it was handed over.`,
    'In "handoff", "request" is what that agent should do, in its own words, and "context" what it needs to know from your work, briefly. Never include secrets or anyone\'s personal details.',
  ]);

// ---------------------------------------------------------------------------------------------
// Storage

export interface AgentHandoffWrite {
  readonly handoff: AgentHandoff;
  readonly events: readonly AuditEvent[];
}

/**
 * Where handoffs live: Firestore (`agentHandoffs/{parentTaskId}`), memory in tests. Another
 * organization's handoff is never returned. Each write is stored with its audit events.
 */
export interface AgentHandoffRepository {
  find(organizationId: OrganizationId, id: ExecutionId): Promise<AgentHandoff | undefined>;
  /** Stores a new handoff; one already stored for the same task is returned as it is. */
  create(write: AgentHandoffWrite): Promise<AgentHandoff>;
  /** Reads the handoff and stores what `change` returns, in one transaction. */
  update(
    organizationId: OrganizationId,
    id: ExecutionId,
    change: (current: AgentHandoff) => AgentHandoffWrite,
  ): Promise<AgentHandoff>;
}

export class InMemoryAgentHandoffRepository implements AgentHandoffRepository {
  readonly #handoffs = new Map<string, AgentHandoff>();

  constructor(private readonly audit?: { append(events: readonly AuditEvent[]): Promise<void> }) {}

  async find(organizationId: OrganizationId, id: ExecutionId) {
    const found = this.#handoffs.get(id);
    return found?.organizationId === organizationId ? found : undefined;
  }

  async create(write: AgentHandoffWrite) {
    const stored = this.#handoffs.get(write.handoff.id);
    if (stored !== undefined) return stored;
    await this.audit?.append(write.events);
    this.#handoffs.set(write.handoff.id, Object.freeze({ ...write.handoff }));
    return write.handoff;
  }

  async update(
    organizationId: OrganizationId,
    id: ExecutionId,
    change: (current: AgentHandoff) => AgentHandoffWrite,
  ) {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new AgentTaskError('handoff_not_found');
    const write = change(current);
    if (write.handoff.id !== id || write.handoff.organizationId !== organizationId) {
      throw new Error('handoff identity');
    }
    await this.audit?.append(write.events);
    this.#handoffs.set(id, Object.freeze({ ...write.handoff }));
    return write.handoff;
  }
}

// ---------------------------------------------------------------------------------------------
// Who can receive

/**
 * Where MelonOffice looks for a receiving agent: the organization's active departments of the
 * catalogue and, in each, its active agents, in id order. Read from the stores the API and the
 * worker share; nothing a model says picks the agent.
 */
export interface HandoffDirectory {
  /** The department types an agent may hand to: active, with an agent that can take work. */
  departments(
    organizationId: OrganizationId,
    except: { readonly departmentId: string },
  ): Promise<readonly string[]>;
  /** The agent that receives a handoff to `type`, never `except`, or none. */
  agentFor(
    organizationId: OrganizationId,
    type: string,
    except: SpecialistId,
  ): Promise<Specialist | undefined>;
}

export function createHandoffDirectory(options: {
  readonly departments: Pick<DepartmentRepository, 'list'>;
  readonly specialists: Pick<SpecialistRepository, 'page'>;
}): HandoffDirectory {
  const { departments, specialists } = options;
  async function agentFor(organizationId: OrganizationId, type: string, except: SpecialistId) {
    const departmentId = departmentIdOf(organizationId, type as DepartmentTypeId);
    const page = await specialists.page(organizationId, {
      status: 'active',
      departmentId,
      limit: 5,
    });
    return page.items.find((s) => s.identity.id !== except && canTakeNewWork(s.status));
  }
  return Object.freeze({
    async departments(organizationId: OrganizationId, except: { readonly departmentId: string }) {
      const all = await departments.list(organizationId);
      const types = all.flatMap((d) =>
        d.origin.kind === 'catalog' && acceptsAssignments(d) && d.id !== except.departmentId
          ? [d.origin.typeId as string]
          : [],
      );
      const withAgents = await Promise.all(
        types.map(async (t) =>
          (await agentFor(organizationId, t, '' as SpecialistId)) === undefined ? [] : [t],
        ),
      );
      return Object.freeze(withAgents.flat().sort());
    },
    agentFor,
  });
}

// ---------------------------------------------------------------------------------------------
// Spending

/**
 * What one execution's AI calls spent, in credits: the sum of what each of its agent nodes'
 * kept records says was consumed (ADR-0100). Only the execution's own nodes are read.
 */
export async function creditsSpentBy(
  outputs: Pick<AgentOutputStore, 'find'>,
  tenant: TenantContext,
  execution: Pick<Execution, 'id' | 'nodes'>,
): Promise<number> {
  // Its agent nodes' calls and, when the agent has AI verification on, its review's (ADR-0117).
  const records = await Promise.all([
    ...execution.nodes
      .filter((n) => n.type === 'agent')
      .map((n) => outputs.find(tenant, execution.id, n.id)),
    outputs.find(tenant, execution.id, AI_REVIEW_NODE),
  ]);
  return records.reduce((sum, r) => sum + (r?.ai?.creditsConsumed ?? 0), 0);
}

// ---------------------------------------------------------------------------------------------
// Proposing (the worker, when a task ends)

const auditOf = (
  tenant: TenantContext,
  handoff: AgentHandoff,
  action:
    | 'agent_handoff.proposed'
    | 'agent_handoff.accepted'
    | 'agent_handoff.declined'
    | 'agent_handoff.refused'
    | 'agent_handoff.settled',
  at: Date,
  extra: {
    readonly reason?: string;
    readonly transition?: { readonly from: string; readonly to: string };
    readonly requestId?: string;
  } = {},
): AuditEvent =>
  buildAuditEvent(
    {
      action,
      result: action === 'agent_handoff.refused' ? 'denied' : 'success',
      actor: actorOf(tenant),
      organizationId: handoff.organizationId,
      target: { type: 'agent_handoff', id: handoff.id },
      reference: `execution:${handoff.parentTaskId}`,
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ...(extra.transition === undefined ? {} : { transition: extra.transition }),
      ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
      source: 'api',
    },
    at,
  );

/** Whether a task may propose a handoff: its agent's version allows it and it was not handed. */
export const mayHandOff = (
  task: Pick<AgentTask, 'parentTaskId'>,
  configuration: Parameters<typeof workSettingOf>[0],
): boolean => task.parentTaskId === undefined && workSettingOf(configuration, 'collaboration');

/**
 * Records the handoff a finished task proposed (ADR-0117), as the runtime for the person it ran
 * for. A handoff MelonOffice cannot honour is recorded as refused, with why, and never put to a
 * person. Returns the stored handoff, or none when the task proposed none it may.
 */
export function createHandoffRecorder(options: {
  readonly repository: AgentHandoffRepository;
  readonly tasks: Pick<AgentTaskRepository, 'find'>;
  readonly specialists: Pick<SpecialistRepository, 'findVersion'>;
  readonly directory: HandoffDirectory;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
}): {
  record(
    tenant: TenantContext,
    task: {
      readonly taskId: ExecutionId;
      readonly specialistId: SpecialistId;
      readonly specialistVersion: number;
    },
    proposed: ProposedHandoff,
  ): Promise<AgentHandoff | undefined>;
} {
  const { repository, tasks, specialists, directory, authorization } = options;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async record(tenant, facts, proposed) {
      if (!isResolvedTenant(tenant)) return undefined;
      const organizationId = tenant.organizationId as OrganizationId;
      const [task, version] = await Promise.all([
        tasks.find(organizationId, facts.taskId),
        specialists.findVersion(organizationId, facts.specialistId, facts.specialistVersion),
      ]);
      if (task === undefined || version === undefined) return undefined;
      if (!mayHandOff(task, version.configuration)) return undefined;
      const offered = await directory.departments(organizationId, {
        departmentId: version.configuration.departmentId,
      });
      if (!offered.includes(proposed.department)) return undefined;
      const at = now();
      const stamp = at.toISOString() as IsoTimestamp;
      const receiving = await directory.agentFor(
        organizationId,
        proposed.department,
        facts.specialistId,
      );
      const refusal =
        receiving === undefined
          ? 'no_agent_available'
          : !authorization.authorize(tenant, 'specialist.task').allowed
            ? 'permission_denied'
            : undefined;
      const handoff: AgentHandoff = Object.freeze({
        id: facts.taskId,
        organizationId,
        parentTaskId: facts.taskId,
        requestingAgent: { specialistId: facts.specialistId, version: facts.specialistVersion },
        department: proposed.department,
        ...(receiving === undefined
          ? {}
          : {
              receivingAgent: { specialistId: receiving.identity.id, version: receiving.version },
            }),
        reason: proposed.reason,
        request: proposed.request,
        context: proposed.context,
        state: refusal === undefined ? 'proposed' : 'refused',
        ...(refusal === undefined ? {} : { refusal }),
        createdAt: stamp,
        updatedAt: stamp,
      });
      return repository.create({
        handoff,
        events: [
          refusal === undefined
            ? auditOf(tenant, handoff, 'agent_handoff.proposed', at, { reason: proposed.reason })
            : auditOf(tenant, handoff, 'agent_handoff.refused', at, { reason: refusal }),
        ],
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Deciding (a person, through the API)

/** A handoff as a person reads it. */
export type AgentHandoffView = AgentHandoff;

export interface AgentHandoffService {
  /** `specialist.read`: the handoff a task proposed, if any. */
  get(tenant: TenantContext, taskId: string): Promise<AgentHandoff | undefined>;
  /**
   * `specialist.task`, a person directly: accepts a proposed handoff. The receiving agent gets its
   * own task, a child of the first, with a budget no larger than what the first had left.
   */
  accept(tenant: TenantContext, taskId: string): Promise<AgentHandoff>;
  /** `specialist.task`, a person directly: declines it. Nothing is started. */
  decline(tenant: TenantContext, taskId: string): Promise<AgentHandoff>;
}

export function createAgentHandoffService(options: {
  readonly repository: AgentHandoffRepository;
  readonly tasks: Pick<AgentTaskRepository, 'find'>;
  /** Starts the receiving agent's task: the same service a person asks agents with. */
  readonly assign: Pick<AgentTaskService, 'assign'>;
  readonly specialists: Pick<SpecialistRepository, 'find' | 'findVersion'>;
  readonly directory: HandoffDirectory;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** What the first task already spent, in credits. */
  readonly spent: (tenant: TenantContext, taskId: ExecutionId) => Promise<number>;
  /** Tells the person the receiving agent got the work (ADR-0117). Absent: no notice. */
  readonly notifier?: AgentNotifier;
  readonly now?: () => Date;
  readonly requestId?: string;
}): AgentHandoffService {
  const {
    repository,
    tasks,
    assign,
    specialists,
    directory,
    authorization,
    spent,
    notifier,
    requestId,
  } = options;
  const now = options.now ?? (() => new Date());

  function organizationOf(
    tenant: TenantContext,
    permission: 'specialist.read' | 'specialist.task',
  ) {
    if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new AgentTaskError('permission_denied');
    }
    // Deciding a handoff is a person's decision: never GIA's, never the runtime's.
    if (permission === 'specialist.task' && tenant.actor !== 'user') {
      throw new AgentTaskError('permission_denied');
    }
    return tenant.organizationId as OrganizationId;
  }

  async function pending(organizationId: OrganizationId, taskId: string) {
    if (!/^[0-9a-f-]{36}$/.test(taskId)) throw new AgentTaskError('handoff_not_found');
    const handoff = await repository.find(organizationId, taskId as ExecutionId);
    if (handoff === undefined) throw new AgentTaskError('handoff_not_found');
    return handoff;
  }

  /** Records a refusal and throws it: nothing was started. */
  async function refuse(
    tenant: TenantContext,
    handoff: AgentHandoff,
    code: 'no_agent_available' | 'budget_exhausted' | 'permission_denied' | 'expired',
  ): Promise<never> {
    const at = now();
    await repository.update(handoff.organizationId, handoff.id, (current) => {
      if (current.state !== 'proposed') throw new AgentTaskError('handoff_not_pending');
      const next: AgentHandoff = Object.freeze({
        ...current,
        state: 'refused' as const,
        refusal: code,
        updatedAt: at.toISOString() as IsoTimestamp,
      });
      return {
        handoff: next,
        events: [
          auditOf(tenant, next, 'agent_handoff.refused', at, {
            reason: code,
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ],
      };
    });
    throw new AgentTaskError(
      code === 'permission_denied'
        ? 'permission_denied'
        : code === 'expired'
          ? 'handoff_expired'
          : code,
    );
  }

  return Object.freeze({
    async get(tenant, taskId) {
      const organizationId = organizationOf(tenant, 'specialist.read');
      if (!/^[0-9a-f-]{36}$/.test(taskId)) return undefined;
      const found = await repository.find(organizationId, taskId as ExecutionId);
      return found === undefined ? undefined : handoffAsOf(found, now());
    },

    async accept(tenant, taskId) {
      const organizationId = organizationOf(tenant, 'specialist.task');
      if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
      const handoff = await pending(organizationId, taskId);
      if (handoff.state === 'accepted' || handoff.state === 'completed') return handoff;
      if (handoff.state !== 'proposed') throw new AgentTaskError('handoff_not_pending');
      if (isHandoffExpired(handoff, now())) return refuse(tenant, handoff, 'expired');
      const parent = await tasks.find(organizationId, handoff.parentTaskId);
      if (parent === undefined) throw new AgentTaskError('handoff_not_found');
      // The agent chosen then, if it can still take work; otherwise the department's next one.
      const chosen =
        handoff.receivingAgent === undefined
          ? undefined
          : await specialists.find(organizationId, handoff.receivingAgent.specialistId);
      const receiving =
        chosen !== undefined && canTakeNewWork(chosen.status)
          ? chosen
          : await directory.agentFor(
              organizationId,
              handoff.department,
              handoff.requestingAgent.specialistId,
            );
      if (receiving === undefined) return refuse(tenant, handoff, 'no_agent_available');
      // Never more than the first task had left: no agent gets round a budget through another.
      let maxCredits: number | undefined;
      if (parent.maxCredits !== undefined) {
        maxCredits = parent.maxCredits - (await spent(tenant, parent.id));
        if (maxCredits < 1) return refuse(tenant, handoff, 'budget_exhausted');
      }
      const { task } = await assign.assign(
        tenant,
        receiving.identity.id,
        {
          request: handoff.request,
          idempotencyKey: `handoff-${handoff.id}`.slice(0, 64),
          ...(maxCredits === undefined ? {} : { maxCredits }),
        },
        { parentTaskId: handoff.parentTaskId },
      );
      const version = await specialists.findVersion(
        organizationId,
        receiving.identity.id,
        task.specialistVersion,
      );
      const at = now();
      const accepted = await repository.update(organizationId, handoff.id, (current) => {
        if (current.state === 'accepted') return { handoff: current, events: [] };
        if (current.state !== 'proposed') throw new AgentTaskError('handoff_not_pending');
        const next: AgentHandoff = Object.freeze({
          ...current,
          receivingAgent: { specialistId: receiving.identity.id, version: task.specialistVersion },
          state: 'accepted' as const,
          childTaskId: task.id,
          permissions: Object.freeze([...(version?.configuration.permissions ?? [])]),
          ...(maxCredits === undefined ? {} : { maxCredits }),
          decision: { by: tenant.userId, at: at.toISOString() as IsoTimestamp },
          updatedAt: at.toISOString() as IsoTimestamp,
        });
        return {
          handoff: next,
          events: [
            auditOf(tenant, next, 'agent_handoff.accepted', at, {
              ...(requestId === undefined ? {} : { requestId }),
            }),
          ],
        };
      });
      if (accepted.childTaskId !== undefined) {
        await notifier?.notify({
          organizationId,
          recipientId: parent.requestedBy,
          kind: 'task_received',
          specialistId: receiving.identity.id,
          taskId: accepted.childTaskId,
          code: handoff.reason,
          otherSpecialistId: handoff.requestingAgent.specialistId,
          // One notice per handoff, however often it is accepted again.
          key: `handoff:${handoff.id}:received`,
          at,
        });
      }
      return accepted;
    },

    async decline(tenant, taskId) {
      const organizationId = organizationOf(tenant, 'specialist.task');
      if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
      const handoff = await pending(organizationId, taskId);
      if (handoff.state === 'declined') return handoff;
      if (handoff.state !== 'proposed') throw new AgentTaskError('handoff_not_pending');
      if (isHandoffExpired(handoff, now())) return refuse(tenant, handoff, 'expired');
      const at = now();
      return repository.update(organizationId, handoff.id, (current) => {
        if (current.state !== 'proposed') throw new AgentTaskError('handoff_not_pending');
        const next: AgentHandoff = Object.freeze({
          ...current,
          state: 'declined' as const,
          decision: { by: tenant.userId, at: at.toISOString() as IsoTimestamp },
          updatedAt: at.toISOString() as IsoTimestamp,
        });
        return {
          handoff: next,
          events: [
            auditOf(tenant, next, 'agent_handoff.declined', at, {
              ...(requestId === undefined ? {} : { requestId }),
            }),
          ],
        };
      });
    },
  } satisfies AgentHandoffService);
}

// ---------------------------------------------------------------------------------------------
// Settling (the worker, when the receiving task ends)

/**
 * When a handed task ends, its handoff records how: completed or failed, and what the receiving
 * task spent. Only the handoff whose child it is; anything else is left as it is.
 */
export function createHandoffSettler(options: {
  readonly repository: AgentHandoffRepository;
  readonly tasks: Pick<AgentTaskRepository, 'find'>;
  readonly spent: (tenant: TenantContext, execution: Execution) => Promise<number>;
  readonly now?: () => Date;
}): { settle(tenant: TenantContext, execution: Execution): Promise<AgentHandoff | undefined> } {
  const { repository, tasks, spent } = options;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async settle(tenant, execution) {
      if (!isResolvedTenant(tenant)) return undefined;
      if (execution.status !== 'completed' && execution.status !== 'failed') return undefined;
      const organizationId = tenant.organizationId as OrganizationId;
      const task = await tasks.find(organizationId, execution.id);
      if (task?.parentTaskId === undefined) return undefined;
      const handoff = await repository.find(organizationId, task.parentTaskId);
      if (handoff?.childTaskId !== task.id || handoff.state !== 'accepted') return handoff;
      const credits = await spent(tenant, execution);
      const to: AgentHandoffState = execution.status === 'completed' ? 'completed' : 'failed';
      const at = now();
      return repository.update(organizationId, handoff.id, (current) => {
        if (current.state !== 'accepted') return { handoff: current, events: [] };
        const next: AgentHandoff = Object.freeze({
          ...current,
          state: to,
          creditsConsumed: credits,
          updatedAt: at.toISOString() as IsoTimestamp,
        });
        return {
          handoff: next,
          events: [
            auditOf(tenant, next, 'agent_handoff.settled', at, {
              transition: { from: 'accepted', to },
            }),
          ],
        };
      });
    },
  });
}
