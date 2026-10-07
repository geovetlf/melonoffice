import {
  ConversationError,
  isConversationError,
  isFollowUpId,
  isLocalTime,
  localDateTime,
  type ConversationErrorCode,
  type FollowUpService,
} from '@melonoffice/conversations';
import type { FollowUp, FollowUpId } from '@melonoffice/domain';
import { isExecutionError, type ExecutionService } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  isResolvedTenant,
  resolveRuntimeTenant,
  resolveTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import {
  FOLLOW_UP_SCHEDULE_TOOL,
  FOLLOW_UP_TYPE_CODES,
  PLAN_FOLLOW_UP_MAX_DAYS,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolExecutorOutcome,
  WORKFLOW_FOLLOW_UP_TOOL,
} from '@melonoffice/tools';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolInvoker } from './outbound.js';

/** `follow_up_schedule` version 1: the one a person invokes (TL-1, ADR-0068). */
export const FOLLOW_UP_SCHEDULE = FOLLOW_UP_SCHEDULE_TOOL.versions[0] as NonNullable<
  (typeof FOLLOW_UP_SCHEDULE_TOOL.versions)[0]
>;
export const SCHEDULE_NODE = 'schedule';

/** The executor's `ConversationError` codes, passed back as the tool's failure code. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The executor of `follow_up_schedule` (provider `follow_up`). The gate calls it only after its
 * checks passed. It runs the person's own call only: it resolves their membership again, in the
 * execution's organization, and calls the follow-up service's `create` as them, so every rule of
 * the service (contact, opportunity, assignee, time, limits, audit) applies unchanged. The
 * service is idempotent by `requestKey`: a repeat returns the follow-up it made.
 */
export function createFollowUpScheduleExecutor(options: {
  readonly followUps: Pick<FollowUpService, 'create'>;
  readonly organizations: Pick<TenancyStore, 'findMembership' | 'findOrganization'>;
}): ToolExecutor {
  const { followUps, organizations } = options;
  return {
    async execute(context: ToolExecutionContext, input: unknown): Promise<ToolExecutorOutcome> {
      if (
        context.toolId !== FOLLOW_UP_SCHEDULE.toolId ||
        context.toolVersion !== FOLLOW_UP_SCHEDULE.version ||
        context.actor.via !== 'direct'
      ) {
        return { status: 'failure', code: 'tool_not_human_invokable' };
      }
      let tenant: TenantContext;
      try {
        tenant = await resolveTenant(
          { actor: 'user', userId: context.actor.userId, emailVerified: true },
          context.organizationId,
          organizations as TenancyStore,
        );
      } catch {
        return { status: 'failure', code: 'permission_denied' };
      }
      try {
        const { followUp, created } = await followUps.create(
          tenant,
          input as Record<string, unknown>,
        );
        return { status: 'success', output: { followUpId: followUp.id, created } };
      } catch (error) {
        if (isConversationError(error) && CODE.test(error.code)) {
          return { status: 'failure', code: error.code };
        }
        throw error;
      }
    },
  };
}

/** `follow_up_schedule` version 2: an agent's, approved by a person each time (ADR-0084). */
export const AGENT_FOLLOW_UP_SCHEDULE = FOLLOW_UP_SCHEDULE_TOOL.versions[1] as NonNullable<
  (typeof FOLLOW_UP_SCHEDULE_TOOL.versions)[1]
>;
/** Version 3 (ADR-0104): the one an agent's model asks for mid-task, by a contact's reference. */
export const MODEL_FOLLOW_UP_SCHEDULE = FOLLOW_UP_SCHEDULE_TOOL.versions[2] as NonNullable<
  (typeof FOLLOW_UP_SCHEDULE_TOOL.versions)[2]
>;

/** `workflow_follow_up@1` (B6, ADR-0184): a plan's write step, every field fixed in the workflow. */
export const PLAN_FOLLOW_UP_SCHEDULE = WORKFLOW_FOLLOW_UP_TOOL.versions[0] as NonNullable<
  (typeof WORKFLOW_FOLLOW_UP_TOOL.versions)[0]
>;

/** A plan's follow-up as the workflow fixed it (`workflow_follow_up@1`). */
interface PlanFollowUp {
  readonly contactId: string;
  readonly type: string;
  readonly title: string;
  readonly inDays: number;
  readonly time: string;
}

