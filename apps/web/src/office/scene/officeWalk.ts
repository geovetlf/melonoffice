import { cellKey, type Cells, type Point, type Rect } from './circuits.js';

/**
 * How a person gets around the Home's office, in the office's own pixels as it is laid out. The
 * building is a block of storeys seen from the front and above (`layout.ts`): every storey has a
 * walkway along the front of its rooms, and two lift shafts run between the side rooms and the
 * centre column, one each side. Every room is open at the front, so a person leaves a room by
 * stepping forward onto its storey's walkway, walks along it, takes a lift to another storey and
 * steps up into the room they are going to. Nobody crosses a wall, floats or jumps.
 *
 * Rooms are pictures (`roomFloor.ts`) drawn to cover their box; a place in a room is a point of
 * its picture (fractions of its width and height), turned here into the office's pixels.
 */

/** The pictures' shapes: a side room is 576 × 320, a centre room 403 × 320. */
export const SIDE_ASPECT = 576 / 320;
export const CENTRE_ASPECT = 403 / 320;

/**
 * Where a person stands in a room, as a point of its picture:
 * - in a department, at the front of the floor on the left, clear of the desks and of the
 *   room's sign and status (top left, bottom right);
 * - in Consejo, on the strip of floor in front of the board table;
 * - at home, GIA on the centre of her platform.
 */
export const STAND = {
  side: [0.11, 0.975],
  board: [0.2, 0.975],
  gia: [0.5, 0.715],
} as const satisfies Record<string, readonly [number, number]>;

/** A person is this tall in a room, as a fraction of the room's picture height. */
export const PERSON_HEIGHT = 0.36;

/** A room on the plan: its row and column (0 left, 1 centre, 2 right). */
export interface PlanRoom {
  readonly row: number;
  readonly column: number;
}

/** One stretch of a walk: on foot, or standing in a lift. */
export interface Leg {
  readonly kind: 'walk' | 'lift';
  readonly from: Point;
  readonly to: Point;
  /** The shaft a lift leg runs in. */
  readonly shaft?: 'left' | 'right';
}

/** Where a picture's point lands in its room's box, the picture covering the box. */
export function pointIn(room: Rect, aspect: number, [fx, fy]: readonly [number, number]): Point {
  const width = Math.max(room.w, room.h * aspect);
  const height = width / aspect;
  return {
    x: room.x + room.w / 2 + (fx - 0.5) * width,
    y: room.y + room.h / 2 + (fy - 0.5) * height,
  };
}

/** How tall a person is drawn in a room's box, in pixels. */
export function personHeight(room: Rect, aspect: number): number {
  return Math.max(room.w / aspect, room.h) * PERSON_HEIGHT;
}

export interface WalkPlan {
  /** Where a person stands in a room. */
  readonly spot: (room: PlanRoom) => Point | undefined;
  /** A person's height, in pixels: the same on every storey. */
  readonly person: number;
  /** Each storey's walkway: the line a person walks on, and its ends. */
  readonly walkway: (
    row: number,
  ) => { readonly y: number; readonly x0: number; readonly x1: number } | undefined;
  /** The centre line of each lift shaft. */
  readonly shafts: { readonly left: number; readonly right: number };
  /** The legs from one room to another. */
  readonly route: (from: PlanRoom, to: PlanRoom) => readonly Leg[] | undefined;
}

/**
 * The plan of the office as laid out, from the rooms' boxes. `height` is the office's own height,
 * which closes the last storey's walkway. Undefined while the rooms are not laid out as a block
 * (on a phone the rooms are a list, and nobody walks between them).
 */
export function walkPlan(cells: Cells, height: number): WalkPlan | undefined {
  const left = cells.get(cellKey(1, 0));
  const gia = cells.get(cellKey(1, 1));
  const right = cells.get(cellKey(1, 2));
  if (left === undefined || gia === undefined || right === undefined) return undefined;
  // Laid out as a block: the side rooms sit level with GIA's, either side of her.
  if (Math.abs(left.y - gia.y) > 2 || left.x + left.w > gia.x || gia.x + gia.w > right.x) {
    return undefined;
  }
  const shafts = { left: (left.x + left.w + gia.x) / 2, right: (gia.x + gia.w + right.x) / 2 };
  const person = personHeight(gia, CENTRE_ASPECT);
  const rows = new Set([...cells.keys()].map((key) => Number(key.split('-')[0])));

  const walkway = (row: number) => {
    if (!rows.has(row)) return undefined;
    const here = [0, 1, 2].map((column) => cells.get(cellKey(row, column))).filter(isRect);
    const below = [0, 1, 2].map((column) => cells.get(cellKey(row + 1, column))).filter(isRect);
    if (here.length === 0) return undefined;
    const top = Math.max(...here.map((room) => room.y + room.h));
    const bottom = below.length > 0 ? Math.min(...below.map((room) => room.y)) : height;
    return {
      y: (top + bottom) / 2,
      x0: Math.min(...here.map((room) => room.x)),
      x1: Math.max(...here.map((room) => room.x + room.w)),
    };
  };

  const spot = ({ row, column }: PlanRoom): Point | undefined => {
    const room = cells.get(cellKey(row, column));
    if (room === undefined) return undefined;
    if (column !== 1) return pointIn(room, SIDE_ASPECT, STAND.side);
    return pointIn(room, CENTRE_ASPECT, row === 1 ? STAND.gia : STAND.board);
  };

  /** The point of a storey's walkway in front of where a person stands in a room. */
  const door = (room: PlanRoom): Point | undefined => {
    const at = spot(room);
    const way = walkway(room.row);
    return at === undefined || way === undefined ? undefined : { x: at.x, y: way.y };
  };

  const route = (from: PlanRoom, to: PlanRoom): readonly Leg[] | undefined => {
    const start = spot(from);
    const end = spot(to);
    const out = door(from);
    const into = door(to);
    if (start === undefined || end === undefined || out === undefined || into === undefined) {
      return undefined;
    }
    const legs: Leg[] = [{ kind: 'walk', from: start, to: out }];
    if (from.row === to.row) {
      legs.push({ kind: 'walk', from: out, to: into });
    } else {
      // The lift on the side of the room she is going to (Consejo's on the left).
      const side = (to.column === 1 ? from.column : to.column) === 2 ? 'right' : 'left';
      const x = shafts[side];
      const target = walkway(to.row);
      if (target === undefined) return undefined;
      const liftIn = { x, y: out.y };
      const liftOut = { x, y: target.y };
      legs.push(
        { kind: 'walk', from: out, to: liftIn },
        { kind: 'lift', from: liftIn, to: liftOut, shaft: side },
        { kind: 'walk', from: liftOut, to: into },
      );
    }
    legs.push({ kind: 'walk', from: into, to: end });
    return legs.filter((leg) => distance(leg.from, leg.to) > 0.5);
  };

  return { spot, person, walkway, shafts, route };
}

export const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

const isRect = (rect: Rect | undefined): rect is Rect => rect !== undefined;
