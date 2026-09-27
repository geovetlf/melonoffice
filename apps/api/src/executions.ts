import type { Execution, ExecutionFailure, ExecutionRef } from '@melonoffice/domain';
import { isExecutionError, type ExecutionService } from '@melonoffice/execution';
import { withCorrelation } from '@melonoffice/observability';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Execution routes (ADR-0024). Read only: executions are created and moved by server-side
 * code, never by a client. Tenancy picks the organization from the caller's membership, RBAC
 * checks `execution.read`, and only then is the execution read, from the resolved tenant. An
 * execution of another organization answers exactly like one that does not exist.
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
    })),
    result: refView(execution.result),
    failure: failureView(execution.failure),
    cancellation:
      execution.cancellation === undefined
        ? null
        : { at: execution.cancellation.at, reason: execution.cancellation.reason },
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    startedAt: execution.startedAt ?? null,
    completedAt: execution.completedAt ?? null,
  };
}