const PLAN_FOLLOW_UP_KEYS = ['contactId', 'inDays', 'time', 'title', 'type'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The plan's call, exactly its five fields, each well formed; anything else is refused. */
function planFollowUpOf(input: unknown): PlanFollowUp | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== PLAN_FOLLOW_UP_KEYS.join()) return undefined;
  const { contactId, type, title, inDays, time } = value;
  if (typeof contactId !== 'string' || !UUID.test(contactId)) return undefined;
  if (typeof type !== 'string' || !(FOLLOW_UP_TYPE_CODES as readonly string[]).includes(type)) {
    return undefined;
  }
  if (typeof title !== 'string') return undefined;
  const text = title.normalize('NFC').trim();
  if (text.length === 0 || [...text].length > 120 || CONTROL.test(text)) return undefined;
  if (
    typeof inDays !== 'number' ||
    !Number.isSafeInteger(inDays) ||
    inDays < 0 ||
    inDays > PLAN_FOLLOW_UP_MAX_DAYS
  ) {
    return undefined;
  }
  if (!isLocalTime(time)) return undefined;
  return { contactId, type, title: text, inDays, time };
}

/** A local date `days` days after another, by the calendar (no time zone involved). */
export function localDatePlus(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The request key of a plan's follow-up (ADR-0184): made by the server from what the follow-up is
 * (contact, type, title, local date and time), never from the run. A retry, a concurrent plan or a
 * person running the workflow again after an ambiguous failure reach the same follow-up, which the
 * follow-up service makes once in the organization. Another day or another content is another one.
 */
export const planFollowUpKey = (request: {
  readonly contactId: string;
  readonly type: string;
  readonly title: string;
  readonly date: string;
  readonly time: string;
}): string =>
  `plan-step-${createHash('sha256')
    .update(
      JSON.stringify([request.contactId, request.type, request.title, request.date, request.time]),
    )
    .digest('hex')
    .slice(0, 32)}`;

/**
 * Where a contact's reference in a task leads (ADR-0104), resolved on the server only: among the
 * contacts of the task's organization that the person the task is for may read, the one contact
 * the reference names. None, or more than one: nothing is scheduled.
 */
export interface AgentContactResolver {
  resolve(
    tenant: TenantContext,
    ref: string,
  ): Promise<
    | { readonly contactId: string }
    | { readonly problem: 'contact_not_found' | 'contact_ref_ambiguous' }
  >;
}

/** A follow-up as a model asks for it with `follow_up_schedule@3`: a reference, never an id. */
interface ModelFollowUp {
  readonly contact: string;
  readonly type: string;
  readonly title: string;
  readonly date: string;
  readonly time: string;
}

const MODEL_FOLLOW_UP_KEYS = ['contact', 'date', 'time', 'title', 'type'];
const CONTACT_REF = /^c_[a-p]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The model's call, exactly its five fields, each well formed; anything else is refused. */
function modelFollowUpOf(input: unknown): ModelFollowUp | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== MODEL_FOLLOW_UP_KEYS.join()) return undefined;
  const { contact, type, title, date, time } = value;
  if (typeof contact !== 'string' || !CONTACT_REF.test(contact)) return undefined;
  if (typeof type !== 'string' || !(FOLLOW_UP_TYPE_CODES as readonly string[]).includes(type)) {
    return undefined;
  }
  if (typeof title !== 'string') return undefined;
  const text = title.normalize('NFC').trim();
  if (text.length === 0 || [...text].length > 120 || CONTROL.test(text)) return undefined;
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) {
    return undefined;
  }
  if (typeof time !== 'string' || !TIME.test(time)) return undefined;
  return { contact, type, title: text, date, time };
}

/**
 * The request key of a follow-up an agent asked for in a task: made by the server from the task
 * and the resolved request, never by the model. The same request in the same task, by a retry, a
 * loop or a repeated call, is the same key, so the follow-up service makes it once.
 */
export const modelFollowUpKey = (
  executionId: string,
  request: { readonly contactId: string } & Omit<ModelFollowUp, 'contact'>,
): string =>
  `agent-task-${executionId}-${createHash('sha256')
    .update(
      JSON.stringify([request.contactId, request.type, request.title, request.date, request.time]),
    )
    .digest('hex')
    .slice(0, 32)}`;

/**
 * The executor of `follow_up_schedule` version 2 (ADR-0084), in the worker. The gate calls it only
 * after its checks passed: the agent's skill grants this version, the person the task is for holds
 * `follow_up.manage`, and a person approved this exact input. It runs as the runtime for that
 * person, in the execution's organization, through the follow-up service's `create` with source
 * `agent`, so every rule of the service applies unchanged. Idempotent by `requestKey`.
 */
