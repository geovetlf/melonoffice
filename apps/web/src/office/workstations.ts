import type { AgentState } from './departments.js';
import type { DepartmentView, SpecialistView } from './officeClient.js';

/**
 * A department's office as places to work (ADR-0041): Department → Workstations → Agents →
 * Presence → Activity. The office draws what this model says and nothing more.
 *
 * Nothing here is stored yet. A department's layout comes from `layoutOf` (provisional seat
 * counts, below) and agents take the seats in a stable order, because there is no assignment
 * record. When layouts and assignments are saved, they replace `layoutOf` and `seatAgents`; the
 * screens read the same `Workstation` either way.
 */

/** Where a workstation sits in its room: fractions of the room's width and height (0 to 1). */
export interface SeatPosition {
  readonly x: number;
  readonly y: number;
  /** Rows further back are drawn smaller: 0 is the back row. */
  readonly row: number;
}

export type SeatFacing = 'front' | 'left' | 'right';

export interface Workstation {
  /** Stable within its department: `{departmentId}:seat-{n}`. */
  readonly id: string;
  readonly departmentId: string;
  /** 1-based, as a person counts seats. */
  readonly number: number;
  readonly position: SeatPosition;
  readonly facing: SeatFacing;
  /** Who the office shows at this workstation (see `WorkstationOccupant`); `null` is a free desk. */
  readonly occupant: WorkstationOccupant | null;
}

/**
 * Who sits at a workstation, as the office shows it (ADR-0042):
 * - `agent`: a real agent of the organization (a specialist record), with its own controls;
 * - `ambient`: a decorative figure that keeps an unstaffed office from looking empty. It is not an
 *   agent, has no name, state or activity, and the workstation stays free: a real agent takes it
 *   over, and the figure is gone.
 */
export type WorkstationOccupant =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'ambient'; readonly visualId: string };

/** The real agent at a workstation, if any: ambient figures are not agents. */
export const agentAt = (workstation: Pick<Workstation, 'occupant'>): string | null =>
  workstation.occupant?.kind === 'agent' ? workstation.occupant.agentId : null;

/**
 * What an agent is doing, when the runtime reports it. Nothing produces this yet: every agent's
 * activity is `null`, and the office says "no activity" rather than invent one.
 */
export type ActivityKind =
  'writing' | 'talking' | 'reading' | 'analyzing' | 'meeting' | 'working' | 'walking';

export interface AgentActivity {
  readonly kind: ActivityKind;
  readonly description: string | null;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly startedAt: string;
  /** 0 to 1, when the work reports progress. */
  readonly progress: number | null;
}

/**
 * An agent in the office: where it sits and what state it is in. `source` says where the state
 * came from. Today it is always `record`: the specialist's own status (active, paused…), never
 * what it is doing. A future `runtime` source may report `working` and an activity.
 */
export interface AgentPresence {
  readonly agentId: string;
  readonly workstationId: string | null;
  readonly state: AgentState;
  readonly activity: AgentActivity | null;
  readonly updatedAt: string | null;
  readonly source: 'record' | 'runtime';
}

/** How a department's office is laid out. */
export interface OfficeLayout {
  readonly seats: number;
  /**
   * The workstations (1-based numbers) that show an ambient figure while no real agent sits there
   * (ADR-0042). Never all of them: an office keeps free desks.
   */
  readonly ambient: readonly number[];
}

/**
 * Provisional layouts per catalogue type: examples to draw the offices with, not a product
 * decision. This is the one place both the Home and the department offices read them from, until
 * layouts are configurable and stored.
 */
const PROVISIONAL_LAYOUTS: Readonly<Record<string, OfficeLayout>> = {
  leadership: { seats: 4, ambient: [1, 3] },
  operations: { seats: 8, ambient: [1, 2, 4, 6, 7] },
  sales: { seats: 5, ambient: [1, 3, 4] },
  marketing: { seats: 6, ambient: [1, 2, 4] },
  // Retired into Marketing (ADR-0047): kept only so an organization not yet migrated draws it.
  design_video: { seats: 6, ambient: [1, 3, 5] },
  research: { seats: 4, ambient: [1, 2] },
  finance: { seats: 4, ambient: [1, 3] },
};

const DEFAULT_LAYOUT: OfficeLayout = { seats: 4, ambient: [1, 3] };
/** No room is drawn with more desks than this; a bigger team scrolls in the list. */
export const MAX_SEATS = 12;

