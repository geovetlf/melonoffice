import type {
  BusinessType,
  BusinessTypeId,
  DepartmentTypeId,
  MessageKey,
} from '@melonoffice/domain';

const TYPE_ID = /^[a-z][a-z0-9_]{0,63}$/;

export const isBusinessTypeId = (value: unknown): value is BusinessTypeId =>
  typeof value === 'string' && TYPE_ID.test(value);

/**
 * The kinds of business MelonOffice knows (ADR-0048). It is data: a new kind is a new entry. Each
 * suggests the order its departments are shown in; no department or capability is ever removed.
 */
export interface BusinessTypeCatalogue {
  readonly types: readonly BusinessType[];
  find(id: string): BusinessType | undefined;
}

export function createBusinessTypeCatalogue(types: readonly BusinessType[]): BusinessTypeCatalogue {
  const byId = new Map<string, BusinessType>();
  for (const type of types) {
    if (!isBusinessTypeId(type.id)) throw new Error(`invalid business type id ${type.id}`);
    if (byId.has(type.id)) throw new Error(`duplicate business type ${type.id}`);
    if (new Set(type.departmentPriority).size !== type.departmentPriority.length) {
      throw new Error(`repeated department in business type ${type.id}`);
    }
    byId.set(
      type.id,
      Object.freeze({ ...type, departmentPriority: Object.freeze([...type.departmentPriority]) }),
    );
  }
  return Object.freeze({
    types: Object.freeze([...byId.values()]),
    find: (id: string) => byId.get(id),
  });
}

const order = (...ids: string[]) => ids as DepartmentTypeId[];

/**
 * The general order, for every kind of business without its own: Comercial first, as in the
 * Master Functional Map's phases.
 */
const GENERAL = order('sales', 'marketing', 'operations', 'finance', 'leadership', 'research');

const type = (
  id: string,
  departmentPriority: readonly DepartmentTypeId[] = GENERAL,
): BusinessType => ({
  id: id as BusinessTypeId,
  nameKey: `business.type.${id}` as MessageKey,
  departmentPriority,
});

/**
 * The initial kinds of business. The three with their own order are the Master Functional Map's
 * examples (restaurant, independent professional, ecommerce); the others use the general order
 * until Geovet decides theirs.
 */
export const DEFAULT_BUSINESS_TYPE_CATALOGUE: BusinessTypeCatalogue = createBusinessTypeCatalogue([
  type(
    'restaurant',
    order('sales', 'operations', 'marketing', 'finance', 'leadership', 'research'),
  ),
  type('store'),
  type('ecommerce', order('sales', 'marketing', 'operations', 'finance', 'research', 'leadership')),
  type(
    'professional_services',
    order('sales', 'marketing', 'finance', 'leadership', 'research', 'operations'),
  ),
  type('agency'),
  type('consulting'),
  type('beauty_salon'),
  type('workshop'),
  type('distributor'),
  type('other'),
]);
