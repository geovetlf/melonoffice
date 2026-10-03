/**
 * The typed entitlement registry (plan §11A.3). It declares every key, its
 * kind and its default. Every default denies: a feature is off, a limit is
 * zero, a list is empty. A value that has not been decided (for example the
 * Emprendedor commercial values, D-12) is simply not set, so it resolves to
 * that default.
 */

/** A numeric cap. `'unlimited'` must be stated explicitly; an unset limit is zero. */
export type Limit = number | 'unlimited';

/** A cap per scope (for example per department type), with a fallback for other scopes. */
export interface LimitMap {
  readonly default: Limit;
  readonly byScope: Readonly<Record<string, Limit>>;
}

interface KindValues {
  feature: boolean;
  limit: Limit;
  limitMap: LimitMap;
  list: readonly string[];
}

export type EntitlementKind = keyof KindValues;

const feature = { kind: 'feature' } as const;
const limit = { kind: 'limit' } as const;
const limitMap = { kind: 'limitMap' } as const;
const list = { kind: 'list' } as const;

export const ENTITLEMENT_REGISTRY = {
  // Departments
  'departments.allowed': list,
  'departments.customMax': limit,
  // Specialists. How many a company has is its own choice (D-12a); these are optional ceilings.
  'agents.max': limit,
  'agents.perDepartmentMax': limitMap,
  'agents.perRoleMax': limitMap,
  'agents.concurrentRunsMax': limit,
  'agents.dedicatedCapacityAllowed': feature,
  // Roles and skills
  'roles.allowed': list,
  'skills.allowed': list,
  'skills.denied': list,
  // Users
  'users.max': limit,
  // Credits
  'credits.monthlyIncluded': limit,
  'credits.maxBalance': limit,
  // Whether included credits left at renewal carry over, and how many (ADR-0127). Unset: none do.
  'credits.rollover': feature,
  'credits.rolloverMax': limit,
  'credits.dailyCap': limit,
  'credits.packsPurchasable': feature,
  // GIA
  'gia.text': feature,
  'gia.voice': feature,
  'gia.voiceMinutesMonthly': limit,
  'gia.modelTiers': list,
  // Storage
  'storage.bytesMax': limit,
  'documents.maxFileBytes': limit,
  // Integrations
  'integrations.categoriesAllowed': list,
  'integrations.connectionsMax': limit,
  // Automations
  'automations.enabled': feature,
  'automations.max': limit,
  'automations.runsMonthly': limit,
  // Add-ons
  'addons.allowed': feature,
  'addons.catalog': list,
  // Admin and security. Declared so the check sites exist; no feature is built for them.
  'security.sso': feature,
  'security.auditExport': feature,
  'admin.teams': feature,
} as const satisfies Readonly<Record<string, { readonly kind: EntitlementKind }>>;

type Registry = typeof ENTITLEMENT_REGISTRY;

export type EntitlementKey = keyof Registry;
export type EntitlementKindOf<K extends EntitlementKey> = Registry[K]['kind'];
export type EntitlementValue<K extends EntitlementKey> = KindValues[EntitlementKindOf<K>];

type KeysOfKind<Kind extends EntitlementKind> = {
  [K in EntitlementKey]: EntitlementKindOf<K> extends Kind ? K : never;
}[EntitlementKey];

export type FeatureKey = KeysOfKind<'feature'>;
export type LimitKey = KeysOfKind<'limit'>;
export type LimitMapKey = KeysOfKind<'limitMap'>;
export type ListKey = KeysOfKind<'list'>;

/** A full set of values, one per key. */
export type EntitlementValues = { readonly [K in EntitlementKey]: EntitlementValue<K> };

/** Values set by a plan, an override or a company. Unset keys fall back to the defaults. */
export type EntitlementBlock = { readonly [K in EntitlementKey]?: EntitlementValue<K> };

const DEFAULT_BY_KIND: KindValues = {
  feature: false,
  limit: 0,
  limitMap: { default: 0, byScope: {} },
  list: [],
};

export const ENTITLEMENT_KEYS = Object.freeze(
  Object.keys(ENTITLEMENT_REGISTRY),
) as readonly EntitlementKey[];

export function isEntitlementKey(key: string): key is EntitlementKey {
  return Object.hasOwn(ENTITLEMENT_REGISTRY, key);
}

export function kindOf(key: EntitlementKey): EntitlementKind {
  return ENTITLEMENT_REGISTRY[key].kind;
}

/** A copy of an entitlement value that shares no arrays or objects with the original. */
export function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return [...(value as unknown[])] as T;
  if (typeof value === 'object' && value !== null) {
    const map = value as unknown as LimitMap;
    return { default: map.default, byScope: { ...map.byScope } } as T;
  }
  return value;
}

/** The deny-everything baseline every resolution starts from. */
export function defaultValues(): EntitlementValues {
  const values: Record<string, unknown> = {};
  for (const key of ENTITLEMENT_KEYS) values[key] = copyValue(DEFAULT_BY_KIND[kindOf(key)]);
  return values as EntitlementValues;
}

function isLimit(value: unknown): value is Limit {
  return (
    value === 'unlimited' || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

/** Checks that a value has the shape its key declares. */
export function isValidValue(key: EntitlementKey, value: unknown): boolean {
  switch (kindOf(key)) {
    case 'feature':
      return typeof value === 'boolean';
    case 'limit':
      return isLimit(value);
    case 'limitMap': {
      if (typeof value !== 'object' || value === null) return false;
      const map = value as Partial<LimitMap>;
      return (
        isLimit(map.default) &&
        typeof map.byScope === 'object' &&
        map.byScope !== null &&
        Object.values(map.byScope).every(isLimit)
      );
    }
    case 'list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

/** Rejects unknown keys and values of the wrong shape. Throws on the first problem. */
export function assertValidBlock(block: Readonly<Record<string, unknown>>, source: string): void {
  for (const [key, value] of Object.entries(block)) {
    if (!isEntitlementKey(key)) throw new Error(`${source}: unknown entitlement key "${key}"`);
    if (!isValidValue(key, value)) {
      throw new Error(`${source}: invalid value for "${key}" (expected ${kindOf(key)})`);
    }
  }
}
