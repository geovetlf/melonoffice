import type {
  DepartmentId,
  DepartmentTypeId,
  IsoTimestamp,
  MessageKey,
  OrganizationId,
} from './ids.js';

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

/**
 * Where a department is in its life (ADR-0025). Only `active` departments take new work or new
 * specialists; `paused` keeps its specialists but none of them is eligible; `archived` is
 * history. A department with history is never deleted.
 */
export type DepartmentStatus = 'active' | 'paused' | 'archived';

/** Where a company's department comes from: a catalogue type, or the company's own custom department. */
export type DepartmentOrigin =
  | { readonly kind: 'catalog'; readonly typeId: DepartmentTypeId; readonly typeVersion: number }
  | { readonly kind: 'custom'; readonly name: string };

/**
 * A functional area of one company (ADR-0025). A catalogue department is named by its type's
 * message keys; a custom one by its own name. `purpose` and `description` are the company's own
 * words and are absent until the company writes them.
 */
export interface Department {
  readonly id: DepartmentId;
  readonly organizationId: OrganizationId;
  readonly origin: DepartmentOrigin;
  readonly status: DepartmentStatus;
  readonly purpose?: string;
  readonly description?: string;
  /** Increases with every change; a write expecting an older revision is refused. */
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
