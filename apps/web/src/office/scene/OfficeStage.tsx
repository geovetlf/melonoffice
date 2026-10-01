import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import type { CSSProperties } from 'react';
import { GiaFigure } from '../../gia/character.js';
import { giaTarget, useGiaEngagements, type GiaTarget } from '../../gia/presence.js';
import { navigate } from '../../identity/router.js';
import { paths } from '../../shell/routes.js';
import { agentsOf, departmentName, lookOf, officeSlug, type AgentState } from '../departments.js';
import { Icon, type IconName } from '../icons.js';
import type { DepartmentView, SpecialistView } from '../officeClient.js';
import { readyList, useOfficeData } from '../OfficeData.js';
import { agentsSummary } from '../OfficeScene.js';
import { isCurrentTask, workStateOf, type AgentWork } from './agentWork.js';
import type { MotorState } from './motor.js';
import {
  DESKS,
  GIA_AT_DESK,
  LOGO,
  MAX_ZOOM,
  SCENE,
  SCENE_ASPECT,
  SEATS,
  WALL_PANELS,
  type SceneBox,
  type ScenePoint,
  type SceneSeat,
  type SeatKey,
} from './officeScene.js';
import { useStageZoom } from './useStageZoom.js';

const ART = import.meta.glob<string>(['./art/office-empty.webp', './art/people/*.webp'], {
  eager: true,
  import: 'default',
});
const art = (name: string) => ART[`./art/${name}.webp`] ?? '';

/** The office's own figures, for its glass wall: all of them read from its records. */
export interface StageFigures {
  readonly active: number;
  readonly working: number;
  /** What waits on the person; unknown while it is read, or when the role cannot read it. */
  readonly attention: number | undefined;
  /** Whether the agents could be read at all. */
  readonly agentsKnown: boolean;
}

/**
 * The Home's office (`officeScene.ts`): an open office, GIA's desk in the centre and six desks
 * around it, the glass wall behind. Its layers, back to front, all in one "world" that zooms and
 * pans as one (`useStageZoom`), each placed at points of the picture:
 *
 * 1. the office, empty: the architecture, the glass wall, the desks and their chairs;
 * 2. the people: at each department's desk, the person the render drew there, a picture of the
 *    office at work and no agent (a real agent is its own control, 6.); GIA, her official figure,
 *    at her desk, or standing beside the desk of the agent her real task is with
 *    (`gia/presence.ts`): she is simply there, no walk;
 * 3. the glass wall's figures: the office's real ones, and MelonMotor's flows, which open it;
 * 4. the light of the MelonOffice mark, rising and falling very slowly (not with reduced motion);
 * 5. the desks' name plates: the organization's real departments;
 * 6. the controls: each desk is the way into its department's office (GIA's into her workplace),
 *    the same pages and routes as the menu; each real agent drawn opens its card;
 * 7. the places of GIA and the agents, for the routes GIA will walk (`GIA_ROUTES`).
 */
