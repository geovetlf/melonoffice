import type { DepartmentView } from '../officeClient.js';

/**
 * How the Home's office is laid out: rows of three rooms, a department either side of a centre
 * column. The centre holds Consejo's board room on top, GIA at the heart of the office below it,
 * MelonMotor under GIA and a lounge further down. Departments fill the side rooms row by row in
 * the Home's reference order (Comercial and Operaciones, Marketing and Finanzas, then
 * Investigación), by catalogue type; any other department follows in the order it is given (the
 * business profile's order, ADR-0048). A side room with no department left is a meeting room. The building grows a floor for every two more departments, so a custom
 * department always gets a room and no department is assumed to exist.
 */

export type SideRoom =
  | { readonly kind: 'department'; readonly department: DepartmentView }
  | { readonly kind: 'meeting' };

export type CentreRoom = 'headquarters' | 'gia' | 'motor' | 'lounge';

export interface Floor {
  readonly left: SideRoom;
  readonly centre: CentreRoom;
  readonly right: SideRoom;
}

/** An office never has fewer rows than this: Consejo, GIA and MelonMotor. */
export const MIN_FLOORS = 3;

const CENTRE: readonly CentreRoom[] = ['headquarters', 'gia', 'motor'];

/** Where the catalogue's departments sit, by type: left then right, row by row. */
const PLACES: readonly string[] = ['sales', 'operations', 'marketing', 'finance', 'research'];

const place = (department: DepartmentView) => {
  const at = PLACES.indexOf(department.typeId ?? '');
  return at === -1 ? PLACES.length : at;
};

/**
 * Departments in the order the building reads, left then right, row by row. Any other department
 * follows in the order given (the business profile's, ADR-0048). The sidebar lists them the same
 * way, so the menu reads like the office.
 */
export const inBuildingOrder = (given: readonly DepartmentView[]): readonly DepartmentView[] =>
  [...given].sort((a, b) => place(a) - place(b));

export function buildingFloors(given: readonly DepartmentView[]): readonly Floor[] {
  const departments = inBuildingOrder(given);
  const count = Math.max(MIN_FLOORS, Math.ceil(departments.length / 2));
  const room = (i: number): SideRoom => {
    const department = departments[i];
    return department === undefined ? { kind: 'meeting' } : { kind: 'department', department };
  };
  return Array.from({ length: count }, (_, floor) => ({
    left: room(floor * 2),
    centre: CENTRE[floor] ?? 'lounge',
    right: room(floor * 2 + 1),
  }));
}
