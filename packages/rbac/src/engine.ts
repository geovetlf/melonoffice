import type { OrganizationId } from '@melonoffice/domain';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { isPermission, PERMISSIONS, type Permission } from './permissions.js';
import { ROLES, type RoleCatalogue } from './roles.js';

export type RbacDenyReason =
  | 'unknown_permission'
  | 'unresolved_tenant'
  | 'inactive_membership'
  | 'unknown_role'
  | 'cross_tenant'
  | 'permission_denied';

export type RbacDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: RbacDenyReason };

/** What an action touches. When given, it must belong to the tenant's organization. */
export interface ResourceRef {
  readonly organizationId: OrganizationId;
}

/**
 * The one question RBAC answers: may this tenant do this in its organization? The API, MelonMotor,
 * GIA, workflows and jobs all ask through this interface. It knows nothing about plans: whether
 * the plan allows the action is entitlements' question (ADR-0013), asked separately.
 */
export interface AuthorizationService {
  authorize(tenant: TenantContext, permission: string, resource?: ResourceRef): RbacDecision;
  /**
   * The permissions this tenant holds, e.g. for entitlements' `Principal.permissions`. Empty
   * whenever `authorize` would deny everything.
   */
  permissionsOf(tenant: TenantContext): ReadonlySet<Permission>;
}

const deny = (reason: RbacDenyReason): RbacDecision => Object.freeze({ allowed: false, reason });
const ALLOW: RbacDecision = Object.freeze({ allowed: true });

/**
 * Builds the authorization service from a role catalogue (the built-in one by default). It is
 * deterministic and denies by default: an unknown permission, a context that did not come from
 * `resolveTenant()`, an inactive membership, an unknown role, another organization's resource or
 * a permission the role does not list are all denied. The actor is never consulted, so GIA acting
 * for a user gets exactly that user's permissions and has no path around them.
 */
export function createAuthorizationService(roles: RoleCatalogue = ROLES): AuthorizationService {
  // Checked once: a role may only grant permissions that exist in the catalogue.
  const byRole = new Map<string, ReadonlySet<Permission>>();
  for (const [role, permissions] of Object.entries(roles)) {
    for (const permission of permissions) {
      if (!Object.hasOwn(PERMISSIONS, permission)) {
        throw new Error(`role ${role} grants unknown permission ${permission}`);
      }
    }
    byRole.set(role, new Set(permissions));
  }

  function granted(tenant: TenantContext): ReadonlySet<Permission> | RbacDenyReason {
    if (!isResolvedTenant(tenant)) return 'unresolved_tenant';
    if (tenant.membershipStatus !== 'active') return 'inactive_membership';
    return byRole.get(tenant.role) ?? 'unknown_role';
  }

  return Object.freeze({
    authorize(tenant: TenantContext, permission: string, resource?: ResourceRef): RbacDecision {
      if (!isPermission(permission)) return deny('unknown_permission');
      const permissions = granted(tenant);
      if (typeof permissions === 'string') return deny(permissions);
      if (resource !== undefined && resource.organizationId !== tenant.organizationId) {
        return deny('cross_tenant');
      }
      return permissions.has(permission) ? ALLOW : deny('permission_denied');
    },
    // A copy: sets cannot be frozen, and a caller must never be able to change what a role grants.
    permissionsOf(tenant: TenantContext): ReadonlySet<Permission> {
      const permissions = granted(tenant);
      return new Set(typeof permissions === 'string' ? [] : permissions);
    },
  });
}
