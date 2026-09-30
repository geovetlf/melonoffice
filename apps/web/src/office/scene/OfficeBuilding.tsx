import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { GiaAvatar } from '../../gia/GiaAvatar.js';
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
import { agentAt, seatAgents, type SeatPosition } from '../workstations.js';
import { isCurrentTask, workStateOf, type AgentWork } from './agentWork.js';
import {
  BUILDING_WIDTH,
  circuitLevel,
  corePoint,
  departmentRooms,
  giaPoint,
  pulsesFor,
  routeLength,
  routeTo,
  routeToGia,
  tracePath,
} from './circuits.js';
import { buildingFloors, type CentreRoom, type Floor, type SideRoom } from './layout.js';
import type { MotorState } from './motor.js';
import { MELON_MARK } from '../../shell/mark.js';
import { Workstation, type DeskOccupant } from './Workstation.js';

/**
 * The Home's office (Home V4): the organization's building, seen whole. Three layers, kept apart:
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
  const context: RoomContext = { agents, work, onAgent };
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
            className="building__frame"
            style={{ '--floors': floors.length } as CSSProperties}
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
            <Circuits floors={floors} context={context} motor={motor} hot={hot} />
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
  const place = (column: number) => ({ '--row': index + 1, '--column': column }) as CSSProperties;
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
  // picture's: headquarters (and GIA) come first, then the floors left to right.
  return floor.centre === 'headquarters' ? (
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
      sizes="(max-width: 48rem) 50vw, 25vw"
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

/** Where a room sits in the building's grid (its floor and column). */
type Place = CSSProperties;

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
      <div className="b-room b-room--side b-room--meeting" style={place} aria-hidden="true">
        <RoomPicture name="room-meeting" width={480} eager={eager} />
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
  return (
    <div
      ref={box}
      className={`b-room b-room--side b-room--department${lead === undefined ? '' : ` b-room--${lead}`}`}
      style={{ ...place, '--zone-hue': look.hue } as CSSProperties}
      data-room={department.id}
    >
      <RoomPicture name={`room-${motif}`} width={480} eager={eager} />
      <WallScreen
        name={name}
        icon={look.icon}
        agents={here.length}
        lead={lead}
        task={current?.request}
      />
      <a
        href={href}
        className="b-room__link"
        aria-label={enterLabel(intl, department, context, states, current?.request)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigateInto(href, box.current);
        }}
      >
        <span className="b-room__sign" aria-hidden="true">
          <span className="b-room__icon">
            <Icon name={look.icon} size={16} />
          </span>
          <span className="b-room__name">{name}</span>
          <span className="b-room__count">
            <FormattedMessage id="office.building.agents" values={{ count: here.length }} />
          </span>
          <Icon name="chevron" size={14} className="b-room__go" />
        </span>
      </a>
      <span className="b-room__status" aria-hidden="true">
        {current !== undefined ? (
          <>
            <span className={`b-room__dot b-room__dot--${lead ?? 'available'}`} />
            <span className="b-room__task">{current.request}</span>
          </>
        ) : lead !== undefined ? (
          <AgentStatus state={lead} count={states.get(lead) ?? 0} />
        ) : (
          <span className="b-room__task">
            <FormattedMessage id="office.zone.noAgents" />
          </span>
        )}
      </span>
      <Desks
        label={intl.formatMessage({ id: 'office.building.desks' }, { name })}
        seats={seating.workstations.map((workstation) => ({
          position: workstation.position,
          agentId: agentAt(workstation),
          ambient: workstation.occupant?.kind === 'ambient',
        }))}
        context={context}
        motif={motif}
      />
      <Crew agents={here} context={context} name={name} />
    </div>
  );
}

/**
 * The department's big screen: what its agents are really doing. With a task under way it shows
 * the task in the words it was asked; otherwise the department's name, resting. Never a figure
 * or a chart that the records do not hold.
 */
