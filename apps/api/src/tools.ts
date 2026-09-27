import type { ToolDefinition } from '@melonoffice/domain';
import type { ToolRegistry } from '@melonoffice/tools';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Tool routes (ADR-0026). Read only: the catalogue lives in code, and there is deliberately no
 * route that runs a tool. Tools run only through the tool gate, on the server, inside an
 * execution. Tenancy and RBAC (`tool.read`) apply like every other organization route.
 */
export function registerToolRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly tools: ToolRegistry },
): void {
  const { tools } = dependencies;

  app.get(
    '/v1/organizations/:organizationId/tools',
    withPermission('tool.read', dependencies, async (c) =>
      c.json({ tools: tools.list().map(toToolView) }),
    ),
  );

  app.get(
    '/v1/organizations/:organizationId/tools/:toolId',
    withPermission('tool.read', dependencies, async (c) => {
      const tool = tools.find(c.req.param('toolId') ?? '');
      if (tool === undefined) return c.json({ error: 'tool_not_found' }, 404);
      return c.json(toToolView(tool));
    }),
  );
}

/**
 * The public view: what each version is and the policy it runs under. Its schemas, required
 * permissions, credential references and provider are execution detail and are not shown.
 */
export function toToolView(tool: ToolDefinition) {
  return {
    id: tool.id,
    status: tool.status,
    versions: tool.versions.map((v) => ({
      version: v.version,
      nameKey: v.nameKey,
      descriptionKey: v.descriptionKey,
      category: v.category,
      action: v.action,
      mutating: v.mutating,
      riskLevel: v.riskLevel,
      approvalPolicy: v.approvalPolicy,
      environments: [...v.environments],
    })),
  };
}
