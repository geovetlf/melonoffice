import type { AgentState } from '../departments.js';
import type { Floor } from './layout.js';

/**
 * MelonMotor's circuits (Home V4): the lines of light that join the office's core to GIA and to
 * every department, drawn over the building. Geometry and activity only; the drawing is in
 * `OfficeBuilding`.
 *
 * The drawing's units: a floor is 100 tall and the building is `BUILDING_WIDTH` wide per floor
 * (three rooms, 3 : 2 : 3, each side room 16:10). A circuit leaves the core in the atrium, runs
 * along the floor to the gap between the columns, climbs or drops in that gap to the room's
 * floor, then runs along the back wall into the room's big screen: the work reaches the screen.
 */

/** The building's width in drawing units: a side room is 16:10 and 3/8 of the width. */
export const BUILDING_WIDTH = (8 / 3) * 160;

/** The big screen's rectangle in a side room, as fractions (the art's `SIDE_SCREEN`). */
const SCREEN = { x: 0.355, y: 0.17, w: 0.29, h: 0.25 };

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The core: MelonMotor's column in the atrium, on the second floor. */
export function corePoint(): Point {
  return { x: BUILDING_WIDTH / 2, y: 100 + 55 };
}

/** GIA at her platform in headquarters, on the top floor. */
export function giaPoint(): Point {
  return { x: BUILDING_WIDTH / 2 + 9, y: 62 };
}

/** The route from the core to a side room's screen, as the corners of the line. */
export function routeTo(floor: number, side: 'left' | 'right'): readonly Point[] {
  const core = corePoint();
  const column = (BUILDING_WIDTH * 3) / 8;
  const gap = side === 'left' ? column : BUILDING_WIDTH - column;
  const y = floor * 100 + (SCREEN.y + SCREEN.h / 2) * 100;
  const screen =
    side === 'left' ? column * (SCREEN.x + SCREEN.w) : BUILDING_WIDTH - column + column * SCREEN.x;
  return [core, { x: gap, y: core.y }, { x: gap, y }, { x: screen, y }];
}

/** The route from the core up to GIA. */
export function routeToGia(): readonly Point[] {
  const core = corePoint();
  const gia = giaPoint();
  return [core, { x: core.x, y: 100 - 8 }, { x: gia.x, y: 100 - 8 - 9 }, gia];
}

/** An SVG path through the points, its corners cut at 45° like a circuit board's traces. */
export function tracePath(points: readonly Point[], chamfer = 5): string {
  if (points.length === 0) return '';
  const parts = [`M${round(points[0]?.x)},${round(points[0]?.y)}`];
  for (let i = 1; i < points.length; i += 1) {
    const here = points[i];
    const before = points[i - 1];
    const after = points[i + 1];
    if (here === undefined || before === undefined) continue;
    if (after === undefined) {
      parts.push(`L${round(here.x)},${round(here.y)}`);
      continue;
    }
    const cut = Math.min(chamfer, distance(before, here) / 2, distance(here, after) / 2);
    const into = towards(here, before, cut);
    const out = towards(here, after, cut);
    parts.push(`L${round(into.x)},${round(into.y)}`, `L${round(out.x)},${round(out.y)}`);
  }
  return parts.join(' ');
}

/** The length of a route, for timing the pulses along it. */
export function routeLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a !== undefined && b !== undefined) total += distance(a, b);
  }
  return total;
}

/**
 * How much a department's circuit carries, from its agents' real states:
 * - `attention`: something needs the person (an approval, a failure);
 * - `busy`: at least one agent is working;
 * - `ready`: agents are there, none working;
 * - `off`: nobody active (no agents, or all paused or offline).
 */
export type CircuitLevel = 'attention' | 'busy' | 'ready' | 'off';

export function circuitLevel(states: ReadonlyMap<AgentState, number>): CircuitLevel {
  const count = (state: AgentState) => states.get(state) ?? 0;
  if (count('attention') > 0) return 'attention';
  if (count('working') > 0 || count('processing') > 0) return 'busy';
  if (count('available') > 0 || count('waiting') > 0) return 'ready';
  return 'off';
}

/** How many pulses a busy circuit carries at once: one per working agent, three at most. */
export function pulsesFor(states: ReadonlyMap<AgentState, number>): number {
  const working = (states.get('working') ?? 0) + (states.get('processing') ?? 0);
  return Math.max(0, Math.min(3, working));
}

/** The side rooms that hold a department, with their floor and side. */
export function departmentRooms(floors: readonly Floor[]): readonly {
  readonly floor: number;
  readonly side: 'left' | 'right';
  readonly id: string;
  readonly type: string;
}[] {
  const rooms: { floor: number; side: 'left' | 'right'; id: string; type: string }[] = [];
  floors.forEach((level, floor) => {
    for (const side of ['left', 'right'] as const) {
      const room = level[side];
      if (room.kind !== 'department') continue;
      rooms.push({
        floor,
        side,
        id: room.department.id,
        type: room.department.typeId ?? room.department.id,
      });
    }
  });
  return rooms;
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function towards(from: Point, to: Point, by: number): Point {
  const d = distance(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / d) * by, y: from.y + ((to.y - from.y) / d) * by };
}

const round = (n: number | undefined) => Math.round((n ?? 0) * 10) / 10;