function WallScreen({
  name,
  icon,
  agents,
  lead,
  task,
}: {
  readonly name: string;
  readonly icon: ReturnType<typeof lookOf>['icon'];
  readonly agents: number;
  readonly lead: AgentState | undefined;
  readonly task: string | undefined;
}) {
  return (
    <div
      className={`wall-screen${task === undefined ? ' wall-screen--idle' : ''}${lead === 'working' ? ' wall-screen--working' : ''}`}
      aria-hidden="true"
    >
      <span className="wall-screen__head">
        <Icon name={icon} size={12} />
        <span>{name}</span>
      </span>
      {task !== undefined ? (
        <>
          <span className="wall-screen__task">{task}</span>
          {lead === undefined ? null : (
            <span className="wall-screen__state">
              <FormattedMessage id={`office.agentState.${lead}`} />
            </span>
          )}
          {lead === 'working' ? <span className="wall-screen__bar" /> : null}
        </>
      ) : (
        <span className="wall-screen__rest">
          <FormattedMessage id={agents === 0 ? 'office.zone.noAgents' : 'office.building.noTask'} />
        </span>
      )}
    </div>
  );
}

interface DeskSeat {
  readonly position: SeatPosition;
  readonly agentId: string | null;
  readonly ambient: boolean;
}

