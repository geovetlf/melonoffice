/**
 * Every permission MelonOffice knows, in one place (ADR-0019). Ids are `resource.action` and
 * never change once used; a permission is added here only when something checks it.
 */
export const PERMISSIONS = {
  'organization.read': {
    resource: 'organization',
    action: 'read',
    description: 'See the organization and your own membership in it.',
  },
  'entitlement.read': {
    resource: 'entitlement',
    action: 'read',
    description: "See the organization's plan, capabilities and limits (ADR-0021).",
  },
  'billing.read': {
    resource: 'billing',
    action: 'read',
    description: "See the organization's subscription: its plan and status (ADR-0022).",
  },
  'execution.read': {
    resource: 'execution',
    action: 'read',
    description: "See one of the organization's executions: status, graph and versions (ADR-0024).",
  },
  'department.read': {
    resource: 'department',
    action: 'read',
    description: "See the organization's departments and their status (ADR-0025).",
  },
  'specialist.read': {
    resource: 'specialist',
    action: 'read',
    description:
      "See the organization's specialists: role, department, status and version (ADR-0025).",
  },
  'tool.read': {
    resource: 'tool',
    action: 'read',
    description:
      'See the tools the product offers: name, version, risk and approval policy (ADR-0026).',
  },
  'tool.execute': {
    resource: 'tool',
    action: 'execute',
    description:
      'Let an execution run a tool for you. Checked by the tool gate, never by a client route (ADR-0026).',
  },
  'approval.read': {
    resource: 'approval',
    action: 'read',
    description: "See the organization's tool approvals and their status (ADR-0026).",
  },
  'approval.approve': {
    resource: 'approval',
    action: 'approve',
    description:
      'Approve or reject a pending tool approval, directly and never through GIA (ADR-0026).',
  },
  'ai.generate': {
    resource: 'ai',
    action: 'generate',
    description:
      'Let an execution call an AI model for you. Checked by the AI Gateway, never by a client route (ADR-0027).',
  },
} as const satisfies Record<string, PermissionDefinition>;

export interface PermissionDefinition {
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}

export type Permission = keyof typeof PERMISSIONS;

/** Whether a value is a permission in the catalogue. Anything else is denied, never guessed. */
export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && Object.hasOwn(PERMISSIONS, value);
