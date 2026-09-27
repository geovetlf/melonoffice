import type { IsoTimestamp, OrganizationId, PlanRef } from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { findPlan, PLAN_CATALOG, type PlanConfig, type PlanId } from './plans.js';
import {
  ENTITLEMENT_KEYS,
  isEntitlementKey,
  kindOf,
  type EntitlementValues,
  type FeatureKey,
  type Limit,
  type LimitKey,
} from './registry.js';
import { resolveEntitlements } from './resolve.js';

/**
 * Why an organization has no entitlements right now. Each one denies everything; none is ever
 * replaced by a default plan.
 *
 * - `unresolved_tenant`: the context did not come from `resolveTenant()`.
 * - `organization_inactive`: the organization is missing or not active.
 * - `plan_missing`: the organization has no plan reference.
 * - `plan_unknown`: its plan reference is not in the catalogue.
 * - `plan_inactive`: the plan exists but is not active (for example Empresa, `prepared`).
 */
export type EntitlementsUnavailableReason =
  'unresolved_tenant' | 'organization_inactive' | 'plan_missing' | 'plan_unknown' | 'plan_inactive';

/** What an organization is entitled to: a state, not usage. Nothing here counts consumption. */
export type OrganizationEntitlements =
  | {
      readonly status: 'active';
      readonly organizationId: OrganizationId;
      readonly plan: PlanRef;
      readonly values: EntitlementValues;
    }
  | { readonly status: 'unavailable'; readonly reason: EntitlementsUnavailableReason };

/**
 * Whether a capability (a feature key in the entitlement registry, ADR-0013) is on. `not_entitled`
 * means the plan does not include it; `unknown_capability` means no such capability exists.
 */
export type CapabilityDecision =
  | { readonly enabled: true; readonly capability: FeatureKey }
  | {
      readonly enabled: false;
      readonly reason: EntitlementsUnavailableReason | 'unknown_capability' | 'not_entitled';
    };

/** The value of a limit (a limit key in the registry). An unset limit is 0, never unlimited. */
export type LimitResult =
  | { readonly available: true; readonly limit: LimitKey; readonly value: Limit }
  | { readonly available: false; readonly reason: EntitlementsUnavailableReason | 'unknown_limit' };

/**
 * Answers what an organization's plan allows (ADR-0021). It is separate from RBAC: a permission
 * says what a member may do, a capability says what the organization's plan includes, and a
 * caller that needs both asks both. It knows nothing about HTTP.
 *
 * The organization always comes from a resolved `TenantContext`, never from an id the caller
 * passes, and the answer is the same whoever acts: GIA gets exactly what its user's organization
 * has, with no entitlements of its own.
 */
export interface EntitlementService {
  entitlementsOf(tenant: TenantContext): Promise<OrganizationEntitlements>;
  hasCapability(tenant: TenantContext, capability: string): Promise<CapabilityDecision>;
  getLimit(tenant: TenantContext, limit: string): Promise<LimitResult>;
}

export interface EntitlementServiceOptions {
  /** Where the organization and its plan reference are read. Only `findOrganization` is used. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  /** The plan catalogue. Defaults to the one in code; tests may pass their own. */
  readonly catalog?: readonly PlanConfig[];
  readonly now?: () => Date;
}

export const CAPABILITY_KEYS = Object.freeze(
  ENTITLEMENT_KEYS.filter((key) => kindOf(key) === 'feature'),
) as readonly FeatureKey[];

export const LIMIT_KEYS = Object.freeze(
  ENTITLEMENT_KEYS.filter((key) => kindOf(key) === 'limit'),
) as readonly LimitKey[];

const isCapability = (value: string): value is FeatureKey =>
  isEntitlementKey(value) && kindOf(value) === 'feature';

const isLimitKey = (value: string): value is LimitKey =>
  isEntitlementKey(value) && kindOf(value) === 'limit';

const unavailable = (reason: EntitlementsUnavailableReason): OrganizationEntitlements =>
  Object.freeze({ status: 'unavailable', reason });

export function createEntitlementService({
  organizations,
  catalog = PLAN_CATALOG,
  now = () => new Date(),
}: EntitlementServiceOptions): EntitlementService {
  async function entitlementsOf(tenant: TenantContext): Promise<OrganizationEntitlements> {
    if (!isResolvedTenant(tenant)) return unavailable('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      return unavailable('organization_inactive');
    }
    if (organization.plan === undefined) return unavailable('plan_missing');
    const plan = findPlan(catalog, organization.plan.id as PlanId, organization.plan.version);
    if (plan === undefined) return unavailable('plan_unknown');
    if (plan.status !== 'active') return unavailable('plan_inactive');
    const resolved = resolveEntitlements({
      orgId: organization.id,
      plan,
      now: now().toISOString() as IsoTimestamp,
    });
    return Object.freeze({
      status: 'active',
      organizationId: organization.id,
      plan: Object.freeze({ id: plan.id, version: plan.version }),
      values: resolved.values,
    });
  }

  return {
    entitlementsOf,

    async hasCapability(tenant, capability) {
      if (!isCapability(capability)) return { enabled: false, reason: 'unknown_capability' };
      const entitlements = await entitlementsOf(tenant);
      if (entitlements.status !== 'active') return { enabled: false, reason: entitlements.reason };
      return entitlements.values[capability]
        ? { enabled: true, capability }
        : { enabled: false, reason: 'not_entitled' };
    },

    async getLimit(tenant, limit) {
      if (!isLimitKey(limit)) return { available: false, reason: 'unknown_limit' };
      const entitlements = await entitlementsOf(tenant);
      if (entitlements.status !== 'active') {
        return { available: false, reason: entitlements.reason };
      }
      return { available: true, limit, value: entitlements.values[limit] };
    },
  };
}
