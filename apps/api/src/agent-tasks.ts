import { dayRange } from '@melonoffice/activity';
import type { AuditHistoryReader } from '@melonoffice/audit';
import type {
  AgentHandoff,
  AICallTrace,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import { callRefOf, handoffForTask } from '@melonoffice/harness';
import {
  AGENT_TASK_NODE,
  answerNodeOf,
  AGENT_TASK_SCHEDULE_NODE,
  isAgentTaskError,
  isStaleWork,
  MODEL_FOLLOW_UP_TOOL,
  parseAgentAnswer,
  parseTaskFollowUp,
  readAgentTaskTrace,
  resolveContactRef,
  type TaskContacts,
  type AgentHandoffService,
  type AgentMemoryService,
  type AgentNotificationService,
  type AgentTaskService,
  type TaskWithExecution,
  AgentTaskError,
  ALL_AGENTS,
  decodeTaskCursor,
  encodeTaskCursor,
  EXECUTION_STATUSES,
  TASK_PAGE_SIZE,
  taskPosition,
  type OrganizationTaskPage,
  type TaskPosition,
} from '@melonoffice/agents';
import type { DepartmentRepository } from '@melonoffice/departments';
import { isExecutionError, type AgentOutputStore } from '@melonoffice/execution';
import type { GiaAgentsPort } from '@melonoffice/gia';
import { planStepOf, stepApprovalEntriesOf } from '@melonoffice/planning';
import type { SpecialistRepository } from '@melonoffice/specialists';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { DEFAULT_ACTIVITY_TIME_ZONE } from './activity.js';
import {
  newerThan,
  type createPlanStepSource,
  type PlanStepItem,
  type PlanStepPage,
} from './plan-step-work.js';
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

/** Whether the task's answer passed its checks and may be shown (ADR-0063, ADR-0084). */
function answerReadable(execution: TaskWithExecution['execution'], answerNode: string): boolean {
  const work = execution?.nodes.find((n) => n.id === answerNode);
  const code = execution?.failure?.code;
  return (
    execution !== undefined &&
    work?.status === 'completed' &&
    (execution.status === 'completed' ||
      execution.status === 'waiting_approval' ||
      execution.status === 'running' ||
      (execution.status === 'failed' && code !== undefined && code.startsWith('approval_')))
  );
}

/** Where an item of the list of every agent's work comes from (ADR-0149). */
const ORIGINS: ReadonlySet<string> = new Set(['all', 'task', 'plan_step']);

/** The longest answer summary the organization's list shows (ADR-0148). */
export const TASK_SUMMARY_LENGTH = 280;

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
    /** Agents' own memories (ADR-0117). Absent: their routes are not served. */
    readonly memoriesFor?: (requestId: string | undefined) => AgentMemoryService;
    /** Handoffs between agents (ADR-0117). Absent: tasks show none and none can be decided. */
    readonly handoffsFor?: (requestId: string | undefined) => AgentHandoffService;
    /** The person's in-app notices about their agents (ADR-0117). Absent: not served. */
    readonly notifications?: AgentNotificationService;
    /** The audit trail of a task and its handoff, for its trace (ADR-0117). */
    readonly history?: AuditHistoryReader;
    /** Plan steps agents run (ADR-0149), for the list of every agent's work. Absent: tasks only. */
    readonly planSteps?: Pick<ReturnType<typeof createPlanStepSource>, 'page'>;
    /** The business's time zone, for the days the organization's list is narrowed to. */
    readonly timeZoneOf?: (tenant: TenantContext) => Promise<string | undefined>;
    readonly now?: () => Date;
  },
): void {
  const {
    tasksFor,
    outputs,
    contacts,
    memoriesFor,
    handoffsFor,
    notifications,
    history,
    timeZoneOf,
    planSteps,
  } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  /** A handoff as a person reads it: who asked whom, why, its state and what it spent. */
  const handoffView = (h: AgentHandoff) => ({
    state: h.state,
    reason: h.reason,
    department: h.department,
    request: h.request,
    context: h.context,
    requestingAgentId: h.requestingAgent.specialistId,
    receivingAgentId: h.receivingAgent?.specialistId ?? null,
    childTaskId: h.childTaskId ?? null,
    refusal: h.refusal ?? null,
    maxCredits: h.maxCredits ?? null,
    creditsConsumed: h.creditsConsumed ?? null,
    decidedAt: h.decision?.at ?? null,
    createdAt: h.createdAt,
  });

  /**
   * Where the follow-up the agent proposed stands (ADR-0084): waiting for a person's approval,
   * scheduled, rejected, expired, or not put to anyone (it did not resolve, or the follow-up
   * service would refuse it).
   */
  function followUpState(
    execution: NonNullable<TaskWithExecution['execution']>,
    node = execution.nodes.find((n) => n.id === AGENT_TASK_SCHEDULE_NODE),
  ) {
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

  /**
   * The follow-up the agent asked to schedule with its own tool, `follow_up_schedule@3`
   * (ADR-0104): its latest call, as the model made it, with the contact it names resolved here
   * for the caller, and where it stands. It is shown while a person must approve it, before the
   * agent has answered.
   */
  async function toolFollowUpOf(
    tenant: TenantContext,
    execution: NonNullable<TaskWithExecution['execution']>,
  ) {
    const node = execution.nodes.findLast(
      (n) =>
        n.type === 'tool' &&
        n.tool?.id === MODEL_FOLLOW_UP_TOOL.id &&
        n.tool.version === MODEL_FOLLOW_UP_TOOL.version,
    );
    const ref = node === undefined ? undefined : callRefOf(node);
    if (node === undefined || ref === undefined || outputs === undefined) return null;
    const record = await outputs.find(tenant, execution.id, ref.agentNodeId);
    const call = record?.output.toolCalls?.[ref.index];
    const asked =
      call?.name === MODEL_FOLLOW_UP_TOOL.id ? parseTaskFollowUp(call.arguments) : undefined;
    if (asked === undefined) return null;
    const list = contacts === undefined ? [] : await contacts.list(tenant).catch(() => []);
    const contact = resolveContactRef(list, asked.contact);
    const state = followUpState(execution, node);
    return {
      contactId: contact?.id ?? null,
      contactName: contact?.name ?? null,
      type: asked.type,
      title: asked.title,
      date: asked.date,
      time: asked.time,
      state,
      approvalId: state === 'waiting_approval' ? (node.approvalId ?? null) : null,
    };
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
    // How the task's model call was served (ADR-0100): provider, model, cost, credits, the limit
    // and any escalation. Codes and numbers only; shown only with the answer it served.
    let ai: AICallTrace | null = null;
    // The answering node: the agent's last turn, after any tools it used (ADR-0103).
    const answerNode = execution === undefined ? AGENT_TASK_NODE : answerNodeOf(execution);
    const readable = answerReadable(execution, answerNode);
    if (readable && execution !== undefined && outputs !== undefined) {
      const record = await outputs.find(tenant, task.id, answerNode);
      ai = record?.ai ?? null;
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
    const proposed =
      handoffsFor === undefined ? undefined : await handoffsFor(undefined).get(tenant, task.id);
    return {
      id: task.id,
      specialistId: task.specialistId,
      specialistVersion: task.specialistVersion,
      // The task it was handed from (ADR-0117), when another agent proposed it.
      parentTaskId: task.parentTaskId ?? null,
      // The handoff this task proposed (ADR-0117), if any: a person accepts or declines it.
      agentHandoff: proposed === undefined ? null : handoffView(proposed),
      request: task.request,
      requestedBy: task.requestedBy,
      createdAt: task.createdAt,
      maxCredits: task.maxCredits ?? null,
      ai,
      status: execution?.status ?? 'unknown',
      failure: execution?.failure?.code ?? null,
      completedAt: execution?.completedAt ?? null,
      // Open but not moving for long (ADR-0120): the person may stop it; it never blocks the agent.
      stale: execution !== undefined && isStaleWork(execution, now()),
      answer,
      // A follow-up the agent asked for with its tool (ADR-0104), approved by a person first.
      toolFollowUp: execution === undefined ? null : await toolFollowUpOf(tenant, execution),
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

  /**
   * A task as the organization's list shows it (ADR-0148): only these fields, decided here.
   * The verified answer is cut to a summary; the model, its cost, the contacts a follow-up names,
   * approvals and handoffs stay on the agent's own page. Reading it calls no model.
   */
  async function listedView(
    tenant: TenantContext,
    found: TaskWithExecution,
    agents: OrganizationTaskPage['agents'],
  ) {
    const { task, execution } = found;
    const agent = agents[task.specialistId];
    const answerNode = execution === undefined ? AGENT_TASK_NODE : answerNodeOf(execution);
    let result: { summary: string; truncated: boolean; missing: number } | null = null;
    if (answerReadable(execution, answerNode) && outputs !== undefined) {
      const record = await outputs.find(tenant, task.id, answerNode);
      const parsed = record === undefined ? undefined : parseAgentAnswer(record.output);
      if (parsed !== undefined) {
        result = {
          summary: parsed.answer.slice(0, TASK_SUMMARY_LENGTH),
          truncated: parsed.answer.length > TASK_SUMMARY_LENGTH,
          missing: parsed.missing.length,
        };
      }
    }
    const nodes = execution?.nodes ?? [];
    const step = execution === undefined ? undefined : planStepOf(execution);
    return {
      id: task.id,
      agent: {
        id: task.specialistId,
        name: agent?.name ?? null,
        status: agent?.status ?? null,
      },
      request: task.request,
      status: execution?.status ?? 'unknown',
      failure: execution?.failure?.code ?? null,
      createdAt: task.createdAt,
      updatedAt: execution?.updatedAt ?? null,
      startedAt: execution?.startedAt ?? null,
      completedAt: execution?.completedAt ?? null,
      progress: {
        done: nodes.filter((n) => n.status === 'completed' || n.status === 'skipped').length,
        total: nodes.length,
      },
      steps: nodes.map((n) => ({
        type: n.type,
        status: n.status,
        startedAt: n.startedAt ?? null,
        completedAt: n.completedAt ?? null,
        failure: n.error?.code ?? null,
      })),
      plan: step === undefined ? null : { id: step.planId },
      handedFrom: task.parentTaskId ?? null,
      result,
    };
  }

  /**
   * A plan step as the same list shows it (ADR-0149): the plan engine's own reading of the step
   * (`readPlanSteps`), with only these fields. It stays a step of its plan, and the plan's page
   * is where it is acted on.
   */
  function stepView(item: PlanStepItem, agents: OrganizationTaskPage['agents']) {
    const { plan, step, read, execution } = item;
    const agentId = step.specialist?.id ?? null;
    const agent = agentId === null ? undefined : agents[agentId];
    const nodes = execution?.nodes ?? [];
    // Its own approval (ADR-0146) and its tool steps' (ADR-0151): a declined one says why.
    const entries = stepApprovalEntriesOf(plan, step.id);
    const entry = entries.find((a) => a.declined !== undefined) ?? entries[0];
    const answered = read.answer;
    return {
      id: execution?.id ?? read.executionId,
      origin: 'plan_step' as const,
      agent: { id: agentId, name: agent?.name ?? null, status: agent?.status ?? null },
      request: step.label,
      status: execution?.status ?? 'unknown',
      failure: read.failure,
      createdAt: item.position.at,
      updatedAt: execution?.updatedAt ?? null,
      startedAt: execution?.startedAt ?? null,
      completedAt: execution?.completedAt ?? null,
      progress: {
        done: nodes.filter((n) => n.status === 'completed' || n.status === 'skipped').length,
        total: nodes.length,
      },
      steps: nodes.map((n) => ({
        type: n.type,
        status: n.status,
        startedAt: n.startedAt ?? null,
        completedAt: n.completedAt ?? null,
        failure: n.error?.code ?? null,
      })),
      plan: { id: plan.id, status: plan.status, step: { state: read.state } },
      // The steps it waits on, by their label and where each is.
      dependsOn: step.dependsOn.flatMap((id) => {
        const before = item.siblings.find((v) => v.stepId === id);
        return before === undefined ? [] : [{ label: before.label, state: before.state }];
      }),
      // A step that asked people (ADR-0146, ADR-0151): waiting, approved, or why it was declined.
      approval:
        entry === undefined
          ? null
          : {
              state:
                entry.declined !== undefined
                  ? entry.declined.reason
                  : read.state === 'awaiting_approval'
                    ? 'pending'
                    : 'approved',
            },
      handedFrom: null,
      result:
        answered === null
          ? null
          : {
              summary: answered.slice(0, TASK_SUMMARY_LENGTH),
              truncated: answered.length > TASK_SUMMARY_LENGTH,
              missing: read.missing.length,
            },
    };
  }

  // Every agent's work in the organization, newest first, read only (ADR-0148, ADR-0149): the
  // tasks people asked agents for (`specialist.read`) and, for a person who may read plans
  // (`plan.read`), the plan steps agents run. Two sources, each read through its own service and
  // permission, merged by one position; nothing is copied. Days are the business's.
  app.get(
    '/v1/organizations/:organizationId/agent-tasks',
    withPermission('specialist.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const q = (name: string) => c.req.query(name);
        const origin = q('origin') ?? 'all';
        if (!ORIGINS.has(origin)) throw new AgentTaskError('invalid_task', 'origin');
        const rawLimit = q('limit');
        const limit =
          rawLimit === undefined
            ? TASK_PAGE_SIZE.page
            : /^\d{1,3}$/.test(rawLimit)
              ? Number(rawLimit)
              : -1;
        if (limit < 1 || limit > TASK_PAGE_SIZE.max)
          throw new AgentTaskError('invalid_task', 'limit');
        const status = q('status');
        if (status !== undefined && !EXECUTION_STATUSES.has(status)) {
          throw new AgentTaskError('invalid_task', 'status');
        }
        const asked = q('from') !== undefined || q('to') !== undefined;
        const period = !asked
          ? undefined
          : dayRange(
              {
                ...(q('from') === undefined ? {} : { from: q('from') }),
                ...(q('to') === undefined ? {} : { to: q('to') }),
              },
              (await timeZoneOf?.(tenant)) ?? DEFAULT_ACTIVITY_TIME_ZONE,
              now(),
            );
        if (asked && period === undefined) throw new AgentTaskError('invalid_task', 'period');
        const since = period?.from.toISOString() as IsoTimestamp | undefined;
        const before = period?.to.toISOString() as IsoTimestamp | undefined;
        const cursor = q('cursor');
        const organizationId = tenant.organizationId as OrganizationId;
        const fromCursor =
          cursor === undefined ? undefined : decodeTaskCursor(cursor, organizationId, ALL_AGENTS);
        const agent = q('agent');
        const service = tasksFor(c.get('requestId'));

        // Tasks people asked agents for.
        const tasks =
          origin === 'plan_step'
            ? undefined
            : await service.listAll(tenant, {
                ...(cursor === undefined ? {} : { cursor }),
                limit,
                ...(agent === undefined ? {} : { specialistId: agent }),
                ...(status === undefined ? {} : { status }),
                ...(since === undefined || before === undefined ? {} : { since, before }),
              });
        const agents = tasks?.agents ?? (await service.agentsOf(tenant));

        // Plan steps agents run, with the plan's own permission.
        let stepSource: 'read' | 'not_permitted' | 'unavailable' | 'not_asked' = 'not_asked';
        let steps: PlanStepPage | undefined;
        if (origin !== 'task' && planSteps !== undefined) {
          // The end of the period, as a position: everything created before it is read.
          const bound =
            before === undefined
              ? undefined
              : {
                  at: new Date(Date.parse(before) - 1).toISOString() as IsoTimestamp,
                  id: '~' as ExecutionId,
                };
          const after =
            fromCursor === undefined || bound === undefined
              ? (fromCursor ?? bound)
              : newerThan(bound, fromCursor)
                ? fromCursor
                : bound;
          try {
            steps = await planSteps.page(tenant, {
              ...(after === undefined ? {} : { after }),
              ...(since === undefined ? {} : { since }),
              limit,
              ...(agent === undefined ? {} : { specialistId: agent }),
              ...(status === undefined ? {} : { status }),
            });
            stepSource = 'read';
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code === 'permission_denied') {
              // Asked for plan steps alone without `plan.read`: refused, as the plan routes do.
              if (origin === 'plan_step') throw new AgentTaskError('permission_denied');
              stepSource = 'not_permitted';
            } else {
              // One source failing never hides the other: the list says plan steps are missing.
              c.get('logger').warn('plan steps not read for the agent work list', {
                code: typeof code === 'string' ? code : 'unexpected',
              });
              stepSource = 'unavailable';
            }
          }
        } else if (origin !== 'task') {
          stepSource = 'unavailable';
        }

        // One order for both: newest first, then by id. A source with more left stops the page
        // at the last item it read, so no item of either is ever skipped between pages.
        const horizons = [
          tasks?.nextCursor == null
            ? undefined
            : decodeTaskCursor(tasks.nextCursor, organizationId, ALL_AGENTS),
          steps?.horizon,
        ].filter((h): h is TaskPosition => h !== undefined);
        const horizon = horizons.reduce<TaskPosition | undefined>(
          (newest, h) => (newest === undefined || newerThan(h, newest) ? h : newest),
          undefined,
        );
        const merged = [
          ...(tasks?.items ?? []).map((item) => ({
            position: taskPosition(item.task),
            task: item,
          })),
          ...(steps?.items ?? []).map((item) => ({ position: item.position, step: item })),
        ]
          .filter((m) => horizon === undefined || !newerThan(horizon, m.position))
          .sort((a, b) => (newerThan(a.position, b.position) ? -1 : 1));
        const shown = merged.slice(0, limit);
        const cut = merged.length > limit;
        const last = shown.at(-1)?.position;
        const next = cut ? last : horizon;
        return c.json({
          tasks: await Promise.all(
            shown.map(async (m) =>
              'task' in m && m.task !== undefined
                ? {
                    ...(await listedView(tenant, m.task, agents)),
                    origin: 'task' as const,
                    dependsOn: [],
                    approval: null,
                  }
                : stepView((m as { step: PlanStepItem }).step, agents),
            ),
          ),
          agents: Object.entries(agents)
            .map(([id, a]) => ({ id, name: a.name, status: a.status }))
            .sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id)),
          statuses: [...EXECUTION_STATUSES],
          origins: [...ORIGINS],
          origin,
          // Whether plan steps were read: `not_permitted` without `plan.read`, `unavailable` if
          // their source failed.
          sources: {
            task: tasks === undefined ? 'not_asked' : 'read',
            plan_step: stepSource,
          },
          period: period === undefined ? null : { from: period.fromDay, to: period.toDay },
          nextCursor:
            next === undefined ? null : encodeTaskCursor(organizationId, ALL_AGENTS, next),
        });
      }),
    ),
  );

  // An agent's own memory (ADR-0117): read with `specialist.read`; adding a note, deleting one
  // or all of them with `specialist.manage`, a person directly, which the service checks again.
  if (memoriesFor !== undefined) {
    const memoryPath = '/v1/organizations/:organizationId/specialists/:specialistId/memories';
    app.get(
      memoryPath,
      withPermission('specialist.read', dependencies, async (c, tenant) =>
        answer(c, async () =>
          c.json(
            await memoriesFor(c.get('requestId')).list(tenant, c.req.param('specialistId') ?? ''),
          ),
        ),
      ),
    );
    app.post(
      memoryPath,
      withPermission('specialist.manage', dependencies, async (c, tenant) =>
        answer(c, async () =>
          c.json(
            await memoriesFor(c.get('requestId')).remember(
              tenant,
              c.req.param('specialistId') ?? '',
              await bodyOf(c),
            ),
            201,
          ),
        ),
      ),
    );
    app.delete(
      memoryPath,
      withPermission('specialist.manage', dependencies, async (c, tenant) =>
        answer(c, async () =>
          c.json({
            deleted: await memoriesFor(c.get('requestId')).clear(
              tenant,
              c.req.param('specialistId') ?? '',
            ),
          }),
        ),
      ),
    );
    app.delete(
      `${memoryPath}/:memoryId`,
      withPermission('specialist.manage', dependencies, async (c, tenant) =>
        answer(c, async () => {
          await memoriesFor(c.get('requestId')).forget(
            tenant,
            c.req.param('specialistId') ?? '',
            c.req.param('memoryId') ?? '',
          );
          return c.body(null, 204);
        }),
      ),
    );
  }

  // The person's own notices about their agents (ADR-0117): only theirs, ids and codes only.
  if (notifications !== undefined) {
    const notificationsPath = '/v1/organizations/:organizationId/notifications';
    app.get(
      notificationsPath,
      withPermission('specialist.read', dependencies, async (c, tenant) =>
        answer(c, async () => {
          const cursor = c.req.query('cursor');
          const limit = c.req.query('limit');
          const page = await notifications.list(tenant, {
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit: /^\d{1,3}$/.test(limit) ? Number(limit) : -1 }),
          });
          return c.json({
            notifications: page.items.map((n) => ({
              id: n.id,
              kind: n.kind,
              specialistId: n.specialistId,
              taskId: n.taskId,
              planId: n.planId,
              code: n.code,
              otherSpecialistId: n.otherSpecialistId,
              createdAt: n.createdAt,
              read: n.readAt !== null,
            })),
            nextCursor: page.nextCursor,
            unread: page.unread,
          });
        }),
      ),
    );
    app.post(
      `${notificationsPath}/read`,
      withPermission('specialist.read', dependencies, async (c, tenant) =>
        answer(c, async () => c.json({ marked: await notifications.markAllRead(tenant) })),
      ),
    );
    app.post(
      `${notificationsPath}/:notificationId/read`,
      withPermission('specialist.read', dependencies, async (c, tenant) =>
        answer(c, async () => {
          await notifications.markRead(tenant, c.req.param('notificationId'));
          return c.body(null, 204);
        }),
      ),
    );
  }

  // Handoffs between agents (ADR-0117): a person accepts or declines what an agent proposed.
  if (handoffsFor !== undefined) {
    for (const decision of ['accept', 'decline'] as const) {
      app.post(
        `/v1/organizations/:organizationId/agent-tasks/:taskId/handoff/${decision}`,
        withPermission('specialist.task', dependencies, async (c, tenant) =>
          answer(c, async () => {
            const handoffs = handoffsFor(c.get('requestId'));
            const taskId = c.req.param('taskId') ?? '';
            const decided =
              decision === 'accept'
                ? await handoffs.accept(tenant, taskId)
                : await handoffs.decline(tenant, taskId);
            return c.json(handoffView(decided));
          }),
        ),
      );
    }
  }

  app.get(
    '/v1/organizations/:organizationId/agent-tasks/:taskId',
    withPermission('specialist.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const found = await tasksFor(c.get('requestId')).get(tenant, c.req.param('taskId') ?? '');
        return c.json(await view(tenant, found));
      }),
    ),
  );

  // Everything that happened in the task (ADR-0117): steps, tools, approvals, models, credits, its
  // review, the task it handed on and its audit trail. Codes, ids and numbers only.
  if (outputs !== undefined) {
    app.get(
      '/v1/organizations/:organizationId/agent-tasks/:taskId/trace',
      withPermission('specialist.read', dependencies, async (c, tenant) =>
        answer(c, async () =>
          c.json(
            await readAgentTaskTrace(tenant, c.req.param('taskId') ?? '', {
              tasks: tasksFor(c.get('requestId')),
              outputs,
              ...(handoffsFor === undefined ? {} : { handoffs: handoffsFor(undefined) }),
              ...(history === undefined ? {} : { history }),
            }),
          ),
        ),
      ),
    );
  }
}

const bodyOf = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const body: unknown = await c.req.json().catch(() => undefined);
  return (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null
  ) as Record<string, unknown>;
};

const TASK_STATUS: Record<AgentTaskError['code'], 400 | 403 | 404 | 409 | 429> = {
  invalid_task: 400,
  unresolved_tenant: 403,
  permission_denied: 403,
  specialist_not_found: 404,
  task_not_found: 404,
  specialist_not_available: 409,
  idempotency_conflict: 409,
  invalid_memory: 400,
  memory_not_found: 404,
  memory_full: 409,
  handoff_not_found: 404,
  handoff_not_pending: 409,
  handoff_expired: 409,
  no_agent_available: 409,
  budget_exhausted: 409,
  notification_not_found: 404,
  agent_busy: 429,
  organization_busy: 429,
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
          ...((error.code === 'invalid_task' || error.code === 'invalid_memory') &&
          error.detail !== undefined
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
