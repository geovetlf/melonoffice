import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import type { PlanConfig, PlanId } from './plans.js';
import {
  assertValidBlock,
  copyValue,
  defaultValues,
  kindOf,
  type EntitlementBlock,
  type EntitlementKey,
  type EntitlementValues,
  type Limit,
  type LimitMap,
  type LimitKey,
  type LimitMapKey,
} from './registry.js';

/**
 * A purchased or rented extra (plan §11.2). It adds to what the plan grants
 * and only counts while `addons.allowed` is on and it has not expired.
 */
export interface AddOn {
  readonly id: string;
  /** Features are switched on, limits are raised, lists are extended. */
  readonly grants: EntitlementBlock;
  readonly expiresAt: IsoTimestamp;
}

/**
 * A value set by a platform operator for one organization (ADR-0007, wired in ADR-0044). It is
 * data about that organization, never a change to its plan: the plan's values stay as they are
 * for everyone else. Always audited, so a reason is required; it may expire.
 */
export interface EntitlementOverride {
  readonly key: EntitlementKey;
  readonly value: EntitlementBlock[EntitlementKey];
  readonly reason: string;
  readonly approvedBy: UserId;
  /** From then on it no longer applies. Absent: until an operator removes it. */
  readonly expiresAt?: IsoTimestamp;
}

const MAX_REASON_LENGTH = 200;

/** Checks an override before it is stored or used: a known key, a value of its kind, a reason. */
export function checkOverride(override: EntitlementOverride): EntitlementOverride {
  const reason = typeof override.reason === 'string' ? override.reason.trim() : '';
  if (reason === '' || reason.length > MAX_REASON_LENGTH) {
    throw new Error(`override of "${String(override.key)}" needs a reason`);
  }
  assertValidBlock({ [override.key]: override.value }, 'override');
  if (override.expiresAt !== undefined && Number.isNaN(Date.parse(override.expiresAt))) {
    throw new Error(`override of "${String(override.key)}" has an invalid expiry`);
  }
  return override;
}

/** Caps a company sets for itself. They can only lower an effective limit, never raise it. */
export type CompanyLimits = { readonly [K in LimitKey]?: number };

export interface ResolveInput {
  readonly orgId: OrganizationId;
  readonly plan: PlanConfig;
  readonly addOns?: readonly AddOn[];
  readonly overrides?: readonly EntitlementOverride[];
  readonly companyLimits?: CompanyLimits;
  /** The moment of resolution, used to drop expired add-ons. */
  readonly now: IsoTimestamp;
}

/** What one organization may use right now. Only the resolver builds it. */
export interface EffectiveEntitlements {
  readonly orgId: OrganizationId;
  readonly planId: PlanId;
  readonly planVersion: number;
  readonly values: EntitlementValues;
}

function addLimits(a: Limit, b: Limit): Limit {
  return a === 'unlimited' || b === 'unlimited' ? 'unlimited' : a + b;
}

function lowerLimit(current: Limit, cap: number): Limit {
  return current === 'unlimited' ? cap : Math.min(current, cap);
}

function addLimitMaps(a: LimitMap, b: LimitMap): LimitMap {
  const byScope: Record<string, Limit> = {};
  for (const scope of new Set([...Object.keys(a.byScope), ...Object.keys(b.byScope)])) {
    byScope[scope] = addLimits(a.byScope[scope] ?? a.default, b.byScope[scope] ?? b.default);
  }
  return { default: addLimits(a.default, b.default), byScope };
}

function grant(values: Record<string, unknown>, key: EntitlementKey, extra: unknown): void {
  const current = values[key];
  switch (kindOf(key)) {
    case 'feature':
      values[key] = current === true || extra === true;
      break;
    case 'limit':
      values[key] = addLimits(current as Limit, extra as Limit);
      break;
    case 'limitMap':
      values[key] = addLimitMaps(current as LimitMap, extra as LimitMap);
      break;
    case 'list':
      values[key] = [...new Set([...(current as string[]), ...(extra as string[])])];
      break;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Resolves an organization's effective entitlements, in this order:
 * deny defaults → plan → add-ons → audited overrides → company caps.
 * A plan that is not active grants nothing. Invalid input throws.
 */
export function resolveEntitlements(input: ResolveInput): EffectiveEntitlements {
  const { plan, now } = input;
  const values: Record<string, unknown> = { ...defaultValues() };

  if (plan.status === 'active') {
    assertValidBlock(plan.entitlements, `plan ${plan.id}@${String(plan.version)}`);
    for (const [key, value] of Object.entries(plan.entitlements)) values[key] = copyValue(value);
  }

  if (values['addons.allowed'] === true) {
    for (const addOn of input.addOns ?? []) {
      assertValidBlock(addOn.grants, `add-on ${addOn.id}`);
      // An expired add-on, or an unreadable date, grants nothing.
      if (!(Date.parse(addOn.expiresAt) > Date.parse(now))) continue;
      for (const [key, extra] of Object.entries(addOn.grants)) {
        grant(values, key as EntitlementKey, extra);
      }
    }
  }

  for (const override of input.overrides ?? []) {
    checkOverride(override);
    // An expired override, or an unreadable date, changes nothing.
    if (override.expiresAt !== undefined && !(Date.parse(override.expiresAt) > Date.parse(now))) {
      continue;
    }
    values[override.key] = copyValue(override.value);
  }

  const companyLimits: Readonly<Record<string, number | undefined>> = input.companyLimits ?? {};
  for (const [key, cap] of Object.entries(companyLimits)) {
    if (cap === undefined) continue;
    assertValidBlock({ [key]: cap }, 'company limits');
    if (kindOf(key as EntitlementKey) !== 'limit') {
      throw new Error(`company limits: "${key}" is not a limit`);
    }
    values[key] = lowerLimit(values[key] as Limit, cap);
  }

  return deepFreeze({
    orgId: input.orgId,
    planId: plan.id,
    planVersion: plan.version,
    values: values as EntitlementValues,
  });
}

/** The cap that applies to one scope of a per-scope limit. */
export function limitForScope(
  entitlements: EffectiveEntitlements,
  key: LimitMapKey,
  scope: string,
): Limit {
  const map = entitlements.values[key];
  return map.byScope[scope] ?? map.default;
}
