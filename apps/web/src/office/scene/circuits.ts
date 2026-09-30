import type { AgentState } from '../departments.js';
import type { Floor } from './layout.js';

/**
 * MelonMotor's network: the lines of light that join GIA, MelonMotor and every department,
 * drawn over the office. Geometry and activity only; the drawing is in `OfficeBuilding`.
 *
 * The lines run in the gaps between the rooms, in pixels of the office as it is laid out. They
 * meet at the hub between GIA and MelonMotor: a trunk rises into GIA and drops into MelonMotor,
 * and a line runs from the hub along the gaps to each department's room.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The rooms as laid out: `row-column` to the room's box, in the office's pixels. */
export type Cells = ReadonlyMap<string, Rect>;

export const cellKey = (row: number, column: number) => `${row}-${column}`;

/** What the lines are drawn from: GIA's room, MelonMotor's and the columns beside them. */
export interface Network {
  readonly hub: Point;
  readonly gia: readonly Point[];
  readonly motor: readonly Point[];
  /** The route to a room at `row`, `column` (0 left, 1 centre, 2 right). */
  readonly routeTo: (row: number, column: number) => readonly Point[] | undefined;
}

export function network(cells: Cells): Network | undefined {
  const gia = cells.get(cellKey(1, 1));
  const motor = cells.get(cellKey(2, 1));
  const left = cells.get(cellKey(1, 0));
  const right = cells.get(cellKey(1, 2));
  if (gia === undefined || motor === undefined || left === undefined || right === undefined) {
    return undefined;
  }
  const cx = gia.x + gia.w / 2;
  const hub = { x: cx, y: (gia.y + gia.h + motor.y) / 2 };
  const gapLeft = (left.x + left.w + gia.x) / 2;
  const gapRight = (gia.x + gia.w + right.x) / 2;
  return {
    hub,
    gia: [hub, { x: cx, y: gia.y + gia.h - 2 }],
    motor: [hub, { x: cx, y: motor.y + 2 }],
    routeTo(row, column) {
      const room = cells.get(cellKey(row, column));
      if (room === undefined) return undefined;
      if (column === 1) {
        // Consejo, above GIA: round GIA's room by the left gap, then into the room from below.
        const above = cells.get(cellKey(row + 1, 1));
        if (above === undefined) return undefined;
        const between = (room.y + room.h + above.y) / 2;
        return [
          hub,
          { x: gapLeft, y: hub.y },
          { x: gapLeft, y: between },
          { x: cx - room.w * 0.18, y: between },
          { x: cx - room.w * 0.18, y: room.y + room.h - 3 },
        ];
      }
      const gap = column === 0 ? gapLeft : gapRight;
      const y = room.y + room.h * 0.5;
      const edge = column === 0 ? room.x + room.w - 3 : room.x + 3;
      return [hub, { x: gap, y: hub.y }, { x: gap, y }, { x: edge, y }];
    },
  };
}

/** An SVG path through the points, its corners rounded off at 45°. */
export function tracePath(points: readonly Point[], chamfer = 8): string {
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
 * How much a department's line carries, from its agents' real states:
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

/** How many pulses a busy line carries at once: one per working agent, three at most. */
export function pulsesFor(states: ReadonlyMap<AgentState, number>): number {
  const working = (states.get('working') ?? 0) + (states.get('processing') ?? 0);
  return Math.max(0, Math.min(3, working));
}

/** The rooms that hold a department, with their row and column. */
export function departmentRooms(
  floors: readonly Floor[],
  headquarters: readonly { readonly id: string; readonly typeId: string | null }[] = [],
): readonly {
  readonly row: number;
  readonly column: number;
  readonly id: string;
  readonly type: string;
}[] {
  const rooms: { row: number; column: number; id: string; type: string }[] = [];
  const board = headquarters[0];
  if (board !== undefined)
    rooms.push({ row: 0, column: 1, id: board.id, type: board.typeId ?? board.id });
  floors.forEach((level, row) => {
    for (const [side, column] of [
      ['left', 0],
      ['right', 2],
    ] as const) {
      const room = level[side];
      if (room.kind !== 'department') continue;
      rooms.push({
        row,
        column,
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
