import { randomUUID } from 'node:crypto';
import type {
  AgentTask,
  Execution,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistId,
} from '@melonoffice/domain';
import { executionIdFor, isExecutionError, type ExecutionService } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  canTakeNewWork,
  isSpecialistId,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { AgentTaskError } from './errors.js';
import { AGENT_FOLLOW_UP_TOOL, AGENT_TASK_SCHEDULE_NODE } from './proposals.js';

/**
 * Tasks for agents (Agent Engine phase 2, ADR-0063). A person asks one of the organization's
 * active agents to do something; the task is an execution of that agent, run by the existing
 * runtime, with one `agent` node whose model call goes through the AI Gateway. An agent whose
 * version has `follow_up_schedule@2` gets a second, `tool` node after it, for the follow-up it may
 * propose; it runs only through the tool gate and a person's approval (ADR-0084). Nothing here
 * runs a model, reaches a tool or leaves MelonOffice: this is only how a task is asked and read.
 */

/** What an agent task's execution points at (`execution.input.type`). */
export const AGENT_TASK_INPUT = 'agent_task';
/** The one node of an agent task: the agent works on the request. */
export const AGENT_TASK_NODE = 'work';
export const MAX_TASK_REQUEST_LENGTH = 2000;
/** The largest budget a task may be given, in credits (a bound on input, not a price). */
export const MAX_TASK_CREDITS = 1_000_000;

/** A task's budget as it is stored: a whole number of credits, at least 1 (ADR-0100). */
export function checkTaskCredits(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TASK_CREDITS
  ) {
    throw new AgentTaskError('invalid_task', 'maxCredits');
  }
  return value;
}
export const TASK_PAGE_SIZE = Object.freeze({ page: 20, max: 50 });

// Control characters other than line breaks and tabs are never stored.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CLIENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** A position in an agent's task list: newest first, then by id. */
export interface TaskPosition {
  readonly at: IsoTimestamp;
  readonly id: ExecutionId;
}

/**
 * Where tasks live: Firestore in the API (`agentTasks/{taskId}`), memory in tests. A task is
 * written once; writing it again with the same id returns the stored one.
 */
export interface AgentTaskRepository {
  create(task: AgentTask): Promise<AgentTask>;
  /** The task, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: ExecutionId): Promise<AgentTask | undefined>;
  /** One page of an agent's tasks, newest first, after `after` when given. */
  page(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    request: { readonly after?: TaskPosition; readonly limit: number },
  ): Promise<{ readonly items: readonly AgentTask[]; readonly hasMore: boolean }>;
}

export const taskPosition = (task: AgentTask): TaskPosition => ({
  at: task.createdAt,
  id: task.id,
});

const newestFirst = (a: AgentTask, b: AgentTask) =>
  a.createdAt === b.createdAt
    ? a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0
    : a.createdAt < b.createdAt
      ? 1
      : -1;

/** Whether `task` comes after `position` in newest-first order. */
export const isAfter = (task: AgentTask, position: TaskPosition): boolean =>
  task.createdAt < position.at || (task.createdAt === position.at && task.id < position.id);

/** One page of `tasks`, the way every store cuts it. */
export function pageOfTasks(
  tasks: readonly AgentTask[],
  request: { readonly after?: TaskPosition; readonly limit: number },
) {
  const { after } = request;
  const sorted = [...tasks]
    .filter((t) => after === undefined || isAfter(t, after))
    .sort(newestFirst);
  return {
    items: Object.freeze(sorted.slice(0, request.limit)),
    hasMore: sorted.length > request.limit,
  };
}

export class InMemoryAgentTaskRepository implements AgentTaskRepository {
  readonly #tasks = new Map<string, AgentTask>();

  async create(task: AgentTask): Promise<AgentTask> {
    const stored = this.#tasks.get(task.id);
    if (stored !== undefined) return stored;
    this.#tasks.set(task.id, Object.freeze({ ...task }));
    return task;
  }

  async find(organizationId: OrganizationId, id: ExecutionId) {
    const task = this.#tasks.get(id);
    return task?.organizationId === organizationId ? task : undefined;
  }

  async page(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    request: { readonly after?: TaskPosition; readonly limit: number },
  ) {
    const mine = [...this.#tasks.values()].filter(
      (t) => t.organizationId === organizationId && t.specialistId === specialistId,
    );
    return pageOfTasks(mine, request);
  }
}

// ---------------------------------------------------------------------------------------------
// Cursors

/**
 * A cursor names only a position in one agent's list of one organization. It is not a secret and
 * grants nothing: every page is read for the caller's own organization, and a cursor made for
 * another organization or agent is refused.
 */
export function encodeTaskCursor(
  organizationId: OrganizationId,
  specialistId: SpecialistId,
  position: TaskPosition,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, o: organizationId, s: specialistId, a: position.at, i: position.id }),
  ).toString('base64url');
}

