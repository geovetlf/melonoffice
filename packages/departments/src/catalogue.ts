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
  /** The types a new organization starts with: every type that is not retired. */
  readonly types: readonly DepartmentType[];
  /** Types no longer offered, each with the type its work moved to (ADR-0047). */
  readonly retired: readonly DepartmentType[];
  /** Any known type, offered or retired, so a retired department keeps its name as history. */
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
    byId.set(
      type.id,
      Object.freeze({
        ...type,
        ...(type.retired === undefined ? {} : { retired: Object.freeze({ ...type.retired }) }),
      }),
    );
  }
  // A retired type's work must move to a type that is still offered: never to itself, to
  // nothing, or along a chain.
  for (const type of byId.values()) {
    if (type.retired === undefined) continue;
    const target = byId.get(type.retired.mergedInto);
    if (target === undefined || target.retired !== undefined) {
      throw new Error(`department type ${type.id} must merge into an offered type`);
    }
  }
  const all = [...byId.values()];
  return Object.freeze({
    types: Object.freeze(all.filter((t) => t.retired === undefined)),
    retired: Object.freeze(all.filter((t) => t.retired !== undefined)),
    find: (id: string) => byId.get(id),
  });
}

const type = (
  id: string,
  options: { readonly version?: number; readonly mergedInto?: string } = {},
): DepartmentType => ({
  id: id as DepartmentTypeId,
  nameKey: `department.${id}.name` as MessageKey,
  shortNameKey: `department.${id}.short` as MessageKey,
  version: options.version ?? 1,
  ...(options.mergedInto === undefined
    ? {}
    : { retired: { mergedInto: options.mergedInto as DepartmentTypeId } }),
});

/**
 * The six initial departments (ADR-0047, replacing D-11's seven): Consejo, Comercial,
 * Marketing, Operaciones, Finanzas and Investigación. Marketing (version 2) also covers design
 * and content; Personal is a tool inside Operaciones, not a department. Design & Video is
 * retired into Marketing and stays known only as history. GIA is not a department.
 */
export const DEFAULT_DEPARTMENT_CATALOGUE: DepartmentCatalogue = createDepartmentCatalogue([
  type('leadership'),
  type('operations'),
  type('sales'),
  type('marketing', { version: 2 }),
  type('research'),
  type('finance'),
  type('design_video', { mergedInto: 'marketing' }),
]);
