import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { navigate } from '../../identity/router.js';
import { paths } from '../../shell/routes.js';
import { AgentAvatar, AgentStatus } from '../agents.js';
import {
  AGENT_STATES,
  agentsOf,
  departmentName,
  lookOf,
  officeDepartments,
  officeSlug,
  type AgentState,
} from '../departments.js';
import { Icon } from '../icons.js';
import type { DepartmentView, SpecialistView } from '../officeClient.js';
import { departmentPriority, readyList, useOfficeData } from '../OfficeData.js';
import { agentsSummary, seatsSummary } from '../OfficeScene.js';
import { navigateInto, prefersReducedMotion } from '../transition.js';
import { agentAt, seatAgents } from '../workstations.js';
import { isCurrentTask, workStateOf, type AgentWork } from './agentWork.js';
import {
  cellKey,
  circuitLevel,
  departmentRooms,
  network,
  pulsesFor,
  routeLength,
  tracePath,
  type Cells,
  type Point,
  type Rect,
} from './circuits.js';
import { buildingFloors, type CentreRoom, type Floor, type SideRoom } from './layout.js';
import type { MotorState } from './motor.js';
import { MELON_MARK } from '../../shell/mark.js';
import {
  CENTRE_FLOOR,
  CENTRE_FLOOR_WIDTH,
  homeSeats,
  screenOf,
  type HomeSeat,
} from './roomFloor.js';
import { Workstation, type DeskOccupant } from './Workstation.js';
import {
  giaTarget,
  useGiaEngagements,
  type GiaActivity,
  type GiaPlace,
  type GiaTarget,
} from '../../gia/presence.js';
import { activityOf, GiaHere, GiaWalker, useGiaWalk, viewAt } from './GiaInOffice.js';
import { CENTRE_ASPECT, SIDE_ASPECT, STAND, walkPlan, type PlanRoom } from './officeWalk.js';

/**
 * The Home's office: the organization's rooms seen whole, three by three, with GIA at the heart
 * of it and MelonMotor beneath her. Three layers, kept apart:
 *
 * - the picture: each room is a baked image (`./art`, drawn by `scripts/office-art`), with no
 *   data in it;
 * - the interactive layer: every department, agent, GIA and MelonMotor is its own named control,
 *   placed over the picture in fractions of the room, so it follows any screen size;
 * - the data: departments, agents, their states and their work come from the office's data
 *   (ADR-0040) and the agents' tasks (ADR-0063); nothing is drawn that the records do not say.
 *
 * A room opens its department's office (the existing level 2); an agent opens its card; GIA opens
 * her workplace; MelonMotor shows the work flowing between departments.
 */