export function layoutOf(department: Pick<DepartmentView, 'typeId'>): OfficeLayout {
  const layout =
    (department.typeId === null ? undefined : PROVISIONAL_LAYOUTS[department.typeId]) ??
    DEFAULT_LAYOUT;
  const seats = Math.min(Math.max(layout.seats, 1), MAX_SEATS);
  // At least one desk always stays visibly free.
  const ambient = layout.ambient.filter((n) => n >= 1 && n <= seats).slice(0, seats - 1);
  return { seats, ambient };
}

/**
 * Where `count` desks go on a room's floor: one row up to 5, two up to 10, then three. The back
 * row is narrower, so the floor reads in depth.
 */
export function arrangeSeats(count: number): readonly SeatPosition[] {
  const rows = count <= 5 ? 1 : count <= 10 ? 2 : 3;
  const perRow = Math.ceil(count / rows);
  const rowYs = rows === 1 ? [0.84] : rows === 2 ? [0.71, 0.92] : [0.66, 0.8, 0.94];
  const positions: SeatPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(perRow, count - row * perRow);
    const inset = 0.16 - (row / Math.max(rows - 1, 1)) * 0.06;
    const span = 1 - inset * 2;
    for (let i = 0; i < inRow; i += 1) {
      positions.push({
        x: inset + (span * (i + 0.5)) / inRow,
        y: rowYs[row] ?? 0.9,
        row,
      });
    }
  }
  return positions;
}

/** The specialists that belong in the office: every one but archived, in a stable order. */
function officeAgents(
  department: Pick<DepartmentView, 'id'>,
  specialists: readonly SpecialistView[],
): readonly SpecialistView[] {
  return specialists
    .filter((s) => s.departmentId === department.id && s.status !== 'archived')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface DepartmentSeating {
  readonly workstations: readonly Workstation[];
  /** Agents with no free workstation: shown, never dropped. */
  readonly unseated: readonly SpecialistView[];
  readonly occupied: number;
}

/**
 * The department's workstations and who sits where. Only this department's specialists can take
 * a seat, so an agent of another department, or another organization, never appears here. Each
 * workstation shows, in order: its real agent; else the layout's ambient figure; else nobody.
 */
export function seatAgents(
  department: Pick<DepartmentView, 'id' | 'typeId'>,
  specialists: readonly SpecialistView[],
  layout: OfficeLayout = layoutOf(department),
): DepartmentSeating {
  const agents = officeAgents(department, specialists);
  const positions = arrangeSeats(layout.seats);
  const workstations = positions.map((position, i): Workstation => {
    const agent = agents[i];
    const number = i + 1;
    const occupant: WorkstationOccupant | null =
      agent !== undefined
        ? { kind: 'agent', agentId: agent.id }
        : layout.ambient.includes(number)
          ? { kind: 'ambient', visualId: `ambient-${number}` }
          : null;
    return {
      id: `${department.id}:seat-${number}`,
      departmentId: department.id,
      number,
      position,
      facing: 'front',
      occupant,
    };
  });
  return {
    workstations,
    unseated: agents.slice(positions.length),
    occupied: Math.min(agents.length, positions.length),
  };
}

/**
 * An agent's presence, from its record only (D-28: a specialist is a record, not running AI).
 * Active is `available`, paused is `paused`, a draft or disabled one is `offline`. Nothing here
 * says `working`: that needs a runtime report, which does not exist yet.
 */
export function presenceOf(
  specialist: Pick<SpecialistView, 'id' | 'status' | 'updatedAt'>,
  workstationId: string | null,
): AgentPresence {
  const state: AgentState =
    specialist.status === 'active'
      ? 'available'
      : specialist.status === 'paused'
        ? 'paused'
        : 'offline';
  return {
    agentId: specialist.id,
    workstationId,
    state,
    activity: null,
    updatedAt: specialist.updatedAt ?? null,
    source: 'record',
  };
}

/** The drawing's view of the seats: where each desk is and who is at it. */
export function roomSeats(
  seating: DepartmentSeating,
  specialists: readonly SpecialistView[],
): readonly { readonly position: SeatPosition; readonly occupant: RoomOccupant }[] {
  return seating.workstations.map((workstation) => {
    if (workstation.occupant?.kind === 'ambient') {
      return { position: workstation.position, occupant: 'ambient' };
    }
    const agent = specialists.find((s) => s.id === agentAt(workstation));
    if (agent === undefined) return { position: workstation.position, occupant: null };
    const { state } = presenceOf(agent, workstation.id);
    return {
      position: workstation.position,
      occupant: state === 'paused' ? 'paused' : state === 'offline' ? 'offline' : 'present',
    };
  });
}

/** Who the drawing puts at a desk: a real agent by its record state, an ambient figure, or no one. */
export type RoomOccupant = 'present' | 'paused' | 'offline' | 'ambient' | null;
