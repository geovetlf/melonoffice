import type { Workflow, WorkflowStatus, WorkflowVersion } from '@melonoffice/domain';
import { isExecutionError } from '@melonoffice/execution';
import { withCorrelation } from '@melonoffice/observability';
import { isPlanningError } from '@melonoffice/planning';
import { isWorkflowError, WORKFLOW_STATUSES, type WorkflowService } from '@melonoffice/workflows';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { toPlanView, toVersionView } from './plans.js';

/**
 * Workflow routes (ADR-0028, ADR-0071). Reading needs `workflow.read`. The owner creates,
 * versions and moves workflows (`workflow.manage`) and plans one (`plan.create`, a person acting
 * directly). A workflow runs nothing: planning one proposes a plan through the same validation
 * as the planner's, and that plan always waits for the person's approval. Every body is exact:
 * any other field is refused. Another organization's workflow answers like a missing one.
 */
export function registerWorkflowRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly workflows: WorkflowService },
): void {
  const { workflows } = dependencies;
  const base = '/v1/organizations/:organizationId/workflows';

  app.get(
    base,
    withPermission('workflow.read', dependencies, async (c, tenant) =>
      c.json({ workflows: (await workflows.list(tenant)).map(toWorkflowView) }),
    ),
  );

  app.get(
    `${base}/:workflowId`,
    withPermission('workflow.read', dependencies, async (c, tenant) => {
      try {
        const workflow = await workflows.get(tenant, c.req.param('workflowId') ?? '');
        const version = await workflows.getVersion(tenant, workflow.id, workflow.version);
        return c.json({ ...toWorkflowView(workflow), current: toWorkflowVersionView(version) });
      } catch (error) {
        if (isWorkflowError(error) && error.code === 'workflow_not_found') {
          return c.json({ error: 'workflow_not_found' }, 404);
        }
        throw error;
      }
    }),
  );

  app.post(
    base,
    withPermission('workflow.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['name', 'steps'], ['name', 'steps']);
      if (body === undefined || typeof body.name !== 'string') return invalid(c);
      const { name, steps } = body;
      return answer(c, 201, async () => {
        const workflow = await workflows.create(tenant, { name, steps });
        withCorrelation(c.get('logger'), { workflowId: workflow.id }).info('workflow created');
        return toWorkflowView(workflow);
      });
    }),
  );

  app.post(
    `${base}/:workflowId/versions`,
    withPermission('workflow.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['name', 'steps'], ['steps']);
      if (body === undefined || (body.name !== undefined && typeof body.name !== 'string')) {
        return invalid(c);
      }
      const { name, steps } = body;
      return answer(c, 201, async () => {
        const workflow = await workflows.publishVersion(
          tenant,
          c.req.param('workflowId') ?? '',
          typeof name === 'string' ? { name, steps } : { steps },
        );
        withCorrelation(c.get('logger'), { workflowId: workflow.id }).info('workflow versioned');
        return toWorkflowView(workflow);
      });
    }),
  );

  app.post(
    `${base}/:workflowId/status`,
    withPermission('workflow.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['from', 'to'], ['from', 'to']);
      if (body === undefined || !isStatus(body.from) || !isStatus(body.to)) return invalid(c);
      const { from, to } = body;
      return answer(c, 200, async () => {
        const workflow = await workflows.changeStatus(tenant, c.req.param('workflowId') ?? '', {
          from,
          to,
        });
        withCorrelation(c.get('logger'), { workflowId: workflow.id }).info('workflow status');
        return toWorkflowView(workflow);
      });
    }),
  );

  // A person plans the workflow's current version. The plan waits for their approval.
  app.post(
    `${base}/:workflowId/plans`,
    withPermission('plan.create', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['requestKey'], ['requestKey']);
      if (body === undefined || typeof body.requestKey !== 'string') return invalid(c);
      const { requestKey } = body;
      try {
        const outcome = await workflows.plan(tenant, c.req.param('workflowId') ?? '', {
          requestKey,
        });
        const log = withCorrelation(c.get('logger'), { executionId: outcome.executionId });
        if (outcome.status === 'refused') {
          log.info('workflow plan refused');
          return c.json(
            {
              error: 'plan_refused',
              executionId: outcome.executionId,
              stage: outcome.stage,
              reason: outcome.reason,
              ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            },
            422,
          );
        }
        log.info('workflow planned');
        return c.json(
          { ...toPlanView(outcome.plan), current: toVersionView(outcome.version) },
          201,
        );
      } catch (error) {
        return refusal(c, error);
      }
    }),
  );
}