export function createAgentFollowUpScheduleExecutor(options: {
  readonly followUps: Pick<FollowUpService, 'create'>;
  readonly organizations: TenancyStore;
  /** Resolves a model's contact reference (ADR-0104). Absent: version 3 never runs here. */
  readonly contacts?: AgentContactResolver;
  /** The business's time zone, for a plan's follow-up (ADR-0184). Absent: it never runs here. */
  readonly timeZone?: (organizationId: string) => Promise<string>;
  readonly now?: () => Date;
}): ToolExecutor {
  const { followUps, organizations, contacts, timeZone } = options;
  const now = options.now ?? (() => new Date());

  /** Runs the follow-up service's own `create` as the runtime for the task's person. */
  async function create(
    context: ToolExecutionContext,
    input:
      | Record<string, unknown>
      | ((tenant: TenantContext) => Promise<Record<string, unknown> | string>),
  ): Promise<ToolExecutorOutcome> {
    let tenant: TenantContext;
    try {
      tenant = await resolveRuntimeTenant(
        context.actor.userId,
        context.organizationId,
        organizations,
      );
    } catch {
      return { status: 'failure', code: 'permission_denied' };
    }
    try {
      const request = typeof input === 'function' ? await input(tenant) : input;
      if (typeof request === 'string') return { status: 'failure', code: request };
      const { followUp, created } = await followUps.create(tenant, request);
      return { status: 'success', output: { followUpId: followUp.id, created } };
    } catch (error) {
      if (isConversationError(error) && CODE.test(error.code)) {
        return { status: 'failure', code: error.code };
      }
      throw error;
    }
  }

  /**
   * Version 3 (ADR-0104): after a person approved this exact call. The reference is resolved here,
   * among the contacts of the execution's organization the person may read; the request key is
   * made here; the follow-up service checks the rest (the contact, the date and time, the limits).
   */
  async function modelCall(context: ToolExecutionContext, input: unknown) {
    if (
      context.actor.via !== 'runtime' ||
      context.specialistId === undefined ||
      contacts === undefined
    ) {
      return { status: 'failure', code: 'tool_not_runtime_invokable' } as const;
    }
    // Never without a person's approval of this call, whatever the policy said.
    if (context.approvalId === undefined)
      return { status: 'failure', code: 'approval_missing' } as const;
    const call = modelFollowUpOf(input);
    if (call === undefined) return { status: 'failure', code: 'invalid_input' } as const;
    return create(context, async (tenant) => {
      const found = await contacts.resolve(tenant, call.contact);
      if ('problem' in found) return found.problem;
      const request = { ...call, contactId: found.contactId };
      return {
        requestKey: modelFollowUpKey(context.executionId, request),
        contactId: found.contactId,
        type: call.type,
        title: call.title,
        date: call.date,
        time: call.time,
        source: 'agent',
      };
    });
  }

  /**
   * `workflow_follow_up@1` (ADR-0184): a plan's write step, after a person approved this exact input. The date
   * is today in the business's time zone plus the days the workflow fixed; the request key is made
   * here from the follow-up itself; the follow-up service checks the rest (the contact in this
   * organization, the time, the limits) and audits the follow-up.
   */
  async function planCall(context: ToolExecutionContext, input: unknown) {
    if (
      context.actor.via !== 'runtime' ||
      context.specialistId === undefined ||
      timeZone === undefined
    ) {
      return { status: 'failure', code: 'tool_not_runtime_invokable' } as const;
    }
    // Never without a person's approval of this call, whatever the policy said.
    if (context.approvalId === undefined)
      return { status: 'failure', code: 'approval_missing' } as const;
    const call = planFollowUpOf(input);
    if (call === undefined) return { status: 'failure', code: 'invalid_input' } as const;
    return create(context, async () => {
      const today = localDateTime(now(), await timeZone(context.organizationId)).date;
      const date = localDatePlus(today, call.inDays);
      return {
        requestKey: planFollowUpKey({ ...call, date }),
        contactId: call.contactId,
        type: call.type,
        title: call.title,
        date,
        time: call.time,
        source: 'agent',
      };
    });
  }

  return {
    async execute(context: ToolExecutionContext, input: unknown): Promise<ToolExecutorOutcome> {
      if (
        context.toolId === PLAN_FOLLOW_UP_SCHEDULE.toolId &&
        context.toolVersion === PLAN_FOLLOW_UP_SCHEDULE.version
      ) {
        return planCall(context, input);
      }
      if (
        context.toolId === MODEL_FOLLOW_UP_SCHEDULE.toolId &&
        context.toolVersion === MODEL_FOLLOW_UP_SCHEDULE.version
      ) {
        return modelCall(context, input);
      }
      if (
        context.toolId !== AGENT_FOLLOW_UP_SCHEDULE.toolId ||
        context.toolVersion !== AGENT_FOLLOW_UP_SCHEDULE.version ||
        context.actor.via !== 'runtime' ||
        context.specialistId === undefined ||
        context.approvalId === undefined
      ) {
        return { status: 'failure', code: 'tool_not_runtime_invokable' };
      }
      return create(context, input as Record<string, unknown>);
    },
  };
}

/** Gate refusals that mean the person may not do this at all. */
const NOT_ALLOWED = new Set([
  'permission_not_held',
  'runtime_only',
  'tool_not_human_invokable',
  'execution_not_owned',
]);

