import { handoffForTask } from '@melonoffice/harness';
import {
  AGENT_TASK_NODE,
  AGENT_TASK_SCHEDULE_NODE,
  isAgentTaskError,
  parseAgentAnswer,
  resolveContactRef,
  type TaskContacts,
  type AgentTaskError,
  type AgentTaskService,
  type TaskWithExecution,
} from '@melonoffice/agents';
import type { DepartmentRepository } from '@melonoffice/departments';
import { isExecutionError, type AgentOutputStore } from '@melonoffice/execution';
import type { GiaAgentsPort } from '@melonoffice/gia';
import type { SpecialistRepository } from '@melonoffice/specialists';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * The organization's agents GIA may prepare a task for (AE-3, ADR-0064): active agents of an
 * active catalogue department, by name, department type and purpose. Nothing else of an agent
 * reaches GIA, and she assigns nothing: the person confirms through the routes below.
 */
export function giaAgentsOf(structure: {
  readonly departments: Pick<DepartmentRepository, 'list'>;
  readonly specialists: Pick<SpecialistRepository, 'list'>;
}): GiaAgentsPort {
  return {
    async active(tenant) {
      const organizationId = tenant.organizationId;
      const [departments, agents] = await Promise.all([
        structure.departments.list(organizationId),
        structure.specialists.list(organizationId),
      ]);
      const types = new Map(
        departments.flatMap((d) =>
          d.organizationId === organizationId &&
          d.status === 'active' &&
          d.origin.kind === 'catalog'
            ? [[d.id as string, d.origin.typeId as string] as const]
            : [],
        ),
      );
      return agents
        .filter((a) => a.organizationId === organizationId && a.status === 'active')
        .flatMap((a) => {
          const department = types.get(a.configuration.departmentId);
          if (department === undefined) return [];
          const purpose = a.configuration.purpose?.trim();
          return [
            {
              id: a.identity.id,
              name: a.identity.displayName,
              department,
              purpose: purpose === undefined || purpose === '' ? null : purpose,
            },
          ];
        })
        .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    },
  };
}

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
    /** The contacts a proposed follow-up names, read as the caller (`contact.read`). */
    readonly contacts?: TaskContacts;
  },
): void {
  const { tasksFor, outputs, contacts } = dependencies;

  /**
   * Where the follow-up the agent proposed stands (ADR-0084): waiting for a person's approval,
   * scheduled, rejected, expired, or not put to anyone (it did not resolve, or the follow-up
   * service would refuse it).
   */
  function followUpState(execution: NonNullable<TaskWithExecution['execution']>) {
    const node = execution.nodes.find((n) => n.id === AGENT_TASK_SCHEDULE_NODE);
    if (node === undefined) return 'not_scheduled';
    if (node.status === 'completed') return 'scheduled';
    if (node.status === 'skipped') return 'not_scheduled';
    const code = execution.failure?.code;
    if (code === 'approval_rejected') return 'rejected';
    if (code === 'approval_expired') return 'expired';
    if (execution.status === 'failed' || execution.status === 'cancelled') return 'not_scheduled';
    if (node.approvalId !== undefined) return 'waiting_approval';
    return 'preparing';
  }

  async function view(tenant: TenantContext, found: TaskWithExecution) {
    const { task, execution } = found;
    let answer: {
      answer: string;
      missing: string[];
      facts: number;
      followUp: {
        contactId: string | null;
        contactName: string | null;
        type: string;
        title: string;
        date: string;
        time: string;
        state: string;
        approvalId: string | null;
      } | null;
    } | null = null;
    // The answer is shown once the agent's work passed its shape check (ADR-0063): when the task
    // completed and was verified, or while its proposed follow-up waits on a person or after the
    // person turned it down (ADR-0084), where the answer itself is the one checked the same way.
    const work = execution?.nodes.find((n) => n.id === AGENT_TASK_NODE);
    const code = execution?.failure?.code;
    const readable =
      execution !== undefined &&
      work?.status === 'completed' &&
      (execution.status === 'completed' ||
        execution.status === 'waiting_approval' ||
        execution.status === 'running' ||
        (execution.status === 'failed' && code !== undefined && code.startsWith('approval_')));
    if (readable && execution !== undefined && outputs !== undefined) {
      const record = await outputs.find(tenant, task.id, AGENT_TASK_NODE);
      const parsed = record === undefined ? undefined : parseAgentAnswer(record.output);
      if (parsed !== undefined) {
        let followUp = null;
        if (parsed.followUp !== null) {
          const list = contacts === undefined ? [] : await contacts.list(tenant).catch(() => []);
          const contact = resolveContactRef(list, parsed.followUp.contact);
          const node = execution.nodes.find((n) => n.id === AGENT_TASK_SCHEDULE_NODE);
          const state = followUpState(execution);
          followUp = {
            contactId: contact?.id ?? null,
            contactName: contact?.name ?? null,
            type: parsed.followUp.type,
            title: parsed.followUp.title,
            date: parsed.followUp.date,
            time: parsed.followUp.time,
            state,
            approvalId: state === 'waiting_approval' ? (node?.approvalId ?? null) : null,
          };
        }
        answer = {
          answer: parsed.answer,
          missing: [...parsed.missing],
          facts: parsed.facts.length,
          followUp,
        };
      }
    }
    return {
      id: task.id,
      specialistId: task.specialistId,
      specialistVersion: task.specialistVersion,
      request: task.request,
      requestedBy: task.requestedBy,
      createdAt: task.createdAt,
      maxCredits: task.maxCredits ?? null,
      status: execution?.status ?? 'unknown',
      failure: execution?.failure?.code ?? null,
      completedAt: execution?.completedAt ?? null,
      answer,
      // Whether the task now needs a person, and why (ADR-0101). Who and how is the screen's.
      handoff: handoffForTask({
        status: execution?.status ?? 'unknown',
        failure: execution?.failure?.code ?? null,
        missing: answer?.missing ?? [],
      }),
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

/** The same answers for a task started elsewhere on a person's request (the Harness, ADR-0099). */
export const answerTaskRequest = answer;
