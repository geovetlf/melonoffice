import type { DepartmentType, DepartmentTypeId, MessageKey } from '@melonoffice/domain';

const TYPE_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** Whether a value can be a department type id: a lowercase code such as `design_video`. */
export const isDepartmentTypeId = (value: unknown): value is DepartmentTypeId =>
  typeof value === 'string' && TYPE_ID.test(value);

/**
 * The department types a new organization starts with. It is data: adding a type (Legal, HR,
 * Support, Purchasing, Technology…) is a new entry, and no code lists the types itself.
 */
export interface DepartmentCatalogue {
  readonly types: readonly DepartmentType[];
  find(id: string): DepartmentType | undefined;
}

/** Builds a catalogue, refusing duplicate or malformed ids and versions. */
export function createDepartmentCatalogue(types: readonly DepartmentType[]): DepartmentCatalogue {
  const byId = new Map<string, DepartmentType>();
  for (const type of types) {
    if (!isDepartmentTypeId(type.id)) throw new Error(`invalid department type id ${type.id}`);
    if (!Number.isSafeInteger(type.version) || type.version < 1) {
      throw new Error(`invalid version for department type ${type.id}`);
    }
    if (byId.has(type.id)) throw new Error(`duplicate department type ${type.id}`);
    byId.set(type.id, Object.freeze({ ...type }));
  }
  const frozen = Object.freeze([...byId.values()]);
  return Object.freeze({
    types: frozen,
    find: (id: string) => byId.get(id),
  });
}

const type = (id: string): DepartmentType => ({
  id: id as DepartmentTypeId,
  nameKey: `department.${id}.name` as MessageKey,
  shortNameKey: `department.${id}.short` as MessageKey,
  version: 1,
});

/**
 * The seven initial departments (D-11, ADR-0005). Consejo y Dirección and Finanzas are two
 * separate departments. Sales is part of Comercial y Ventas. GIA is not a department.
 */
export const DEFAULT_DEPARTMENT_CATALOGUE: DepartmentCatalogue = createDepartmentCatalogue([
  type('leadership'),
  type('operations'),
  type('sales'),
  type('marketing'),
  type('design_video'),
  type('research'),
  type('finance'),
]);
