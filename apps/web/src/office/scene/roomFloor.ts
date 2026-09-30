/**
 * Where the Home seats workstations in its rooms. The rooms are baked 3D pictures seen from the
 * front and above (`scripts/office-art`); the bake reports where the floor that is kept clear for
 * desks lands in each picture. A seat is placed on that floor in metres and then projected into
 * the picture, so desks further back are higher up and smaller, as in the room itself.
 */

/** A point of a picture, as fractions of its width and height. */
export type Fraction = readonly [number, number];

/** The four corners of a floor in a picture: back left, back right, front right, front left. */
export type FloorCorners = readonly [Fraction, Fraction, Fraction, Fraction];

/** A department's room: the clear floor is 5.4 m wide (the bake's `DESK_FLOOR`). */
export const SIDE_FLOOR: FloorCorners = [
  [0.2031, 0.5954],
  [0.7969, 0.5954],
  [0.909, 0.9904],
  [0.091, 0.9904],
];
export const SIDE_FLOOR_WIDTH = 5.4;

/** Consejo's room: the strip of floor in front of the board table, 3.8 m wide. */
export const CENTRE_FLOOR: FloorCorners = [
  [0.129, 0.8564],
  [0.871, 0.8564],
  [0.9204, 1.0304],
  [0.0796, 1.0304],
];
export const CENTRE_FLOOR_WIDTH = 3.8;

/** A workstation is drawn 1.9 m wide (the bake's workstation box). */
const DESK_WIDTH = 1.9;

/**
 * Each room's big screen, by the room's picture (left, top, right, bottom as fractions): the
 * screen sits to the side away from the room's window.
 */
const SCREEN_LEFT = [0.3007, 0.0056, 0.6151, 0.2995] as const;
const SCREEN_RIGHT = [0.3761, 0.0056, 0.6852, 0.2995] as const;
const WINDOW_RIGHT = new Set(['dashboard', 'video', 'finance']);
export const screenOf = (motif: string): readonly [number, number, number, number] =>
  WINDOW_RIGHT.has(motif) ? SCREEN_LEFT : SCREEN_RIGHT;

/** The projective map from the unit square onto the floor's corners. */
function homography(corners: FloorCorners): (u: number, v: number) => Fraction {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
  // The square's corners (0,0), (1,0), (1,1), (0,1) go to the floor's, in that order.
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w];
  };
}

export interface HomeSeat {
  /** The point of the floor under the workstation, as fractions of the picture. */
  readonly x: number;
  readonly y: number;
  /** The workstation's width, as a fraction of the picture's width. */
  readonly width: number;
  /** 0 is the back row: rows in front are drawn over it. */
  readonly row: number;
}

/**
 * Where `count` workstations go: one row up to 3, two up to 8, then three, each row spread
 * across the floor. `columns` (0 to 1 across the floor) places them by hand instead.
 */
export function homeSeats(
  count: number,
  floor: FloorCorners = SIDE_FLOOR,
  floorWidth = SIDE_FLOOR_WIDTH,
  columns?: readonly (readonly [number, number])[],
): readonly HomeSeat[] {
  const at = homography(floor);
  const spots: [number, number, number][] = [];
  if (columns !== undefined) {
    columns.slice(0, count).forEach(([u, v]) => spots.push([u, v, 0]));
  } else {
    const rows = count <= 3 ? 1 : count <= 8 ? 2 : 3;
    const depths = rows === 1 ? [0.6] : rows === 2 ? [0.3, 0.88] : [0.12, 0.52, 0.94];
    const perRow = Math.ceil(count / rows);
    for (let row = 0; row < rows; row += 1) {
      const inRow = Math.min(perRow, count - row * perRow);
      for (let i = 0; i < inRow; i += 1) {
        spots.push([0.08 + (0.84 * (i + 0.5)) / Math.max(inRow, 1), depths[row] ?? 0.9, row]);
      }
    }
  }
  const half = DESK_WIDTH / 2 / floorWidth;
  return spots.map(([u, v, row]) => {
    const [x, y] = at(u, v);
    const [left] = at(u - half, v);
    const [right] = at(u + half, v);
    return { x, y, width: right - left, row };
  });
}
