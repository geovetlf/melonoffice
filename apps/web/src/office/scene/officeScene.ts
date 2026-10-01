/**
 * The Home's office, as layers over one picture: an open office with GIA's desk in the centre,
 * six desks around it and the glass wall behind. This file says where everything is in the
 * picture, once, so every layer laid over it (the people, GIA, the hotspots, the glass wall's
 * figures, GIA's future routes, the overlays) uses the same places, and a new render only needs
 * its numbers here.
 *
 * Every place is a fraction of the picture (0 to 1 across, 0 to 1 down), so it holds at any size.
 * The picture is drawn to cover its frame (`OfficeStage`), never stretched.
 */

/** A point of the picture: across, down. */
export type ScenePoint = readonly [number, number];

/** A box of the picture: left, top, right, bottom. */
export type SceneBox = readonly [number, number, number, number];

/**
 * The picture, per screen. Only the computer's exists today: a tablet and a phone use it too,
 * cropped around GIA, until their own framings are made (`OfficeStage` picks the variant).
 *
 * The computer's picture is the office empty (`art/office-empty.webp`, 1080 × 498, 2.169 : 1):
 * the render without the people at its desks, who are layers of their own (`SEATS[*].figure`),
 * drawn only for real agents. It is the render's 1080 × 603 without its top 42 and bottom 63
 * pixels, where a search bar, a bell, credits, an account picture and a navigation bar had been
 * drawn: the app has its own, real ones.
 */
