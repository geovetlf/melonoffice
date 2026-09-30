import type { DepartmentView } from '../officeClient.js';

/**
 * How the Home's building is laid out (Home V4): floors of three rooms, a department either side
 * of a centre column. The centre holds headquarters (Consejo, with GIA) on the top floor,
 * MelonMotor's atrium below it and a lounge further down. Departments fill the side rooms in the
 * order they are given (the business profile's order, ADR-0048); a side room with no department
 * left is a meeting room. The building grows a floor for every two more departments, so a custom
 * department always gets a room and no department is assumed to exist.
 */

export type SideRoom =
  | { readonly kind: 'department'; readonly department: DepartmentView }
  | { readonly kind: 'meeting' };

export type CentreRoom = 'headquarters' | 'motor' | 'lounge';

export interface Floor {
  readonly left: SideRoom;
  readonly centre: CentreRoom;
  readonly right: SideRoom;
}

/** A building never has fewer floors than this: headquarters, MelonMotor and the lounge. */
export const MIN_FLOORS = 3;

export function buildingFloors(departments: readonly DepartmentView[]): readonly Floor[] {
  const count = Math.max(MIN_FLOORS, Math.ceil(departments.length / 2));
  const room = (i: number): SideRoom => {
    const department = departments[i];
    return department === undefined ? { kind: 'meeting' } : { kind: 'department', department };
  };
  return Array.from({ length: count }, (_, floor) => ({
    left: room(floor * 2),
    centre: floor === 0 ? 'headquarters' : floor === 1 ? 'motor' : 'lounge',
    right: room(floor * 2 + 1),
  }));
}

/**
 * Where a room's middle is in the building, as fractions of its width and height: the columns
 * are 3 : 2 : 3 and every floor is as tall as the others. MelonMotor's lines are drawn from these.
 */
export function roomCentre(
  floors: number,
  floor: number,
  side: 'left' | 'centre' | 'right',
): { readonly x: number; readonly y: number } {
  const x = side === 'left' ? 1.5 / 8 : side === 'centre' ? 4 / 8 : 6.5 / 8;
  return { x, y: (floor + 0.5) / floors };
}