export interface GatedFollowUpCreateOptions {
  readonly followUps: Pick<FollowUpService, 'checkCreate' | 'get'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly executions: Pick<ExecutionService, 'create' | 'start'>;
  readonly gate: ToolInvoker;
  readonly logger?: Logger;
}

/**
 * A person's new follow-up, through the tool gate (TL-1, ADR-0068). Same input and answer as the
 * follow-up service's `create`, which the gate's executor runs: the route's contract is unchanged.
 *
 * 1. The service checks the request first (`checkCreate`), so a refusal names its field exactly as
 *    before, and nothing is recorded for a request that cannot run.
 * 2. One execution per attempt records the call: the gate checks the tool, the person's
 *    permissions and the environment, runs it and audits `tool.*` and `execution.*`.
 * 3. The follow-up comes back from the service. Two attempts with the same `requestKey` make one
 *    follow-up: the service's own idempotency decides, not the execution.
 */
export function createGatedFollowUpCreate(
  options: GatedFollowUpCreateOptions,
): Pick<FollowUpService, 'create'> {
  const { followUps, authorization, executions, gate, logger } = options;

  return Object.freeze({
    async create(tenant: TenantContext, input: Record<string, unknown>) {
      if (!isResolvedTenant(tenant)) throw new ConversationError('unresolved_tenant');
      // Everything the call will be checked for, up front: nothing is recorded for a call that
      // cannot happen. The gate and the execution service check again.
      for (const permission of ['follow_up.manage', 'tool.execute', 'execution.start']) {
        if (!authorization.authorize(tenant, permission).allowed) {
          throw new ConversationError('permission_denied');
        }
      }
      await followUps.checkCreate(tenant, input);
      // The tool's closed input: an absent value is left out, never sent as null.
      const toolInput = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
      );
      const requestKey = input.requestKey as string;
      const execution = await executions.create(tenant, {
        mode: 'execute',
        input: { type: 'follow_up_request', id: requestKey },
        versionSnapshot: {
          schemaVersion: 1,
          components: [
            {
              kind: 'tool',
              id: FOLLOW_UP_SCHEDULE.toolId,
              version: String(FOLLOW_UP_SCHEDULE.version),
            },
          ],
        },
        nodes: [
          {
            id: SCHEDULE_NODE,
            type: 'tool',
            label: FOLLOW_UP_SCHEDULE.toolId,
            input: { type: 'follow_up_request', id: requestKey },
            tool: { id: FOLLOW_UP_SCHEDULE.toolId, version: FOLLOW_UP_SCHEDULE.version },
          },
        ],
        // One execution per attempt: the follow-up's own key keeps the result one.
        idempotencyKey: `follow_up:${requestKey}:${randomUUID()}`,
      });
      if (execution.status === 'pending') {
        try {
          await executions.start(tenant, execution.id);
        } catch (error) {
          if (!isExecutionError(error)) throw error;
          throw new ConversationError('follow_up_tool_unavailable');
        }
      }
      const result = await gate.invoke(tenant, {
        executionId: execution.id,
        nodeId: SCHEDULE_NODE,
        input: toolInput,
      });
      if (result.status === 'success') {
        const { followUpId, created } = result.output as {
          readonly followUpId: FollowUpId;
          readonly created: boolean;
        };
        if (!isFollowUpId(followUpId)) throw new ConversationError('follow_up_tool_unavailable');
        const followUp: FollowUp = await followUps.get(tenant, followUpId);
        return { followUp, created };
      }
      const code = result.status === 'failure' || result.status === 'denied' ? result.code : null;
      logger?.warn('follow_up_tool_refused', {
        status: result.status,
        ...(code === null ? {} : { code }),
        executionId: execution.id,
      });
      if (result.status === 'denied' && code !== null && NOT_ALLOWED.has(code)) {
        throw new ConversationError('permission_denied');
      }
      if (result.status === 'denied' && code === 'invalid_input') {
        throw new ConversationError('invalid_request');
      }
      // The service's own refusal, found while it ran (e.g. the contact was archived meanwhile).
      if (result.status === 'failure' && code !== null && SERVICE_CODES.has(code)) {
        throw new ConversationError(code as ConversationErrorCode);
      }
      throw new ConversationError('follow_up_tool_unavailable');
    },
  });
}

/** The follow-up service's refusals a create can end with, passed through as they are. */
const SERVICE_CODES = new Set<string>([
  'permission_denied',
  'requires_user',
  'organization_inactive',
  'invalid_request',
  'contact_not_found',
  'opportunity_not_found',
  'opportunity_closed',
  'owner_not_member',
  'duplicate_request',
  'follow_up_limit_reached',
  'follow_up_not_scheduled',
  'follow_up_scheduler_unavailable',
] satisfies readonly ConversationErrorCode[]);
