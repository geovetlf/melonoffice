import type { Brand, PlanRef } from '@melonoffice/domain';
import { assertValidBlock, type EntitlementBlock } from './registry.js';

export type PlanId = Brand<string, 'PlanId'>;

/**
 * A versioned commercial package (ADR-0007). A subscription pins a version,
 * so editing a plan never changes existing customers silently: a change is a
 * new entry with a higher version.
 */
export interface PlanConfig {
  readonly id: PlanId;
  readonly version: number;
  /** `active` plans can be used; `prepared` plans exist only as configuration. */
  readonly status: 'active' | 'prepared';
  readonly visibility: 'public' | 'hidden';
  readonly purchasable: boolean;
  /** Only the values that were decided. Everything else resolves to the deny default. */
  readonly entitlements: EntitlementBlock;
}

/**
 * Emprendedor, the only active plan at launch.
 *
 * Decided: owner only (D-22), so `users.max` is 1.
 * Pending (D-12): every commercial value (credits, storage, GIA voice, packs,
 * add-ons, price, departments, roles and specialist ceilings). They are left
 * unset on purpose and resolve to deny/zero until Geovet defines them.
 */
const entrepreneur: PlanConfig = {
  id: 'entrepreneur' as PlanId,
  version: 1,
  status: 'active',
  visibility: 'public',
  purchasable: true,
  entitlements: {
    'users.max': 1,
  },
};

/** Empresa: prepared, hidden and not purchasable. Its values are not defined yet. */
const business: PlanConfig = {
  id: 'business' as PlanId,
  version: 1,
  status: 'prepared',
  visibility: 'hidden',
  purchasable: false,
  entitlements: {},
};

/** Corporativo: prepared, hidden and not purchasable. Its values are not defined yet. */
const corporate: PlanConfig = {
  id: 'corporate' as PlanId,
  version: 1,
  status: 'prepared',
  visibility: 'hidden',
  purchasable: false,
  entitlements: {},
};

/** Checks a plan's shape and values. A prepared plan can never be public or purchasable. */
export function validatePlan(plan: PlanConfig): PlanConfig {
  const source = `plan ${plan.id}@${String(plan.version)}`;
  if (!Number.isInteger(plan.version) || plan.version < 1) {
    throw new Error(`${source}: version must be a positive integer`);
  }
  if (plan.status === 'prepared' && (plan.visibility !== 'hidden' || plan.purchasable)) {
    throw new Error(`${source}: a prepared plan must be hidden and not purchasable`);
  }
  assertValidBlock(plan.entitlements, source);
  return plan;
}

/** Builds a catalogue, rejecting invalid plans and duplicate id/version pairs. */
export function createPlanCatalog(plans: readonly PlanConfig[]): readonly PlanConfig[] {
  const seen = new Set<string>();
  for (const plan of plans) {
    validatePlan(plan);
    const ref = `${plan.id}@${String(plan.version)}`;
    if (seen.has(ref)) throw new Error(`plan ${ref} is defined twice`);
    seen.add(ref);
  }
  return Object.freeze([...plans]);
}

export const PLAN_CATALOG = createPlanCatalog([entrepreneur, business, corporate]);

/** Finds the exact plan version a subscription is pinned to. */
export function findPlan(
  catalog: readonly PlanConfig[],
  id: PlanId,
  version: number,
): PlanConfig | undefined {
  return catalog.find((plan) => plan.id === id && plan.version === version);
}

/**
 * The plan every new organization starts on (ADR-0021): Emprendedor, version 1, the only active
 * plan at launch. Billing opens every new organization's first subscription on it (ADR-0022). It
 * is never a fallback for an organization with no plan. Changing it affects new organizations only.
 */
export const DEFAULT_PLAN: PlanRef = Object.freeze({ id: 'entrepreneur', version: 1 });
