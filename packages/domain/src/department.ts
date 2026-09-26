import type { DepartmentId, DepartmentTypeId, MessageKey, OrganizationId } from './ids.js';

/**
 * A department type from the catalogue. The catalogue is data: the initial
 * seven departments (D-11) are entries in it, and new types can be added
 * without changing this model.
 */
export interface DepartmentType {
  readonly id: DepartmentTypeId;
  readonly nameKey: MessageKey;
  /** Optional short visual name, e.g. "Dirección" for "Consejo y Dirección". */
  readonly shortNameKey?: MessageKey;
  readonly version: number;
}

export type DepartmentState = 'active' | 'inactive';

/** Where a company's department comes from: a catalogue type, or the company's own custom department. */
export type DepartmentOrigin =
  | { readonly kind: 'catalog'; readonly typeId: DepartmentTypeId }
  | { readonly kind: 'custom'; readonly name: string };

/** A functional area of one company. */
export interface Department {
  readonly id: DepartmentId;
  readonly organizationId: OrganizationId;
  readonly origin: DepartmentOrigin;
  readonly state: DepartmentState;
}