/** The room's workstations, where the drawing puts them; a real agent's is a button. */
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
  const rows = new Set(seats.map((seat) => seat.position.row)).size || 1;
  return (
    <ul className="b-room__desks" aria-label={label}>
      {seats.map((seat, i) => {
        const perRow = seats.filter((s) => s.position.row === seat.position.row).length || 1;
        const depth = 1 - (rows - 1 - seat.position.row) * 0.12;
        const width = Math.min(21, 66 / perRow) * depth;
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
          '--desk-w': `${width}%`,
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

/** Where the leadership's agents sit in headquarters, either side of GIA's desk. */
const HQ_SEATS: readonly SeatPosition[] = [
  { x: 0.2, y: 0.9, row: 1 },
  { x: 0.8, y: 0.9, row: 1 },
];

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
  if (kind === 'motor') {
    return (
      <div className="b-room b-room--centre b-room--motor" style={place}>
        <RoomPicture name="atrium" width={320} eager={eager} />
        <MotorButton open={motorOpen} onClick={onMotor} />
      </div>
    );
  }
  return (
    <div className="b-room b-room--centre b-room--lounge" style={place} aria-hidden="true">
      <RoomPicture name="lounge" width={320} eager={eager} />
    </div>
  );
}

/**
 * Consejo y Dirección, where GIA sits (ADR-0005): her desk at the centre, the department's own
 * agents either side. With no leadership department, the room is still GIA's.
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
  const active = context.agents.filter((agent) => agent.status === 'active').length;
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
          <span className="b-room__sign b-room__sign--centre" aria-hidden="true">
            <span className="b-room__icon">
              <Icon name={lookOf(department).icon} size={16} />
            </span>
            <span className="b-room__name">{name}</span>
            <span className="b-room__count">
              <FormattedMessage id="office.building.agents" values={{ count: here.length }} />
            </span>
            <Icon name="chevron" size={14} className="b-room__go" />
          </span>
          {lead === undefined ? null : (
            <span className="visually-hidden">
              <AgentStatus state={lead} count={states.get(lead) ?? 0} />
            </span>
          )}
        </a>
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
          ? place
          : ({ ...place, '--zone-hue': lookOf(department).hue } as CSSProperties)
      }
    >
      <RoomPicture name="headquarters" width={320} eager={eager} />
      {room}
      <a
        href={paths.gia()}
        className="b-gia"
        aria-label={intl.formatMessage({ id: 'office.building.gia' }, { count: active })}
        onClick={(event) => {
          event.preventDefault();
          navigate(paths.gia());
        }}
      >
        {/* GIA herself is in the room's art; this is the part of the link over her. */}
        <span className="b-gia__figure" aria-hidden="true" />
        <span className="b-gia__chip" aria-hidden="true">
          <GiaAvatar size={28} decorative className="b-gia__avatar" />
          <span className="b-gia__name">
            <FormattedMessage id="gia.name" />
          </span>
          <span className="b-gia__online">
            <span className="b-gia__dot" />
            <FormattedMessage id="office.building.giaOnline" />
          </span>
          <span className="b-gia__role">
            <FormattedMessage id="office.building.giaCoordinates" values={{ count: active }} />
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
 * MelonMotor's circuits: lines of light from the core in the atrium to GIA and to every
 * department's screen. They carry what really happens: pulses run along a department's line
 * while its agents work (one per working agent, up to three, out to the room and back), in coral
 * when something needs the person, and between departments for MelonMotor's real hand-offs. A
 * department with agents but no work keeps a quiet line; one with nobody active, a faint one.
 * Pointing at a room lights its line. No pulses with reduced motion.
 */
function Circuits({
  floors,
  context,
  motor,
  hot,
}: {
  readonly floors: readonly Floor[];
  readonly context: RoomContext;
  readonly motor: MotorState;
  readonly hot: string | null;
}) {
  const moving = !prefersReducedMotion();
  const rooms = departmentRooms(floors).map((room) => {
    const department = context.agents.filter(
      (agent) => agent.departmentId === room.id && agent.status !== 'archived',
    );
    const states = new Map<AgentState, number>();
    for (const agent of department) {
      const state = workStateOf(agent, context.work.get(agent.id));
      if (state !== undefined) states.set(state, (states.get(state) ?? 0) + 1);
    }
    const route = routeTo(room.floor, room.side);
    return {
      ...room,
      route,
      path: tracePath(route),
      length: routeLength(route),
      level: circuitLevel(states),
      pulses: pulsesFor(states),
    };
  });
  const active = rooms.filter((room) => room.level === 'busy' || room.level === 'attention');
  const toGia = routeToGia();
  const giaPath = tracePath(toGia);
  const giaLength = routeLength(toGia);
  const byType = new Map(rooms.map((room) => [room.type, room]));
  const flows = motor.status === 'ready' ? motor.flows : [];
  const core = corePoint();
  const gia = giaPoint();
  return (
    <svg
      className="circuits"
      viewBox={`0 0 ${BUILDING_WIDTH} ${floors.length * 100}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className={`circuit circuit--gia circuit--${active.length > 0 ? 'busy' : 'ready'}`}>
        <path d={giaPath} className="circuit__glow" />
        <path d={giaPath} className="circuit__trace" />
        <circle cx={gia.x} cy={gia.y} r="1.6" className="circuit__node" />
        {moving
          ? active.map((room, i) => (
              <Pulse
                key={room.id}
                path={giaPath}
                seconds={giaLength / SPEED}
                offset={i / Math.max(1, active.length)}
                back={i % 2 === 1}
                tone={room.level === 'attention' ? 'coral' : 'light'}
              />
            ))
          : null}
      </g>
      {rooms.map((room) => {
        const seconds = room.length / SPEED;
        const end = room.route[room.route.length - 1] ?? core;
        return (
          <g
            key={room.id}
            className={`circuit circuit--${room.level}${hot === room.id ? ' circuit--hot' : ''}`}
          >
            <path d={room.path} className="circuit__glow" />
            <path d={room.path} className="circuit__trace" />
            <circle cx={end.x} cy={end.y} r="1.6" className="circuit__node" />
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
      <circle cx={core.x} cy={core.y} r="2.4" className="circuit__core" />
    </svg>
  );
}

/** Drawing units a pulse travels in a second. */
const SPEED = 70;

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
      <circle r="3.2" className="circuit__halo" />
      <circle r="1.2" className="circuit__dot" />
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
