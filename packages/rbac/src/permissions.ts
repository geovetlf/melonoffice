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
