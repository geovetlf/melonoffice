import type { Workflow, WorkflowVersion } from '@melonoffice/domain';
import { isWorkflowError, type WorkflowService } from '@melonoffice/workflows';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Workflow routes (ADR-0028). Read only: workflows are created, versioned and instantiated on
 * the server. A workflow runs nothing; instantiating one only proposes a plan.
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
    approvalRequired: s.approvalRequired ?? false,
  })),
  createdAt: v.createdAt,
});