export function decodeTaskCursor(
  cursor: string,
  organizationId: OrganizationId,
  specialistId: SpecialistId,
): TaskPosition {
  const bad = () => new AgentTaskError('invalid_task', 'cursor');
  if (cursor.length > 400) throw bad();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof value !== 'object' || value === null) throw bad();
  const { v, o, s, a, i } = value as Record<string, unknown>;
  if (v !== 1 || o !== organizationId || s !== specialistId) throw bad();
  if (typeof a !== 'string' || Number.isNaN(Date.parse(a))) throw bad();
  if (typeof i !== 'string' || !/^[0-9a-f-]{36}$/.test(i)) throw bad();
  return { at: a as IsoTimestamp, id: i as ExecutionId };
}

// ---------------------------------------------------------------------------------------------
// Asking and reading

/** A task with its execution, as callers read it. */
export interface TaskWithExecution {
  readonly task: AgentTask;
  /** Absent only if its execution can no longer be read. */
  readonly execution?: Execution;
}

export interface AgentTaskService {
  /**
   * Asks an agent to do a task: `{ request, idempotencyKey?, maxCredits? }`. The same key for the same agent
   * is the same task: asking again returns it and starts nothing new.
   */
  assign(
    tenant: TenantContext,
    specialistId: string,
    input: Record<string, unknown>,
    /**
     * A task handed from another agent's (ADR-0117): set only by the handoff service, never from a
     * request's body, once a person accepted the handoff.
     */
    link?: { readonly parentTaskId: ExecutionId },
  ): Promise<TaskWithExecution>;
  get(tenant: TenantContext, taskId: string): Promise<TaskWithExecution>;
  list(
    tenant: TenantContext,
    specialistId: string,
    page: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{ readonly items: readonly TaskWithExecution[]; readonly nextCursor: string | null }>;
}

/** The part of the runtime that queues a started execution's first node. */
export interface TaskKickoff {
  kickoff(tenant: TenantContext, executionId: string, correlationId?: string): Promise<unknown>;
}

export interface AgentTaskServiceOptions {
  readonly tasks: AgentTaskRepository;
  readonly specialists: Pick<SpecialistRepository, 'find'>;
  readonly executions: Pick<ExecutionService, 'create' | 'get' | 'start'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** Queues the task's first job. Absent: a started task waits in the queue (fails closed). */
  readonly runtime?: TaskKickoff;
  readonly now?: () => Date;
  readonly requestId?: string;
  /** A fresh key for a task asked without one. */
  readonly newKey?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The request as it is stored: trimmed, within bounds, without control characters. */
export function checkTaskRequest(value: unknown): string {
  if (typeof value !== 'string') throw new AgentTaskError('invalid_task', 'request');
  const request = value.trim();
  if (request.length === 0 || request.length > MAX_TASK_REQUEST_LENGTH || CONTROL.test(request)) {
    throw new AgentTaskError('invalid_task', 'request');
  }
  return request;
}

export function createAgentTaskService(options: AgentTaskServiceOptions): AgentTaskService {
  const { tasks, specialists, executions, authorization, runtime, requestId } = options;
  const now = options.now ?? (() => new Date());
  const newKey = options.newKey ?? (() => randomUUID());

  function organizationOf(
    tenant: TenantContext,
    permission: 'specialist.task' | 'specialist.read',
  ) {
    if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new AgentTaskError('permission_denied');
    }
    return tenant.organizationId as OrganizationId;
  }

  async function executionOf(tenant: TenantContext, id: ExecutionId) {
    try {
      return await executions.get(tenant, id);
    } catch (error) {
      if (isExecutionError(error) && error.code === 'execution_not_found') return undefined;
      throw error;
    }
  }

  async function agentOf(organizationId: OrganizationId, id: string): Promise<Specialist> {
    if (!isSpecialistId(id)) throw new AgentTaskError('specialist_not_found');
    const specialist = await specialists.find(organizationId, id);
    if (specialist === undefined) throw new AgentTaskError('specialist_not_found');
    return specialist;
  }