export function OfficeStage({
  figures,
  work,
  motor,
  motorOpen,
  onMotor,
  onAgent,
}: {
  readonly figures: StageFigures;
  readonly work: AgentWork;
  readonly motor: MotorState;
  readonly motorOpen: boolean;
  readonly onMotor: () => void;
  /** Opens an agent's card; the element is where focus returns when it closes. */
  readonly onAgent: (agentId: string, from: HTMLElement) => void;
}) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const ready = readyList(departments);
  const agents = readyList(specialists);
  const { frame, world, scale, zoomIn, zoomOut, reset } = useStageZoom(SCENE_ASPECT, MAX_ZOOM);

  // GIA: where her real tasks put her. A department with no desk here cannot hold her.
  const engagements = useGiaEngagements();
  const asked = giaTarget(engagements, agents, work);
  const withDepartment =
    asked.place.kind === 'department'
      ? ready.find((d) => asked.place.kind === 'department' && d.id === asked.place.departmentId)
      : undefined;
  const away =
    withDepartment === undefined
      ? undefined
      : DESKS.find((key) => key !== 'gia' && SEATS[key].department === withDepartment.typeId);
  const gia: GiaTarget =
    asked.place.kind === 'department' && away === undefined
      ? {
          ...asked,
          place: { kind: 'home' },
          activity: asked.coordinating > 0 ? 'coordinating' : 'idle',
        }
      : asked;
  const giaWith = gia.place.kind === 'department' ? gia.place.agentId : undefined;
  const nameOf = (agentId: string) => agents.find((a) => a.id === agentId)?.displayName ?? '';

  const desks = DESKS.flatMap((key): readonly Desk[] => {
    const seat = SEATS[key];
    if (key === 'gia') {
      return [
        {
          key,
          seat,
          href: paths.gia(),
          label:
            giaWith === undefined || withDepartment === undefined
              ? intl.formatMessage({ id: 'office.building.gia' }, { count: figures.active })
              : intl.formatMessage(
                  { id: 'office.building.giaWith' },
                  { agent: nameOf(giaWith), department: departmentName(intl, withDepartment) },
                ),
          icon: 'gia',
          name: intl.formatMessage({ id: 'gia.name' }),
          line: intl.formatMessage({ id: 'gia.role' }),
          lead: undefined,
        },
      ];
    }
    const department = ready.find((d) => d.typeId === seat.department);
    if (department === undefined) return [];
    const name = departmentName(intl, department);
    const here = agentsSummary(intl, agentsOf(department, agents));
    const enter = intl.formatMessage({ id: 'office.zone.enter' }, { name, agents: here });
    const giaHere =
      away === key && giaWith !== undefined
        ? intl.formatMessage({ id: 'office.building.giaHere' }, { agent: nameOf(giaWith) })
        : undefined;
    return [
      {
        key,
        seat,
        href: paths.office(officeSlug(department)),
        label: giaHere === undefined ? enter : `${enter}. ${giaHere}`,
        icon: lookOf(department).icon,
        name,
        line: specialists.status === 'ready' ? here : '',
        lead: leadOf(department, agents, work),
      },
    ];
  });

  return (
    <section
      className="stage"
      aria-labelledby="stage-title"
      style={{ '--scene-aspect': SCENE_ASPECT } as CSSProperties}
    >
      <h2 id="stage-title" className="visually-hidden">
        <FormattedMessage id="office.scene.title" />
      </h2>
      {/* The departments the role may not read, or that could not be read, are said as such. */}
      {departments.status === 'hidden' || departments.status === 'unavailable' ? (
        <p className="building__notice building__notice--inline">
          <FormattedMessage
            id={
              departments.status === 'hidden' ? 'office.scene.hidden' : 'office.scene.unavailable'
            }
          />
        </p>
      ) : null}
      <div
        ref={frame}
        className="stage__frame"
        data-zoomed={scale > 1 ? '' : undefined}
        data-gia-activity={gia.activity}
      >
        <div ref={world} className="stage__world">
          {/* 1. The office, empty. */}
          <img
            className="stage__render"
            src={art(SCENE.name)}
            width={SCENE.width}
            height={SCENE.height}
            alt={intl.formatMessage({ id: 'office.stage.alt' })}
            decoding="async"
            draggable={false}
          />
          {/*
           * 2. The people. At each of the six desks, the person the render drew there: the
           *    office at work, a picture only, with no name, state or card. A real agent of that
           *    department is said by its own control over them (6.), never by the picture.
           *    GIA, her official figure: at her desk, or beside the agent her real task is with.
           */}
          <span className="stage__people" aria-hidden="true">
            {DESKS.map((key) =>
              key === 'gia' ? null : (
                <img
                  key={key}
                  className="stage__person"
                  data-person={key}
                  data-agent={
                    desks.find((desk) => desk.key === key)?.lead === undefined ? undefined : ''
                  }
                  src={art(`people/${key}`)}
                  style={boxStyle(SEATS[key].figure)}
                  alt=""
                  draggable={false}
                />
              ),
            )}
            {away === undefined ? (
              <span className="stage__gia-desk" data-person="gia" style={giaDeskStyle}>
                <GiaFigure
                  view="front"
                  height={`${((GIA_AT_DESK.height / (GIA_AT_DESK.cut - GIA_AT_DESK.top)) * 100).toFixed(2)}%`}
                  eager
                />
              </span>
            ) : (
              <span
                className="stage__gia-away"
                data-gia-at={away}
                style={standStyle(SEATS[away].stand, SEATS[away].height)}
              >
                <GiaFigure
                  view={gia.activity === 'working' ? 'three-quarter' : 'front'}
                  height="100%"
                />
              </span>
            )}
          </span>
          {/* 3. The glass wall's figures, and MelonMotor. */}
          <div className="stage__wall">
            <div className="stage__panel" style={boxStyle(WALL_PANELS.left)}>
              <p className="stage__panel-title">
                <FormattedMessage id="office.wall.today" />
              </p>
              {figures.agentsKnown ? (
                <ul className="stage__panel-list">
                  <li>
                    <FormattedMessage
                      id="office.agents.active"
                      values={{ count: figures.active }}
                    />
                  </li>
                  <li>
                    <FormattedMessage id="home.chips.working" values={{ count: figures.working }} />
                  </li>
                  {figures.attention === undefined ? null : (
                    <li>
                      <FormattedMessage
                        id="home.chips.attention"
                        values={{ count: figures.attention }}
                      />
                    </li>
                  )}
                </ul>
              ) : null}
            </div>
            <button
              type="button"
              className="stage__panel stage__panel--motor"
              style={boxStyle(WALL_PANELS.right)}
              aria-expanded={motorOpen}
              aria-controls="motor-panel"
              aria-label={intl.formatMessage({ id: 'office.motor.open' })}
              onClick={onMotor}
            >
              <span className="stage__panel-title" aria-hidden="true">
                <FormattedMessage id="office.motor.name" />
              </span>
              <span className="stage__panel-list" aria-hidden="true">
                <span className="stage__panel-item">
                  {motor.status === 'ready' ? (
                    <FormattedMessage id="office.wall.flows" values={{ count: motor.running }} />
                  ) : (
                    <FormattedMessage id="office.motor.tagline" />
                  )}
                </span>
              </span>
            </button>
          </div>
          {/* 4. The mark's light. */}
          <span className="stage__logo" aria-hidden="true" style={boxStyle(LOGO.box)} />
          {/* 5. The name plates. */}
          <span className="stage__plates" aria-hidden="true">
            {desks.map((desk) => (
              <span
                key={desk.key}
                className={`stage__plate${desk.key === 'gia' ? ' stage__plate--gia' : ''}`}
                data-plate={desk.key}
                style={boxStyle(desk.seat.plate)}
              >
                <span className="stage__plate-icon">
                  <Icon name={desk.icon} size={16} />
                </span>
                <span className="stage__plate-text">
                  <span className="stage__plate-name">{desk.name}</span>
                  {desk.line === '' ? null : <span className="stage__plate-line">{desk.line}</span>}
                </span>
                <span className="stage__plate-go">
                  <Icon name="chevron" size={12} />
                </span>
              </span>
            ))}
          </span>
          {/* 6. The controls: the desks, then the agents at them. */}
          <div
            className="stage__desks"
            role="group"
            aria-label={intl.formatMessage({ id: 'office.scene.rooms' })}
          >
            {desks.map((desk) => (
              <a
                key={desk.key}
                href={desk.href}
                className={`stage__desk${desk.key === 'gia' ? ' stage__desk--gia' : ''}`}
                data-desk={desk.key}
                draggable={false}
                style={boxStyle(desk.seat.desk)}
                aria-label={desk.label}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  navigate(desk.href);
                }}
              />
            ))}
            {desks.map((desk) => {
              const lead = desk.lead;
              if (lead === undefined) return null;
              const task = work.get(lead.agent.id);
              const state = intl.formatMessage({ id: `office.agentState.${lead.state}` });
              return (
                <button
                  key={desk.key}
                  type="button"
                  className={`stage__agent stage__agent--${lead.state}`}
                  data-agent={lead.agent.id}
                  style={figureStyle(desk.seat.figure)}
                  aria-label={intl.formatMessage(
                    { id: 'office.building.agent' },
                    {
                      name: lead.agent.displayName,
                      state,
                      task: isCurrentTask(task)
                        ? task.request
                        : intl.formatMessage({ id: 'office.building.noTask' }),
                    },
                  )}
                  onClick={(event) => onAgent(lead.agent.id, event.currentTarget)}
                >
                  <span className="stage__tip" aria-hidden="true">
                    <span className="stage__tip-name">{lead.agent.displayName}</span>
                    <span className="stage__tip-state">{state}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {/* 7. The places, for the routes. */}
          <span className="stage__anchors" aria-hidden="true">
            {Object.entries(SEATS).map(([key, seat]) => (
              <span
                key={key}
                className="stage__anchor"
                data-anchor={key}
                data-department={seat.department ?? undefined}
                style={pointStyle(seat.stand)}
              />
            ))}
          </span>
        </div>
        <div
          className="stage__zoom"
          role="group"
          aria-label={intl.formatMessage({ id: 'office.zoom.label' })}
        >
          <button
            type="button"
            className="stage__zoom-button"
            aria-label={intl.formatMessage({ id: 'office.zoom.in' })}
            disabled={scale >= MAX_ZOOM}
            onClick={zoomIn}
          >
            <Icon name="plus" size={18} />
          </button>
          <button
            type="button"
            className="stage__zoom-button"
            aria-label={intl.formatMessage({ id: 'office.zoom.out' })}
            disabled={scale <= 1}
            onClick={zoomOut}
          >
            <Icon name="minus" size={18} />
          </button>
          <button
            type="button"
            className="stage__zoom-button"
            aria-label={intl.formatMessage({ id: 'office.zoom.reset' })}
            disabled={scale <= 1}
            onClick={reset}
          >
            <Icon name="fit" size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}

/** The agent a desk shows: one figure per desk, so its department's first agent by state. */
interface Lead {
  readonly agent: SpecialistView;
  readonly state: AgentState;
}

/** The order a desk's agent is picked in: the one at work first, paused last. */
const STATE_ORDER: readonly AgentState[] = [
  'attention',
  'working',
  'processing',
  'waiting',
  'available',
  'paused',
];

/**
 * The real agent a department's desk shows, or none: an active or paused agent of that
 * department. A draft, offline or archived agent is no one at a desk, and nobody is made up.
 */
function leadOf(
  department: DepartmentView,
  agents: readonly SpecialistView[],
  work: AgentWork,
): Lead | undefined {
  const rank = (state: AgentState) => {
    const at = STATE_ORDER.indexOf(state);
    return at === -1 ? STATE_ORDER.length : at;
  };
  return agents
    .filter(
      (agent) =>
        agent.departmentId === department.id &&
        (agent.status === 'active' || agent.status === 'paused'),
    )
    .flatMap((agent): Lead[] => {
      const state = workStateOf(agent, work.get(agent.id));
      return state === undefined ? [] : [{ agent, state }];
    })
    .sort((a, b) => rank(a.state) - rank(b.state))[0];
}

/** A desk that leads somewhere, and what its plate and its link say. */
interface Desk {
  readonly key: SeatKey;
  readonly seat: SceneSeat;
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly name: string;
  readonly line: string;
  /** The real agent drawn at it, if any. */
  readonly lead: Lead | undefined;
}

/** A point of the picture, as percentages of the world. */
const pointStyle = ([x, y]: ScenePoint) =>
  ({ left: `${x * 100}%`, top: `${y * 100}%` }) as CSSProperties;

/** A box of the picture, as percentages of the world. */
const boxStyle = ([left, top, right, bottom]: SceneBox) =>
  ({
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${(right - left) * 100}%`,
    height: `${(bottom - top) * 100}%`,
  }) as CSSProperties;

/**
 * A person, as a target: the figure's box, grown upwards when it must be 44 px tall, so it never
 * covers the plate on the desk in front of them.
 */
const figureStyle = ([left, top, right, bottom]: SceneBox) =>
  ({
    left: `${left * 100}%`,
    bottom: `${(1 - bottom) * 100}%`,
    width: `${(right - left) * 100}%`,
    height: `${(bottom - top) * 100}%`,
  }) as CSSProperties;

/** GIA at her desk: the part of her above its top. */
const giaDeskStyle = {
  left: `${GIA_AT_DESK.x * 100}%`,
  top: `${GIA_AT_DESK.top * 100}%`,
  height: `${(GIA_AT_DESK.cut - GIA_AT_DESK.top) * 100}%`,
} as CSSProperties;

/** A person standing at a point of the floor, `height` of the picture tall. */
const standStyle = ([x, y]: ScenePoint, height: number) =>
  ({
    left: `${x * 100}%`,
    top: `${(y - height) * 100}%`,
    height: `${height * 100}%`,
  }) as CSSProperties;
