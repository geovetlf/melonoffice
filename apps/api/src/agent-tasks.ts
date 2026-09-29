import {
  AGENT_TASK_NODE,
  isAgentTaskError,
  parseAgentAnswer,
  type AgentTaskError,
  type AgentTaskService,
  type TaskWithExecution,
} from '@melonoffice/agents';
import { isExecutionError, type AgentOutputStore } from '@melonoffice/execution';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Agent task routes (ADR-0063). A person asks one of the organization's agents for a task
 * (`specialist.task`, owner, a person directly) and reads its tasks and their answers
 * (`specialist.read`). Asking only creates, starts and queues the task's execution: the worker
 * runs it, through the AI Gateway, and the answer is read here once it was verified. A task of
 * another organization answers exactly like one that does not exist.
 */
export function registerAgentTaskRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    /** The service for one request, so its execution and job carry the request's id. */
    readonly tasksFor: (requestId: string | undefined) => AgentTaskService;
    /** Where the worker keeps agents' answers. Absent: tasks show no answer. */
    readonly outputs?: Pick<AgentOutputStore, 'find'>;
  },
): void {
  const { tasksFor, outputs } = dependencies;

  async function view(tenant: TenantContext, found: TaskWithExecution) {
    const { task, execution } = found;
    let answer: { answer: string; missing: string[] } | null = null;
    // Only a verified answer is shown: a completed execution passed its verification (ADR-0029).
    if (execution?.status === 'completed' && outputs !== undefined) {
      const record = await outputs.find(tenant, task.id, AGENT_TASK_NODE);
      const parsed = record === undefined ? undefined : parseAgentAnswer(record.output);
      if (parsed !== undefined) answer = { answer: parsed.answer, missing: [...parsed.missing] };
    }
    return {
      id: task.id,
      specialistId: task.specialistId,
      specialistVersion: task.specialistVersion,
      request: task.request,
      requestedBy: task.requestedBy,
      createdAt: task.createdAt,
      status: execution?.status ?? 'unknown',
      failure: execution?.failure?.code ?? null,
      completedAt: execution?.completedAt ?? null,
      answer,
    };
  }

  app.post(
    '/v1/organizations/:organizationId/specialists/:specialistId/tasks',
    withPermission('specialist.task', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const found = await tasksFor(c.get('requestId')).assign(
          tenant,
          c.req.param('specialistId') ?? '',
          await bodyOf(c),
        );
        return c.json(await view(tenant, found), 202);
      }),
    ),
  );

  app.get(
    '/v1/organizations/:organizationId/specialists/:specialistId/tasks',
    withPermission('specialist.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const cursor = c.req.query('cursor');
        const limit = c.req.query('limit');
        const page = await tasksFor(c.get('requestId')).list(
          tenant,
          c.req.param('specialistId') ?? '',
          {
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit: /^\d{1,3}$/.test(limit) ? Number(limit) : -1 }),
          },
        );
        return c.json({
          tasks: await Promise.all(page.items.map((item) => view(tenant, item))),
          nextCursor: page.nextCursor,
        });
      }),
    ),
  );

  app.get(
    '/v1/organizations/:organizationId/agent-tasks/:taskId',
    withPermission('specialist.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const found = await tasksFor(c.get('requestId')).get(tenant, c.req.param('taskId') ?? '');
        return c.json(await view(tenant, found));
      }),
    ),
  );
}

const bodyOf = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const body: unknown = await c.req.json().catch(() => undefined);
  return (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null
  ) as Record<string, unknown>;
};

const TASK_STATUS: Record<AgentTaskError['code'], 400 | 403 | 404 | 409> = {
  invalid_task: 400,
  unresolved_tenant: 403,
  permission_denied: 403,
  specialist_not_found: 404,
  task_not_found: 404,
  specialist_not_available: 409,
  idempotency_conflict: 409,
};

/** What the execution service may refuse while a task is created and started. */
const EXECUTION_STATUS: Readonly<Record<string, 403 | 409>> = {
  permission_denied: 403,
  actor_not_allowed: 403,
  organization_inactive: 409,
  specialist_not_eligible: 409,
  execution_already_terminal: 409,
  invalid_execution_transition: 409,
  execution_concurrency_conflict: 409,
};

async function answer(c: Context<AuthEnv>, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (isAgentTaskError(error)) {
      return c.json(
        {
          error: error.code,
          ...(error.code === 'invalid_task' && error.detail !== undefined
            ? { field: error.detail }
            : {}),
        },
        TASK_STATUS[error.code],
      );
    }
    if (isExecutionError(error)) {
      const status = EXECUTION_STATUS[error.code];
      if (status !== undefined) {
        return c.json(
          {
            error: error.code,
            ...(error.code === 'specialist_not_eligible' && error.detail !== undefined
              ? { reason: error.detail }
              : {}),
          },
          status,
        );
      }
    }
    throw error;
  }
}