  return Object.freeze({
    async assign(tenant, specialistId, input, link) {
      const organizationId = organizationOf(tenant, 'specialist.task');
      // Asking an agent for work is a person's decision: never GIA's, never the runtime's.
      if (tenant.actor !== 'user') throw new AgentTaskError('permission_denied');
      if (!isRecord(input)) throw new AgentTaskError('invalid_task', 'body');
      for (const key of Object.keys(input)) {
        if (key !== 'request' && key !== 'idempotencyKey' && key !== 'maxCredits') {
          throw new AgentTaskError('invalid_task', key);
        }
      }
      const request = checkTaskRequest(input.request);
      const maxCredits =
        input.maxCredits === undefined ? undefined : checkTaskCredits(input.maxCredits);
      const clientKey = input.idempotencyKey ?? newKey();
      if (typeof clientKey !== 'string' || !CLIENT_KEY.test(clientKey)) {
        throw new AgentTaskError('invalid_task', 'idempotencyKey');
      }
      const agent = await agentOf(organizationId, specialistId);
      const key = `agent-task:${agent.identity.id}:${clientKey}`;
      const id = executionIdFor(organizationId, key);

      const stored = await tasks.find(organizationId, id);
      if (
        stored !== undefined &&
        (stored.request !== request || stored.maxCredits !== maxCredits)
      ) {
        throw new AgentTaskError('idempotency_conflict');
      }
      if (stored === undefined && !canTakeNewWork(agent.status)) {
        throw new AgentTaskError('specialist_not_available', agent.status);
      }
      // The execution first: an agent the execution service refuses (not eligible, inactive
      // organization) leaves no task behind. A task record without its execution never exists.
      let execution = await executionOf(tenant, id);
      if (execution === undefined) {
        const ref = { type: AGENT_TASK_INPUT, id };
        const schedules = agent.configuration.tools.some(
          (t) => t.id === AGENT_FOLLOW_UP_TOOL.id && t.version === AGENT_FOLLOW_UP_TOOL.version,
        );
        try {
          execution = await executions.create(tenant, {
            mode: 'execute',
            input: ref,
            specialistId: agent.identity.id,
            specialistVersion: agent.version,
            departmentId: agent.configuration.departmentId,
            versionSnapshot: {
              schemaVersion: 1,
              components: [
                { kind: 'specialist', id: agent.identity.id, version: String(agent.version) },
                ...agent.configuration.skills.map((s) => ({
                  kind: 'skill',
                  id: s.id as string,
                  version: String(s.version),
                })),
                ...(schedules
                  ? [
                      {
                        kind: 'tool',
                        id: AGENT_FOLLOW_UP_TOOL.id,
                        version: String(AGENT_FOLLOW_UP_TOOL.version),
                      },
                    ]
                  : []),
              ],
            },
            nodes: [
              { id: AGENT_TASK_NODE, type: 'agent', label: AGENT_TASK_INPUT, input: ref },
              ...(schedules
                ? [
                    {
                      id: AGENT_TASK_SCHEDULE_NODE,
                      type: 'tool' as const,
                      label: AGENT_FOLLOW_UP_TOOL.id,
                      input: ref,
                      dependsOn: [AGENT_TASK_NODE],
                      tool: { ...AGENT_FOLLOW_UP_TOOL },
                    },
                  ]
                : []),
            ],
            idempotencyKey: key,
            ...(requestId === undefined ? {} : { requestId }),
          });
        } catch (error) {
          // Created concurrently by a repeat of the same request: that one is the task.
          const raced = await executionOf(tenant, id);
          if (raced === undefined) throw error;
          execution = raced;
        }
      }
      const task =
        stored ??
        (await tasks.create(
          Object.freeze({
            id,
            organizationId,
            specialistId: agent.identity.id,
            specialistVersion: execution.specialistVersion ?? agent.version,
            request,
            requestedBy: tenant.userId,
            createdAt: now().toISOString() as IsoTimestamp,
            ...(maxCredits === undefined ? {} : { maxCredits }),
            ...(link === undefined ? {} : { parentTaskId: link.parentTaskId }),
          }),
        ));
      if (task.request !== request) throw new AgentTaskError('idempotency_conflict');
      if (execution.status === 'pending') execution = await executions.start(tenant, id);
      // Only a running task is queued: a cancelled or finished one is never started again.
      if (runtime !== undefined && execution.status === 'running') {
        try {
          await runtime.kickoff(tenant, id, requestId);
        } catch (error) {
          // Already queued by an earlier request: the task runs once.
          const code = (error as { code?: unknown }).code;
          if (code !== 'execution_in_progress') throw error;
        }
      }
      return Object.freeze({ task, execution });
    },

    async get(tenant, taskId) {
      const organizationId = organizationOf(tenant, 'specialist.read');
      if (!/^[0-9a-f-]{36}$/.test(taskId)) throw new AgentTaskError('task_not_found');
      const task = await tasks.find(organizationId, taskId as ExecutionId);
      if (task === undefined) throw new AgentTaskError('task_not_found');
      const execution = await executionOf(tenant, task.id);
      return Object.freeze({ task, ...(execution === undefined ? {} : { execution }) });
    },

    async list(tenant, specialistId, page) {
      const organizationId = organizationOf(tenant, 'specialist.read');
      const agent = await agentOf(organizationId, specialistId);
      const limit = page.limit ?? TASK_PAGE_SIZE.page;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_PAGE_SIZE.max) {
        throw new AgentTaskError('invalid_task', 'limit');
      }
      const after =
        page.cursor === undefined
          ? undefined
          : decodeTaskCursor(page.cursor, organizationId, agent.identity.id);
      const found = await tasks.page(organizationId, agent.identity.id, {
        ...(after === undefined ? {} : { after }),
        limit,
      });
      const items = await Promise.all(
        found.items.map(async (task) => {
          const execution = await executionOf(tenant, task.id);
          return Object.freeze({ task, ...(execution === undefined ? {} : { execution }) });
        }),
      );
      const last = found.items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor:
          found.hasMore && last !== undefined
            ? encodeTaskCursor(organizationId, agent.identity.id, taskPosition(last))
            : null,
      });
    },
  } satisfies AgentTaskService);
}
