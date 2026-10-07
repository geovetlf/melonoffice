import type { ToolDefinition, ToolSchema, ToolVersion } from '@melonoffice/domain';
import { isPlanWritable, type ToolRegistry } from '@melonoffice/tools';
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

/** One top-level field of a tool's input or output, as the workflow editor fills or reads it. */
export interface ToolStepField {
  readonly name: string;
  readonly type: ToolSchema['type'];
  readonly required: boolean;
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

const fieldsOf = (schema: ToolSchema): readonly ToolStepField[] =>
  schema.type !== 'object'
    ? []
    : Object.entries(schema.properties).map(([name, field]) => ({
        name,
        type: field.type,
        required: schema.required?.includes(name) ?? false,
        ...(field.type === 'string'
          ? {
              maxLength: field.maxLength,
              ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
              ...(field.enum === undefined ? {} : { enum: [...field.enum] }),
              // The record it names, for a picker (ADR-0184).
              ...(field.ref === undefined ? {} : { ref: field.ref }),
            }
          : {}),
        ...(field.type === 'number' || field.type === 'integer'
          ? {
              ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
              ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
            }
          : {}),
      }));

/**
 * What a workflow's tool step can do with a version (ADR-0165): the top-level fields of its input
 * and output, only for a version a plan may run as a tool step (it reads, inside MelonOffice,
 * with no credential: ADR-0159; or it is a write built for plans: ADR-0184). Any other version
 * shows none.
 */
function stepOf(v: ToolVersion) {
  const readOnly = !v.mutating && v.provider.kind === 'internal' && v.credentials.length === 0;
  // A write built for plans (ADR-0184) is a step too, which a person approves every time.
  return readOnly || isPlanWritable(v)
    ? { input: fieldsOf(v.inputSchema), output: fieldsOf(v.outputSchema) }
    : null;
}

/**
 * The public view: what each version is and the policy it runs under. Required permissions,
 * credential references and the provider are execution detail and are not shown; the schemas
 * only as the top-level fields a workflow's read-only tool step uses (ADR-0165).
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
      step: stepOf(v),
    })),
  };
}