const isStatus = (value: unknown): value is WorkflowStatus =>
  (WORKFLOW_STATUSES as readonly unknown[]).includes(value);

const invalid = (c: Context<AuthEnv>) => c.json({ error: 'invalid_request' }, 400);

/** A JSON object with only `allowed` fields and every `required` one, or nothing. */
async function bodyOf(
  c: Context<AuthEnv>,
  allowed: readonly string[],
  required: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((k) => !allowed.includes(k))) return undefined;
  if (required.some((k) => record[k] === undefined)) return undefined;
  return record;
}

const STATUS = {
  workflow_not_found: 404,
  permission_denied: 403,
  invalid_workflow: 400,
  invalid_workflow_transition: 409,
  workflow_concurrency_conflict: 409,
  workflow_not_active: 409,
  assignee_unavailable: 409,
  workflow_plan_ended: 409,
  // From the plan and execution services the workflow calls.
  execution_not_plannable: 409,
  specialist_not_eligible: 409,
  plan_concurrency_conflict: 409,
  execution_concurrency_conflict: 409,
} as const;

function refusal(c: Context<AuthEnv>, error: unknown): Response {
  const coded =
    isWorkflowError(error) || isPlanningError(error) || isExecutionError(error) ? error : undefined;
  if (coded !== undefined && Object.hasOwn(STATUS, coded.code)) {
    const code = coded.code as keyof typeof STATUS;
    return c.json(
      {
        error: code,
        // Which field, for an invalid workflow: a code, never user data.
        ...(code === 'invalid_workflow' && coded.detail !== undefined
          ? { detail: coded.detail }
          : {}),
      },
      STATUS[code],
    );
  }
  throw error;
}

async function answer(
  c: Context<AuthEnv>,
  status: 200 | 201,
  work: () => Promise<unknown>,
): Promise<Response> {
  try {
    return c.json(await work(), status);
  } catch (error) {
    return refusal(c, error);
  }
}

export const toWorkflowView = (w: Workflow) => ({
  id: w.id,
  name: w.name,
  status: w.status,
  version: w.version,
  createdAt: w.createdAt,
  createdBy: w.createdBy,
  updatedAt: w.updatedAt,
});

const toWorkflowVersionView = (v: WorkflowVersion) => ({
  version: v.version,
  name: v.name,
  steps: v.steps.map((s) => ({
    id: s.id,
    kind: s.kind,
    label: s.label,
    dependsOn: [...s.dependsOn],
    assignee:
      s.assignee === undefined
        ? null
        : { departmentTypeId: s.assignee.departmentTypeId, roleId: s.assignee.roleId },
    performedBy: s.performedBy ?? null,
    tool: s.tool === undefined ? null : { id: s.tool.id, version: s.tool.version },
    // A tool step's fixed input and the earlier results it takes (ADR-0161), so the editor can
    // show and rewrite it (ADR-0165). Checked plain values and step references only.
    input: s.input === undefined ? null : { ...s.input },
    inputFrom:
      s.inputFrom === undefined
        ? null
        : Object.fromEntries(
            Object.entries(s.inputFrom).map(([key, ref]) => [
              key,
              ref.field === undefined ? { step: ref.step } : { step: ref.step, field: ref.field },
            ]),
          ),
    // A wait's length (ADR-0152), so the editor can show and rewrite it (ADR-0158).
    wait: s.wait === undefined ? null : { seconds: s.wait.seconds },
    // A check's decision (WF-4): its type, the outcomes that go on and its fixed input, which
    // holds only short codes and numbers, so the editor can show and rewrite it.
    decision:
      s.decision === undefined
        ? null
        : {
            decision: s.decision.decision,
            continueOn: [...s.decision.continueOn],
            input: { ...s.decision.input },
          },
    approvalRequired: s.approvalRequired ?? false,
  })),
  createdAt: v.createdAt,
});