export interface SceneArt {
  /** The file in `./art`, without its extension. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export const SCENE_ART: {
  readonly desktop: SceneArt;
  readonly tablet?: SceneArt;
  readonly mobile?: SceneArt;
} = {
  desktop: { name: 'office-empty', width: 1080, height: 498 },
};

export const SCENE = SCENE_ART.desktop;
export const SCENE_ASPECT = SCENE.width / SCENE.height;

export type SeatKey =
  'gia' | 'comercial' | 'marketing' | 'operaciones' | 'investigacion' | 'finanzas' | 'direccion';

/** A desk of the office: who sits there, the desk itself and its name plate. */
export interface SceneSeat {
  /** Where the person sits: the middle of their body. */
  readonly person: ScenePoint;
  /** The person at the desk, cut from the render (`art/people/<seat>.webp`), and where it goes. */
  readonly figure: SceneBox;
  readonly desk: SceneBox;
  /** The name plate on the desk's front, where the office draws its own. */
  readonly plate: SceneBox;
  /**
   * Where GIA stands when she is with the agent at this desk: on the floor beside it, on the side
   * of the centre. At her own desk, where she sits.
   */
  readonly stand: ScenePoint;
  /** How tall a person standing there is drawn, as a fraction of the picture's height. */
  readonly height: number;
  /**
   * The catalogue type of the department that sits there; none for GIA, who is no department.
   * The render's plates named two desks differently: "Dirección" is the board (`leadership`,
   * "Consejo y Dirección"), and "Diseño" is Investigación, the sixth real function: Design & Video
   * was retired into Marketing (ADR-0047).
   */
  readonly department: string | null;
}

/** GIA in the centre, then the desks left and right, back to front. */
export const SEATS: Readonly<Record<SeatKey, SceneSeat>> = {
  gia: {
    person: [0.4926, 0.4177],
    figure: [0.4722, 0.3434, 0.5231, 0.498],
    desk: [0.3472, 0.4277, 0.6481, 0.6084],
    plate: [0.412, 0.504, 0.5898, 0.5984],
    stand: [0.4926, 0.4177],
    height: 0.2,
    department: null,
  },
  comercial: {
    person: [0.1963, 0.3273],
    figure: [0.1815, 0.2711, 0.2296, 0.3916],
    desk: [0.1296, 0.3072, 0.3056, 0.4739],
    plate: [0.1407, 0.3775, 0.2898, 0.4699],
    stand: [0.335, 0.45],
    height: 0.17,
    department: 'sales',
  },
  operaciones: {
    person: [0.125, 0.5281],
    figure: [0.0981, 0.4478, 0.1685, 0.6084],
    desk: [0.0509, 0.498, 0.2593, 0.7088],
    plate: [0.0519, 0.5944, 0.2204, 0.6948],
    stand: [0.29, 0.66],
    height: 0.21,
    department: 'operations',
  },
  finanzas: {
    person: [0.2546, 0.7791],
    figure: [0.2204, 0.6867, 0.3065, 0.8635],
    desk: [0.1481, 0.7088, 0.4028, 0.9598],
    plate: [0.1667, 0.8454, 0.3657, 0.9639],
    stand: [0.43, 0.86],
    height: 0.26,
    department: 'finance',
  },
  marketing: {
    person: [0.8056, 0.3133],
    figure: [0.7713, 0.2711, 0.8222, 0.3936],
    desk: [0.6944, 0.3072, 0.875, 0.4739],
    plate: [0.7148, 0.3775, 0.8611, 0.4679],
    stand: [0.665, 0.45],
    height: 0.17,
    department: 'marketing',
  },
  investigacion: {
    person: [0.8796, 0.5181],
    figure: [0.8426, 0.4518, 0.9028, 0.6084],
    desk: [0.7407, 0.498, 0.9537, 0.7088],
    plate: [0.7778, 0.5944, 0.9565, 0.6948],
    stand: [0.72, 0.66],
    height: 0.21,
    department: 'research',
  },
  direccion: {
    person: [0.7315, 0.7691],
    figure: [0.6917, 0.6888, 0.7713, 0.8655],
    desk: [0.5926, 0.7088, 0.8519, 0.9598],
    plate: [0.6278, 0.8454, 0.8333, 0.9639],
    stand: [0.57, 0.86],
    height: 0.26,
    department: 'leadership',
  },
};

/**
 * The desks in the order the eye reads them, row by row, left to right, which is the order a
 * keyboard reaches them: GIA's in the middle of the second row.
 */
export const DESKS: readonly SeatKey[] = [
  'comercial',
  'marketing',
  'operaciones',
  'gia',
  'investigacion',
  'finanzas',
  'direccion',
];

/**
 * GIA's way from her chair to each desk, over the floor: round her own desk by the side of the one
 * she goes to, then along the open floor to where she stands beside it. Straight legs between
 * points that keep clear of every desk; her way back is the same, reversed. Nothing walks it yet:
 * when her real tasks put her somewhere (`gia/presence.ts`), she is simply there. The walk will
 * follow these points.
 */
const BEHIND_LEFT: ScenePoint = [0.33, 0.45];
const BEHIND_RIGHT: ScenePoint = [0.665, 0.45];
const FRONT_LEFT: ScenePoint = [0.33, 0.64];
const FRONT_RIGHT: ScenePoint = [0.665, 0.64];

export const GIA_ROUTES: Readonly<Record<Exclude<SeatKey, 'gia'>, readonly ScenePoint[]>> = {
  comercial: [SEATS.gia.person, BEHIND_LEFT, SEATS.comercial.stand],
  operaciones: [SEATS.gia.person, BEHIND_LEFT, FRONT_LEFT, SEATS.operaciones.stand],
  finanzas: [SEATS.gia.person, BEHIND_LEFT, FRONT_LEFT, [0.44, 0.68], SEATS.finanzas.stand],
  marketing: [SEATS.gia.person, BEHIND_RIGHT, SEATS.marketing.stand],
  investigacion: [SEATS.gia.person, BEHIND_RIGHT, FRONT_RIGHT, SEATS.investigacion.stand],
  direccion: [SEATS.gia.person, BEHIND_RIGHT, FRONT_RIGHT, [0.56, 0.68], SEATS.direccion.stand],
};

/**
 * The glass wall, and its two panels where the render had drawn made-up figures: the office's own
 * figures are shown there instead (`OfficeStage`). The right one opens MelonMotor.
 */
export const GLASS_WALL: SceneBox = [0.2778, 0.0562, 0.7222, 0.3976];
export const WALL_PANELS: { readonly left: SceneBox; readonly right: SceneBox } = {
  left: [0.2926, 0.1185, 0.4148, 0.3133],
  right: [0.5926, 0.1586, 0.7, 0.3133],
};

/** The MelonOffice mark on the glass wall. */
export const LOGO: { readonly mark: ScenePoint; readonly box: SceneBox } = {
  mark: [0.4926, 0.1727],
  box: [0.4352, 0.1265, 0.5509, 0.3072],
};

/**
 * Where a control may sit over the picture without covering a desk, a person or the wall: the
 * ceiling either side of the wall, and the floor between the two front desks.
 */
export const OPEN_AREAS: readonly SceneBox[] = [
  [0, 0, 0.25, 0.12],
  [0.75, 0, 1, 0.12],
  [0.42, 0.82, 0.58, 1],
];

/** The most the office can be zoomed in: past it, the picture's pixels show. */
export const MAX_ZOOM = 3;

/** Whether a point is inside a box. */
export const within = ([x, y]: ScenePoint, [l, t, r, b]: SceneBox) =>
  x > l && x < r && y > t && y < b;
