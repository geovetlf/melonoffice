import type { Permission } from './permissions.js';

/** A role is a named set of permissions and nothing more. */
export type RoleCatalogue = Readonly<Record<string, readonly Permission[]>>;

/**
 * The roles MelonOffice has today and exactly what each allows (ADR-0019). `owner` is listed
 * permission by permission: there is no "allow everything" role. Roles such as admin, manager or
 * member are added here, as data, when something needs them.
 */
export const ROLES = {
  owner: [
    'organization.read',
    'entitlement.read',
    'billing.read',
    'execution.read',
    'department.read',
    'specialist.read',
    'tool.read',
    'tool.execute',
    'approval.read',
    'approval.approve',
    'ai.generate',
    'credits.read',
    'plan.read',
    'plan.create',
    'workflow.read',
    'workflow.manage',
  ],
} as const satisfies RoleCatalogue;

export type Role = keyof typeof ROLES;