export function OfficeBuilding({
  work,
  motor,
  motorOpen,
  onMotor,
  onAgent,
}: {
  readonly work: AgentWork;
  readonly motor: MotorState;
  readonly motorOpen: boolean;
  readonly onMotor: () => void;
  /** Opens an agent's card; the element is where focus returns when it closes. */
  readonly onAgent: (agentId: string, from: HTMLElement) => void;
}) {
  const intl = useIntl();
  const { departments, specialists, business } = useOfficeData();
  const agents = readyList(specialists);
  const { headquarters, floor } = officeDepartments(
    readyList(departments),
    departmentPriority(business),
  );
  const floors = buildingFloors(floor);
  const frame = useRef<HTMLDivElement>(null);
  const cells = useCells(frame, `${departments.status}:${floors.length}`);
  // GIA: where the records put her, and her walk there when that changes on screen.
  const rooms = departmentRooms(floors, headquarters);
  const roomOf = placeOn(rooms);
  const engagements = useGiaEngagements();
  const asked = giaTarget(engagements, agents, work);
  // A department that has no room on the plan cannot hold her: she stays in her own room.
  const target: GiaTarget =
    roomOf(asked.place) === undefined
      ? { ...asked, place: HOME, activity: asked.coordinating > 0 ? 'coordinating' : 'idle' }
      : asked;
  const plan = useMemo(() => walkPlan(cells.cells, cells.height), [cells]);
  const { settled, walk, arrive } = useGiaWalk(target, plan, roomOf, prefersReducedMotion());
  const [leg, setLeg] = useState(0);
  const [lifts, setLifts] = useState<Readonly<Record<'left' | 'right', number>>>({
    left: 1,
    right: 1,
  });
  const cabins = useRef<Partial<Record<'left' | 'right', HTMLElement | null>>>({});
  const lift = useCallback((shaft: 'left' | 'right') => cabins.current[shaft] ?? null, []);
  const gia: GiaInBuilding = {
    at: settled,
    target,
    activity: activityOf(target, walk, leg),
    going: walk?.to,
    agentName: (agentId) => agents.find((agent) => agent.id === agentId)?.displayName ?? '',
    departmentName: (departmentId) => {
      const department = readyList(departments).find((d) => d.id === departmentId);
      return department === undefined ? '' : departmentName(intl, department);
    },
  };
  const context: RoomContext = { agents, work, onAgent, gia };
  const landed = () => {
    // A lift stays on the storey where she left it.
    if (walk !== null && plan !== undefined) {
      const next = { ...lifts };
      for (const step of walk.legs) {
        if (step.kind !== 'lift' || step.shaft === undefined) continue;
        const row = floors.findIndex(
          (_, i) => Math.abs((plan.walkway(i)?.y ?? -1) - step.to.y) < 1,
        );
        if (row !== -1) next[step.shaft] = row;
      }
      setLifts(next);
    }
    setLeg(0);
    arrive();
  };
  // The department under the pointer or the focus: its circuit lights up.
  const [hot, setHot] = useState<string | null>(null);
  const heat = (target: EventTarget) =>
    setHot(
      target instanceof Element
        ? (target.closest('[data-room]')?.getAttribute('data-room') ?? null)
        : null,
    );
  return (
    <section className="building" aria-labelledby="building-title">
      <h2 id="building-title" className="visually-hidden">
        <FormattedMessage id="office.scene.title" />
      </h2>
      {departments.status === 'loading' ? (
        <p className="building__notice" role="status">
          <FormattedMessage id="office.scene.loading" />
        </p>
      ) : (
        <>
          {departments.status === 'ready' ? null : (
            <p className="building__notice building__notice--inline">
              <FormattedMessage
                id={
                  departments.status === 'hidden'
                    ? 'office.scene.hidden'
                    : 'office.scene.unavailable'
                }
              />
            </p>
          )}
          {/* The listeners only light the circuits of the room under the pointer or focus;
              the rooms themselves are the links and buttons inside. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            ref={frame}
            className="building__frame"
            style={{ '--floors': floors.length } as CSSProperties}
            data-gia-activity={gia.activity}
            aria-label={intl.formatMessage({ id: 'office.scene.rooms' })}
            role="group"
            onPointerOver={(event) => heat(event.target)}
            onPointerLeave={() => setHot(null)}
            onFocus={(event) => heat(event.target)}
            onBlur={() => setHot(null)}
          >
            {floors.map((level, i) => (
              <FloorRooms
                key={i}
                floor={level}
                index={i}
                headquarters={headquarters}
                context={context}
                motorOpen={motorOpen}
                onMotor={onMotor}
              />
            ))}
            <Walkways floors={floors.length} plan={plan} lifts={lifts} cabins={cabins} />
            <Circuits
              floors={floors}
              headquarters={headquarters}
              cells={cells}
              context={context}
              motor={motor}
              hot={hot}
            />
            {walk !== null && plan !== undefined ? (
              <GiaWalker
                walk={walk}
                person={plan.person}
                lift={lift}
                onLeg={setLeg}
                onArrive={landed}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

interface RoomContext {
  readonly agents: readonly SpecialistView[];
  readonly work: AgentWork;
  readonly onAgent: (agentId: string, from: HTMLElement) => void;
  readonly gia: GiaInBuilding;
}

/** GIA in the office: where she stands (none while she walks), and what she does. */
interface GiaInBuilding {
  readonly at: GiaPlace | null;
  readonly target: GiaTarget;
  readonly activity: GiaActivity;
  /** Where she is walking to. */
  readonly going: GiaPlace | undefined;
  readonly agentName: (agentId: string) => string;
  readonly departmentName: (departmentId: string) => string;
}

const HOME: GiaPlace = { kind: 'home' };

/** Where a place is on the plan: her own room is the centre of the second storey. */
const placeOn =
  (rooms: readonly { readonly id: string; readonly row: number; readonly column: number }[]) =>
  (place: GiaPlace): PlanRoom | undefined =>
    place.kind === 'home'
      ? { row: 1, column: 1 }
      : rooms.find((room) => room.id === place.departmentId);

/** Whether GIA stands in this department's room now, and with which agent. */
function giaWith(context: RoomContext, departmentId: string): string | undefined {
  const at = context.gia.at;
  return at?.kind === 'department' && at.departmentId === departmentId ? at.agentId : undefined;
}

/**
 * The building's walkways and lifts (`officeWalk.ts`): a walkway along the front of every
 * storey, and a lift shaft each side of the centre column, its cabin where GIA last left it.
 * Only drawn when the rooms are laid out as a block.
 */
function Walkways({
  floors,
  plan,
  lifts,
  cabins,
}: {
  readonly floors: number;
  readonly plan: ReturnType<typeof walkPlan>;
  readonly lifts: Readonly<Record<'left' | 'right', number>>;
  readonly cabins: RefObject<Partial<Record<'left' | 'right', HTMLElement | null>>>;
}) {
  return (
    <>
      {Array.from({ length: floors }, (_, i) => (
        <span
          key={i}
          className="b-walkway"
          style={{ '--row': i * 2 + 2 } as CSSProperties}
          aria-hidden="true"
        />
      ))}
      {(['left', 'right'] as const).map((side) => {
        const stop = plan?.walkway(lifts[side]);
        return (
          <span key={side} className={`b-shaft b-shaft--${side}`} aria-hidden="true">
            {plan === undefined || stop === undefined ? null : (
              <span
                ref={(element) => {
                  cabins.current[side] = element;
                }}
                className="b-shaft__cabin"
                style={
                  {
                    '--cabin-bottom': `${stop.y.toFixed(1)}px`,
                    '--cabin-height': `${(plan.person * 1.18).toFixed(1)}px`,
                  } as CSSProperties
                }
              />
            )}
          </span>
        );
      })}
    </>
  );
}

function FloorRooms({
  floor,
  index,
  headquarters,
  context,
  motorOpen,
  onMotor,
}: {
  readonly floor: Floor;
  readonly index: number;
  readonly headquarters: readonly DepartmentView[];
  readonly context: RoomContext;
  readonly motorOpen: boolean;
  readonly onMotor: () => void;
}) {
  // The first floor is on screen at once; the ones below load as the person gets to them.
  const eager = index === 0;
  // On the block, storeys take every other row (a walkway between them) and rooms every other
  // column (a lift shaft between them).
  const place = (column: number): Place => ({
    style: { '--row': index * 2 + 1, '--column': column * 2 - 1 } as CSSProperties,
    slot: cellKey(index, column - 1),
  });
  const left = <SideRoomView room={floor.left} context={context} eager={eager} place={place(1)} />;
  const right = (
    <SideRoomView room={floor.right} context={context} eager={eager} place={place(3)} />
  );
  const centre = (
    <CentreRoomView
      kind={floor.centre}
      headquarters={headquarters}
      context={context}
      eager={eager}
      place={place(2)}
      motorOpen={motorOpen}
      onMotor={onMotor}
    />
  );
  // Each room is placed in its column by the grid, so the reading order can differ from the
  // picture's: GIA and Consejo come first, then the rows left to right.
  return floor.centre === 'headquarters' || floor.centre === 'gia' ? (
    <>
      {centre}
      {left}
      {right}
    </>
  ) : (
    <>
      {left}
      {centre}
      {right}
    </>
  );
}

/** The baked pictures, by name: 1x and 2x of each. */
const ART = import.meta.glob<string>('./art/*.webp', { eager: true, import: 'default' });

function RoomPicture({
  name,
  width,
  eager,
}: {
  readonly name: string;
  /** The 1x picture's width in pixels (2x is twice that). */
  readonly width: number;
  readonly eager: boolean;
}) {
  const one = ART[`./art/${name}.webp`];
  const two = ART[`./art/${name}@2x.webp`];
  if (one === undefined) return null;
  return (
    <img
      className="b-room__art"
      src={one}
      srcSet={two === undefined ? undefined : `${one} ${width}w, ${two} ${width * 2}w`}
      sizes="(max-width: 48rem) 50vw, 26vw"
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
    />
  );
}

/** A department's agents, and what the room says about them. */
function roomState(department: DepartmentView, context: RoomContext) {
  const here = context.agents.filter(
    (agent) => agent.departmentId === department.id && agent.status !== 'archived',
  );
  const states = new Map<AgentState, number>();
  for (const agent of here) {
    const state = workStateOf(agent, context.work.get(agent.id));
    if (state !== undefined) states.set(state, (states.get(state) ?? 0) + 1);
  }
  // The room shows the state that most needs the person's eye.
  const order: readonly AgentState[] = [
    'attention',
    'working',
    'waiting',
    'processing',
    'available',
    'paused',
    'offline',
  ];
  const lead = order.find((state) => (states.get(state) ?? 0) > 0);
  const current = here
    .map((agent) => context.work.get(agent.id))
    .find((task) => isCurrentTask(task));
  return { here, states, lead, current: isCurrentTask(current) ? current : undefined };
}

/**
 * How a room introduces itself to a screen reader: its name, agents and workstations (as the
 * office always said, ADR-0041), then what its agents are doing and the work under way.
 */
function enterLabel(
  intl: ReturnType<typeof useIntl>,
  department: DepartmentView,
  context: RoomContext,
  states: ReadonlyMap<AgentState, number>,
  task: string | undefined,
): string {
  const seating = seatAgents(department, context.agents);
  const parts = [
    intl.formatMessage(
      { id: 'office.zone.enter' },
      {
        name: departmentName(intl, department),
        agents: `${agentsSummary(intl, agentsOf(department, context.agents))}. ${seatsSummary(intl, seating)}`,
      },
    ),
  ];
  const busy = new Map(
    [...states].filter(
      ([state]) => state === 'working' || state === 'waiting' || state === 'attention',
    ),
  );
  if (busy.size > 0) parts.push(stateWords(intl, busy));
  if (task !== undefined) {
    parts.push(intl.formatMessage({ id: 'office.building.underWay' }, { task }));
  }
  return parts.join('. ');
}

function stateWords(intl: ReturnType<typeof useIntl>, states: ReadonlyMap<AgentState, number>) {
  return AGENT_STATES.filter((state) => (states.get(state) ?? 0) > 0)
    .map((state) =>
      intl.formatMessage({ id: `office.agentState.${state}.count` }, { count: states.get(state) }),
    )
    .join(', ');
}

/** Where a room sits in the office's grid: its row and column, and its slot for the lines. */
interface Place {
  readonly style: CSSProperties;
  readonly slot: string;
}

function SideRoomView({
  room,
  context,
  eager,
  place,
}: {
  readonly room: SideRoom;
  readonly context: RoomContext;
  readonly eager: boolean;
  readonly place: Place;
}) {
  if (room.kind === 'meeting') {
    return (
      <div
        className="b-room b-room--side b-room--meeting"
        style={place.style}
        data-slot={place.slot}
        aria-hidden="true"
      >
        <RoomPicture name="room-meeting" width={576} eager={eager} />
      </div>
    );
  }
  return (
    <DepartmentRoom department={room.department} context={context} eager={eager} place={place} />
  );
}

function DepartmentRoom({
  department,
  context,
  eager,
  place,
}: {
  readonly department: DepartmentView;
  readonly context: RoomContext;
  readonly eager: boolean;
  readonly place: Place;
}) {
  const intl = useIntl();
  const box = useRef<HTMLDivElement>(null);
  const look = lookOf(department);
  const name = departmentName(intl, department);
  const href = paths.office(officeSlug(department));
  const { here, states, lead, current } = roomState(department, context);
  const seating = seatAgents(department, context.agents);
  const motif = ART[`./art/room-${look.motif}.webp`] === undefined ? 'generic' : look.motif;
  const seats = homeSeats(seating.workstations.length);
  const withAgent = giaWith(context, department.id);
  const giaHere =
    withAgent === undefined
      ? undefined
      : intl.formatMessage(
          { id: 'office.building.giaHere' },
          { agent: context.gia.agentName(withAgent) },
        );
  return (
    <div
      ref={box}
      className={`b-room b-room--side b-room--department${lead === undefined ? '' : ` b-room--${lead}`}`}
      style={{ ...place.style, '--zone-hue': look.hue } as CSSProperties}
      data-slot={place.slot}
      data-room={department.id}
    >
      <RoomPicture name={`room-${motif}`} width={576} eager={eager} />
      <WallScreen rect={screenOf(motif)} lead={lead} />
      <a
        href={href}
        className="b-room__link"
        aria-label={[enterLabel(intl, department, context, states, current?.request), giaHere]
          .filter(Boolean)
          .join('. ')}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigateInto(href, box.current);
        }}
      >
        <RoomSign icon={look.icon} name={name} agents={here.length} />
      </a>
      <span className="b-room__status" aria-hidden="true">
        {current !== undefined ? (
          <>
            <span className={`b-room__dot b-room__dot--${lead ?? 'available'}`} />
            <span className="b-room__task">{current.request}</span>
          </>
        ) : lead !== undefined && here.length === 1 && here[0] !== undefined ? (
          // One agent: the room says who works there and how, not a count.
          <>
            <span className={`b-room__dot b-room__dot--${lead}`} />
            <span className="b-room__task">
              {here[0].displayName} · <FormattedMessage id={`office.agentState.${lead}`} />
            </span>
          </>
        ) : lead !== undefined ? (
          <AgentStatus state={lead} count={states.get(lead) ?? 0} />
        ) : (
          <span className="b-room__task">
            <FormattedMessage id="office.zone.noAgents" />
          </span>
        )}
      </span>
      <RoomPeek agents={here} context={context} />
      <Desks
        label={intl.formatMessage({ id: 'office.building.desks' }, { name })}
        seats={seating.workstations.map((workstation, i) => ({
          position: seats[i] ?? { x: 0.5, y: 0.8, width: 0.2, row: 0 },
          agentId: agentAt(workstation),
          ambient: workstation.occupant?.kind === 'ambient',
        }))}
        context={context}
        motif={motif}
      />
      {withAgent === undefined ? null : (
        <GiaHere
          point={STAND.side}
          aspect={SIDE_ASPECT}
          view={viewAt(context.gia.activity, false)}
        />
      )}
      <Crew agents={here} context={context} name={name} />
    </div>
  );
}

/** A room's name plate: its icon, its name and how many agents work there. */
function RoomSign({
  icon,
  name,
  agents,
  centre = false,
}: {
  readonly icon: ReturnType<typeof lookOf>['icon'];
  readonly name: string;
  readonly agents: number;
  readonly centre?: boolean;
}) {
  return (
    <span className={`b-room__sign${centre ? ' b-room__sign--centre' : ''}`} aria-hidden="true">
      <span className="b-room__icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="b-room__name">{name}</span>
      <span className="b-room__count">
        <FormattedMessage id="office.building.agents" values={{ count: agents }} />
      </span>
      <Icon name="chevron" size={14} className="b-room__go" />
    </span>
  );
}

/**
 * What a room shows when the pointer or the focus is on it: its agents and their states. The
 * room's link already says all of it to a screen reader.
 */
function RoomPeek({
  agents,
  context,
}: {
  readonly agents: readonly SpecialistView[];
  readonly context: RoomContext;
}) {
  if (agents.length === 0) return null;
  return (
    <ul className="b-room__peek" aria-hidden="true">
      {agents.slice(0, 4).map((agent) => {
        const state = workStateOf(agent, context.work.get(agent.id)) ?? 'offline';
        const task = context.work.get(agent.id);
        return (
          <li key={agent.id}>
            <span className={`b-room__dot b-room__dot--${state}`} />
            <span className="b-room__peek-name">{agent.displayName}</span>
            <span className="b-room__peek-state">
              {isCurrentTask(task) ? (
                task.request
              ) : (
                <FormattedMessage id={`office.agentState.${state}`} />
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The department's big screen is part of the room's picture, showing the kind of work it does.
 * While its agents work, a band of light runs over it and a bar fills under it: the screen is
 * live. Never a figure or a chart that the records do not hold.
 */
function WallScreen({
  rect,
  lead,
}: {
  readonly rect: readonly [number, number, number, number];
  readonly lead: AgentState | undefined;
}) {
  const [left, top, right, bottom] = rect;
  const live = lead === 'working' || lead === 'attention' || lead === 'processing';
  return (
    <div
      className={`wall-screen${live ? ' wall-screen--working' : ' wall-screen--idle'}${lead === 'attention' ? ' wall-screen--attention' : ''}`}
      style={{
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        width: `${(right - left) * 100}%`,
        height: `${(bottom - top) * 100}%`,
      }}
      aria-hidden="true"
    >
      {live ? <span className="wall-screen__bar" /> : null}
    </div>
  );
}

interface DeskSeat {
  readonly position: HomeSeat;
  readonly agentId: string | null;
  readonly ambient: boolean;
}

/** The room's workstations, where the floor puts them; a real agent's is a button. */
function Desks({
  label,
  seats,
  context,
  motif,
}: {
  readonly label: string;
  readonly seats: readonly DeskSeat[];
  readonly context: RoomContext;
  readonly motif: string;
}) {
  const intl = useIntl();
  return (
    <ul className="b-room__desks" aria-label={label}>
      {seats.map((seat, i) => {
        const agent =
          seat.agentId === null ? undefined : context.agents.find((a) => a.id === seat.agentId);
        const state =
          agent === undefined ? undefined : workStateOf(agent, context.work.get(agent.id));
        const occupant: DeskOccupant =
          agent !== undefined && state !== undefined
            ? { kind: 'agent', state }
            : seat.ambient
              ? { kind: 'ambient' }
              : null;
        const style = {
          '--seat-x': seat.position.x,
          '--seat-y': seat.position.y,
          '--desk-w': `${seat.position.width * 100}%`,
          zIndex: 3 + seat.position.row,
        } as CSSProperties;
        if (agent === undefined || state === undefined) {
          // A free desk or an ambient figure: part of the picture, not a control.
          return (
            <li key={i} className="b-desk b-desk--scenery" style={style} aria-hidden="true">
              <Workstation occupant={occupant} look={i + 2} motif={motif} />
            </li>
          );
        }
        const task = context.work.get(agent.id);
        return (
          <li key={i} className={`b-desk b-desk--${state}`} style={style}>
            <button
              type="button"
              className="b-desk__agent"
              aria-label={intl.formatMessage(
                { id: 'office.building.agent' },
                {
                  name: agent.displayName,
                  state: intl.formatMessage({ id: `office.agentState.${state}` }),
                  task: isCurrentTask(task)
                    ? task.request
                    : intl.formatMessage({ id: 'office.building.noTask' }),
                },
              )}
              onClick={(event) => context.onAgent(agent.id, event.currentTarget)}
            >
              <Workstation occupant={occupant} look={lookIndex(agent.id)} motif={motif} />
              <span className="b-desk__tip" aria-hidden="true">
                <span className="b-desk__name">{agent.displayName}</span>
                <AgentStatus state={state} />
                {isCurrentTask(task) ? <span className="b-desk__task">{task.request}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** On a phone the desks are too small to point at: the room lists its agents instead. */
function Crew({
  agents,
  context,
  name,
}: {
  readonly agents: readonly SpecialistView[];
  readonly context: RoomContext;
  readonly name: string;
}) {
  const intl = useIntl();
  if (agents.length === 0) return null;
  return (
    <ul
      className="b-room__crew"
      aria-label={intl.formatMessage({ id: 'office.building.crew' }, { name })}
    >
      {agents.map((agent) => {
        const state = workStateOf(agent, context.work.get(agent.id)) ?? 'offline';
        return (
          <li key={agent.id}>
            <button
              type="button"
              className={`b-crew b-crew--${state}`}
              aria-label={intl.formatMessage(
                { id: 'office.building.agentShort' },
                {
                  name: agent.displayName,
                  state: intl.formatMessage({ id: `office.agentState.${state}` }),
                },
              )}
              onClick={(event) => context.onAgent(agent.id, event.currentTarget)}
            >
              <AgentAvatar name={agent.displayName} size={28} />
              <span className={`b-crew__light b-crew__light--${state}`} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A stable look for an agent's figure, from its id. */
function lookIndex(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** Where Consejo's agents sit: either side of the board table, at the front of the room. */
const HQ_SEATS = homeSeats(2, CENTRE_FLOOR, CENTRE_FLOOR_WIDTH, [
  [0.04, 0.55],
  [0.96, 0.55],
]);

function CentreRoomView({
  kind,
  headquarters,
  context,
  eager,
  place,
  motorOpen,
  onMotor,
}: {
  readonly kind: CentreRoom;
  readonly headquarters: readonly DepartmentView[];
  readonly context: RoomContext;
  readonly eager: boolean;
  readonly place: Place;
  readonly motorOpen: boolean;
  readonly onMotor: () => void;
}) {
  if (kind === 'headquarters') {
    return (
      <Headquarters departments={headquarters} context={context} eager={eager} place={place} />
    );
  }
  if (kind === 'gia') {
    return <GiaRoom context={context} eager={eager} place={place} />;
  }
  if (kind === 'motor') {
    return (
      <div
        className="b-room b-room--centre b-room--motor"
        style={place.style}
        data-slot={place.slot}
      >
        <RoomPicture name="atrium" width={403} eager={eager} />
        <MotorButton open={motorOpen} onClick={onMotor} />
      </div>
    );
  }
  return (
    <div
      className="b-room b-room--centre b-room--lounge"
      style={place.style}
      data-slot={place.slot}
      aria-hidden="true"
    >
      <RoomPicture name="lounge" width={403} eager={eager} />
    </div>
  );
}

/**
 * Consejo y Dirección's board room (ADR-0005), above GIA: the board table, the company's
 * objectives on the screen, the department's own agents either side. With no leadership
 * department it stays a board room with no way in.
 */
function Headquarters({
  departments,
  context,
  eager,
  place,
}: {
  readonly departments: readonly DepartmentView[];
  readonly context: RoomContext;
  readonly eager: boolean;
  readonly place: Place;
}) {
  const intl = useIntl();
  const box = useRef<HTMLDivElement>(null);
  const department = departments[0];
  let room: ReactNode = null;
  if (department !== undefined) {
    const name = departmentName(intl, department);
    const href = paths.office(officeSlug(department));
    const { here, states, lead } = roomState(department, context);
    const seating = seatAgents(department, context.agents);
    const seated = seating.workstations
      .map((workstation) => agentAt(workstation))
      .filter((id): id is string => id !== null)
      .slice(0, HQ_SEATS.length);
    const withAgent = giaWith(context, department.id);
    room = (
      <>
        <a
          href={href}
          className="b-room__link"
          aria-label={enterLabel(intl, department, context, states, undefined)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            navigateInto(href, box.current);
          }}
        >
          <RoomSign icon={lookOf(department).icon} name={name} agents={here.length} centre />
          {lead === undefined ? null : (
            <span className="visually-hidden">
              <AgentStatus state={lead} count={states.get(lead) ?? 0} />
            </span>
          )}
        </a>
        <RoomPeek agents={here} context={context} />
        <Desks
          label={intl.formatMessage({ id: 'office.building.desks' }, { name })}
          seats={HQ_SEATS.map((position, i) => ({
            position,
            agentId: seated[i] ?? null,
            ambient: false,
          })).filter((seat) => seat.agentId !== null)}
          context={context}
          motif="map"
        />
        {withAgent === undefined ? null : (
          <GiaHere
            point={STAND.board}
            aspect={CENTRE_ASPECT}
            view={viewAt(context.gia.activity, false)}
          />
        )}
        <Crew agents={here} context={context} name={name} />
      </>
    );
  }
  return (
    <div
      ref={box}
      className={`b-room b-room--centre b-room--hq${department === undefined ? '' : ' b-room--department'}`}
      style={
        department === undefined
          ? place.style
          : ({ ...place.style, '--zone-hue': lookOf(department).hue } as CSSProperties)
      }
      data-slot={place.slot}
      data-room={department?.id}
    >
      <RoomPicture name="headquarters" width={403} eager={eager} />
      {room}
    </div>
  );
}

/**
 * GIA's room at the heart of the office: her platform with the melon's light behind it, and the
 * whole room is the way to her workplace. She stands on the platform while she is home; when the
 * records put her with an agent she is in that agent's room, and her platform waits for her.
 */
function GiaRoom({
  context,
  eager,
  place,
}: {
  readonly context: RoomContext;
  readonly eager: boolean;
  readonly place: Place;
}) {
  const intl = useIntl();
  const { gia } = context;
  const active = gia.target.coordinating;
  const home = gia.at?.kind === 'home';
  const away = gia.at?.kind === 'department' ? gia.at : undefined;
  const going = gia.going?.kind === 'department' ? gia.going : undefined;
  const label =
    away === undefined
      ? intl.formatMessage({ id: 'office.building.gia' }, { count: active })
      : intl.formatMessage(
          { id: 'office.building.giaWith' },
          {
            agent: gia.agentName(away.agentId),
            department: gia.departmentName(away.departmentId),
          },
        );
  return (
    <div
      className="b-room b-room--centre b-room--gia"
      style={place.style}
      data-slot={place.slot}
      data-gia-state={gia.activity}
      data-gia-home={home ? '' : undefined}
    >
      <RoomPicture name="gia" width={403} eager={eager} />
      <a
        href={paths.gia()}
        className="b-gia"
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          navigate(paths.gia());
        }}
      >
        <span className="b-gia__sphere" aria-hidden="true">
          {/* The office's mind, not a face: a core of light with GIA's mark. */}
          <span className="b-gia__core">
            <Icon name="gia" size={40} />
          </span>
        </span>
        {home ? (
          <GiaHere point={STAND.gia} aspect={CENTRE_ASPECT} view={viewAt(gia.activity, true)} />
        ) : null}
        <span className="b-gia__chip" aria-hidden="true">
          <span className="b-gia__name">
            <FormattedMessage id="gia.name" />
            <span className="b-gia__dot" />
          </span>
          <span className="b-gia__role">
            {away !== undefined ? (
              <FormattedMessage
                id="office.building.giaAway"
                values={{
                  agent: gia.agentName(away.agentId),
                  department: gia.departmentName(away.departmentId),
                }}
              />
            ) : going !== undefined ? (
              <FormattedMessage
                id="office.building.giaGoing"
                values={{ department: gia.departmentName(going.departmentId) }}
              />
            ) : gia.activity === 'returning' ? (
              <FormattedMessage id="office.building.giaReturning" />
            ) : (
              <FormattedMessage id="office.building.giaCoordinates" values={{ count: active }} />
            )}
          </span>
        </span>
      </a>
    </div>
  );
}

function MotorButton({ open, onClick }: { readonly open: boolean; readonly onClick: () => void }) {
  const intl = useIntl();
  return (
    <button
      type="button"
      className="b-motor"
      aria-expanded={open}
      aria-controls="motor-panel"
      aria-label={intl.formatMessage({ id: 'office.motor.open' })}
      onClick={onClick}
    >
      <img className="b-motor__mark" src={MELON_MARK} alt="" width={48} height={48} />
      <span className="b-motor__text" aria-hidden="true">
        <span className="b-motor__name">
          <FormattedMessage id="office.motor.name" />
        </span>
        <span className="b-motor__tagline">
          <FormattedMessage id="office.motor.tagline" />
        </span>
      </span>
    </button>
  );
}

/**
 * The rooms' boxes as laid out, in the office's pixels, measured again whenever the office
 * changes size. Empty until the office has been laid out (and in tests, where nothing is).
 */
function useCells(frame: RefObject<HTMLDivElement | null>, layout: string) {
  const [cells, setCells] = useState<{ cells: Cells; width: number; height: number }>({
    cells: new Map(),
    width: 0,
    height: 0,
  });
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return undefined;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const next = new Map<string, Rect>();
      for (const room of element.querySelectorAll<HTMLElement>('[data-slot]')) {
        const box = room.getBoundingClientRect();
        const slot = room.dataset['slot'];
        if (slot === undefined || box.width === 0) continue;
        next.set(slot, {
          x: box.left - origin.left,
          y: box.top - origin.top,
          w: box.width,
          h: box.height,
        });
      }
      setCells({ cells: next, width: origin.width, height: origin.height });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame, layout]);
  return cells;
}

/**
 * MelonMotor's network: lines of light from the hub between GIA and MelonMotor to GIA, to
 * MelonMotor and to every department. They carry what really happens: pulses run along a
 * department's line while its agents work (one per working agent, up to three, out to the room
 * and back), in coral when something needs the person, and between departments for MelonMotor's
 * real hand-offs; GIA's trunk carries a pulse for each department at work. A department with
 * agents but no work keeps a quiet line; one with nobody active, a faint one. Pointing at a room
 * lights its line. No pulses with reduced motion.
 */
function Circuits({
  floors,
  headquarters,
  cells,
  context,
  motor,
  hot,
}: {
  readonly floors: readonly Floor[];
  readonly headquarters: readonly DepartmentView[];
  readonly cells: { readonly cells: Cells; readonly width: number; readonly height: number };
  readonly context: RoomContext;
  readonly motor: MotorState;
  readonly hot: string | null;
}) {
  const moving = !prefersReducedMotion();
  const net = network(cells.cells);
  if (net === undefined) return null;
  const rooms = departmentRooms(floors, headquarters).flatMap((room) => {
    const route = net.routeTo(room.row, room.column);
    if (route === undefined) return [];
    const department = context.agents.filter(
      (agent) => agent.departmentId === room.id && agent.status !== 'archived',
    );
    const states = new Map<AgentState, number>();
    for (const agent of department) {
      const state = workStateOf(agent, context.work.get(agent.id));
      if (state !== undefined) states.set(state, (states.get(state) ?? 0) + 1);
    }
    return [
      {
        ...room,
        route,
        path: tracePath(route),
        length: routeLength(route),
        level: circuitLevel(states),
        pulses: pulsesFor(states),
      },
    ];
  });
  const active = rooms.filter((room) => room.level === 'busy' || room.level === 'attention');
  const byType = new Map(rooms.map((room) => [room.type, room]));
  const flows = motor.status === 'ready' ? motor.flows : [];
  const trunk = (points: readonly Point[], name: string) => {
    const path = tracePath(points);
    const seconds = routeLength(points) / SPEED;
    return (
      <g className={`circuit circuit--${name} circuit--${active.length > 0 ? 'busy' : 'ready'}`}>
        <path d={path} className="circuit__glow" />
        <path d={path} className="circuit__trace" />
        {moving
          ? active.map((room, i) => (
              <Pulse
                key={room.id}
                path={path}
                seconds={seconds}
                offset={i / Math.max(1, active.length)}
                back={name === 'motor'}
                tone={room.level === 'attention' ? 'coral' : 'light'}
              />
            ))
          : null}
      </g>
    );
  };
  return (
    <svg
      className="circuits"
      viewBox={`0 0 ${Math.round(cells.width)} ${Math.round(cells.height)}`}
      aria-hidden="true"
      focusable="false"
    >
      {trunk(net.gia, 'gia')}
      {trunk(net.motor, 'motor')}
      {rooms.map((room) => {
        const seconds = room.length / SPEED;
        const end = room.route[room.route.length - 1] ?? net.hub;
        return (
          <g
            key={room.id}
            className={`circuit circuit--${room.level}${hot === room.id ? ' circuit--hot' : ''}`}
          >
            <path d={room.path} className="circuit__glow" />
            <path d={room.path} className="circuit__trace" />
            <circle cx={end.x} cy={end.y} r="3" className="circuit__node" />
            {moving && room.level === 'busy'
              ? Array.from({ length: room.pulses }, (_, i) => (
                  <Pulse
                    key={i}
                    path={room.path}
                    seconds={seconds}
                    offset={i / room.pulses}
                    tone="light"
                  />
                )).concat(
                  <Pulse key="back" path={room.path} seconds={seconds * 1.3} offset={0.5} back />,
                )
              : null}
            {moving && room.level === 'attention' ? (
              <>
                <Pulse path={room.path} seconds={seconds} offset={0} back tone="coral" />
                <Pulse path={room.path} seconds={seconds} offset={0.5} back tone="coral" />
              </>
            ) : null}
            {moving && hot === room.id && room.level !== 'busy' && room.level !== 'attention' ? (
              <Pulse path={room.path} seconds={seconds * 0.8} offset={0} tone="scan" />
            ) : null}
          </g>
        );
      })}
      {flows.map((flow, i) => {
        const from = byType.get(flow.from);
        const to = byType.get(flow.to);
        if (from === undefined || to === undefined) return null;
        const route = [...from.route].reverse().concat(to.route.slice(1));
        const path = tracePath(route);
        return (
          <g key={`${flow.planId}-${i}`} className="circuit circuit--flow">
            <path d={path} className="circuit__trace" />
            {moving ? (
              <Pulse path={path} seconds={routeLength(route) / SPEED} offset={0} tone="coral" />
            ) : null}
          </g>
        );
      })}
      <circle cx={net.hub.x} cy={net.hub.y} r="5" className="circuit__core" />
    </svg>
  );
}

/** Pixels a pulse travels in a second. */
const SPEED = 140;

/** A packet of light running along a circuit, `offset` of the way through its cycle. */
function Pulse({
  path,
  seconds,
  offset,
  back = false,
  tone = 'light',
}: {
  readonly path: string;
  readonly seconds: number;
  readonly offset: number;
  readonly back?: boolean;
  readonly tone?: 'light' | 'coral' | 'scan';
}) {
  const dur = Math.max(1.2, seconds);
  return (
    <g className={`circuit__pulse circuit__pulse--${tone}`}>
      <circle r="7" className="circuit__halo" />
      <circle r="2.4" className="circuit__dot" />
      <animateMotion
        dur={`${dur.toFixed(2)}s`}
        begin={`${(-offset * dur).toFixed(2)}s`}
        repeatCount="indefinite"
        path={path}
        keyPoints={back ? '1;0' : '0;1'}
        keyTimes="0;1"
        calcMode="linear"
      />
    </g>
  );
}
