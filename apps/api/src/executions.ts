import type { Execution, ExecutionFailure, ExecutionRef } from '@melonoffice/domain';
import { isExecutionError, type ExecutionService } from '@melonoffice/execution';
import { withCorrelation } from '@melonoffice/observability';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Execution routes (ADR-0024, ADR-0029). Executions are created and moved by server-side code;
 * a client can read one, start one that is pending, and ask one to stop. Tenancy picks the
 * organization from the caller's membership, RBAC checks the permission, and only then is the
 * execution touched, from the resolved tenant. An execution of another organization answers
 * exactly like one that does not exist.
 */
export function registerExecutionRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly executions: ExecutionService },
): void {
  const { executions } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/executions/:executionId',
    withPermission('execution.read', dependencies, async (c, tenant) => {
      const executionId = c.req.param('executionId') ?? '';
      try {
        const execution = await executions.get(tenant, executionId);
        withCorrelation(c.get('logger'), { executionId: execution.id }).info('execution read');
        return c.json(toView(execution));
      } catch (error) {
        if (isExecutionError(error) && error.code === 'execution_not_found') {
          return c.json({ error: 'execution_not_found' }, 404);
        }
        throw error;
      }
    }),
  );
  // Only a person, signed in and acting directly, starts or cancels: the service refuses GIA and
  // the runtime even when RBAC would allow the user behind them.
  app.post(
    '/v1/organizations/:organizationId/executions/:executionId/start',
    withPermission('execution.start', dependencies, (c, tenant) =>
      answer(c, async () =>
        toView(await executions.start(tenant, c.req.param('executionId') ?? '')),
      ),
    ),
  );
  app.post(
    '/v1/organizations/:organizationId/executions/:executionId/cancel',
    withPermission('execution.cancel', dependencies, async (c, tenant) => {
      const reason = await reasonOf(c);
      if (reason === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () =>
        toView(await executions.cancel(tenant, c.req.param('executionId') ?? '', reason)),
      );
    }),
  );
}

const REASON = /^[a-z][a-z_]{0,63}$/;

/** The cancellation body: exactly `{ reason }`, a stable code. */
async function reasonOf(c: Context<AuthEnv>): Promise<string | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { reason, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  return typeof reason === 'string' && REASON.test(reason) ? reason : undefined;
}

const STATUS = {
  execution_not_found: 404,
  actor_not_allowed: 403,
  permission_denied: 403,
  execution_already_terminal: 409,
  execution_concurrency_conflict: 409,
  invalid_execution_transition: 409,
  execution_parent_ended: 409,
} as const;

async function answer(c: Context<AuthEnv>, work: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await work());
  } catch (error) {
    if (isExecutionError(error) && Object.hasOwn(STATUS, error.code)) {
      const code = error.code as keyof typeof STATUS;
      c.get('logger').warn('execution refused', { code });
      return c.json({ error: code }, STATUS[code]);
    }
    throw error;
  }
}

const refView = (ref: ExecutionRef | undefined) =>
  ref === undefined ? null : { type: ref.type, id: ref.id };
const failureView = (failure: ExecutionFailure | undefined) =>
  failure === undefined ? null : { code: failure.code, ref: refView(failure.ref) };

/**
 * The public view. It carries states, references and versions only: no request id, revision or
 * storage detail, and executions hold no prompts, bodies or secrets to begin with.
 */
function toView(execution: Execution) {
  return {
    id: execution.id,
    organizationId: execution.organizationId,
    userId: execution.userId,
    mode: execution.mode,
    status: execution.status,
    input: refView(execution.input),
    currentNodeId: execution.currentNodeId ?? null,
    parentExecutionId: execution.parentExecutionId ?? null,
    workflowId: execution.workflowId ?? null,
    specialistId: execution.specialistId ?? null,
    specialistVersion: execution.specialistVersion ?? null,
    departmentId: execution.departmentId ?? null,
    versionSnapshot: {
      schemaVersion: execution.versionSnapshot.schemaVersion,
      components: execution.versionSnapshot.components.map(({ kind, id, version }) => ({
        kind,
        id,
        version,
      })),
    },
    nodes: execution.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      status: node.status,
      dependsOn: [...node.dependsOn],
      owner:
        node.owner === undefined
          ? null
          : { kind: node.owner.kind, id: node.owner.id, version: node.owner.version },
      input: refView(node.input),
      tool: node.tool === undefined ? null : { id: node.tool.id, version: node.tool.version },
      approvalId: node.approvalId ?? null,
      output: refView(node.output),
      error: failureView(node.error),
      startedAt: node.startedAt ?? null,
      completedAt: node.completedAt ?? null,
      attempt: node.attempt ?? 1,
    })),
    result: refView(execution.result),
    failure: failureView(execution.failure),
    cancellation:
      execution.cancellation === undefined
        ? null
        : { at: execution.cancellation.at, reason: execution.cancellation.reason },
    verification:
      execution.verification === undefined
        ? null
        : {
            result: execution.verification.result,
            verifiedAt: execution.verification.verifiedAt,
            correlationId: execution.verification.correlationId,
            nodes: execution.verification.nodes.map((n) => ({
              nodeId: n.nodeId,
              policy: n.policy,
              result: n.result,
              checks: n.checks.map((check) => ({
                code: check.code,
                result: check.result,
                evidence: refView(check.evidence),
              })),
            })),
          },
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    startedAt: execution.startedAt ?? null,
    completedAt: execution.completedAt ?? null,
  };
}
