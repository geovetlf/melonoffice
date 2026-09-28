import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useRef, type CSSProperties } from 'react';
import { paths } from '../shell/routes.js';
import { AgentStatus } from './agents.js';
import {
  agentsOf,
  departmentName,
  lookOf,
  officeDepartments,
  officeSlug,
  type DepartmentAgents,
} from './departments.js';
import { Icon } from './icons.js';
import type { DepartmentView, SpecialistView } from './officeClient.js';
import { readyList, useOfficeData } from './OfficeData.js';
import { RoomArt } from './RoomArt.js';
import { navigateInto } from './transition.js';
import { roomSeats, seatAgents, type DepartmentSeating } from './workstations.js';

/**
 * The office, seen whole (ADR-0040, level 1): the organization's departments as rooms of one
 * building, headquarters on the top floor. Each room is a link into that department's office.
 */
export function OfficeScene() {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const agents = readyList(specialists);
  const { headquarters, floor } = officeDepartments(readyList(departments));
  return (
    <section className="office-scene" aria-labelledby="office-scene-title">
      <h2 id="office-scene-title" className="visually-hidden">
        <FormattedMessage id="office.scene.title" />
      </h2>
      <Skyline />
      {departments.status === 'loading' ? (
        <p className="office-scene__notice" role="status">
          <FormattedMessage id="office.scene.loading" />
        </p>
      ) : departments.status !== 'ready' ? (
        <p className="office-scene__notice">
          <FormattedMessage
            id={
              departments.status === 'hidden' ? 'office.scene.hidden' : 'office.scene.unavailable'
            }
          />
        </p>
      ) : (
        <div
          className="office-scene__viewport"
          tabIndex={-1}
          aria-label={intl.formatMessage({ id: 'office.scene.rooms' })}
        >
          {headquarters.length > 0 ? (
            <ul className="office-scene__tier office-scene__tier--top">
              {headquarters.map((department) => (
                <DepartmentZone key={department.id} department={department} agents={agents} />
              ))}
            </ul>
          ) : null}
          <ul className="office-scene__tier">
            {floor.map((department) => (
              <DepartmentZone key={department.id} department={department} agents={agents} />
            ))}
          </ul>
        </div>
      )}
      <p className="office-scene__hint" aria-hidden="true">
        <FormattedMessage id="office.scene.swipe" />
      </p>
    </section>
  );
}

/** One room of the office, and the way into its department's office. */
export function DepartmentZone({
  department,
  agents,
}: {
  readonly department: DepartmentView;
  readonly agents: readonly SpecialistView[];
}) {
  const intl = useIntl();
  const room = useRef<HTMLSpanElement>(null);
  const look = lookOf(department);
  const name = departmentName(intl, department);
  const here = agentsOf(department, agents);
  const seating = seatAgents(department, agents);
  const href = paths.office(officeSlug(department));
  return (
    <li className="zone" style={{ '--zone-hue': look.hue } as CSSProperties}>
      <a
        href={href}
        className="zone__link"
        aria-label={intl.formatMessage(
          { id: 'office.zone.enter' },
          { name, agents: `${agentsSummary(intl, here)}. ${seatsSummary(intl, seating)}` },
        )}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigateInto(href, room.current);
        }}
      >
        <span className="zone__room" ref={room}>
          <RoomArt motif={look.motif} hue={look.hue} seats={roomSeats(seating, agents)} />
        </span>
        {look.headquarters === true ? (
          // GIA's place is in Consejo y Dirección (ADR-0005).
          <span className="zone__gia" aria-hidden="true">
            <Icon name="gia" size={14} />
            <FormattedMessage id="gia.name" />
          </span>
        ) : null}
        <span className="zone__sign">
          <Icon name={look.icon} size={18} />
          <span className="zone__name">{name}</span>
        </span>
        <span className="zone__meta">
          <span className="zone__seats" aria-hidden="true">
            <Icon name="seat" size={14} />
            <FormattedMessage
              id="office.seats.short"
              values={{ occupied: seating.occupied, total: seating.workstations.length }}
            />
          </span>
          {here.state === undefined ? (
            <span className="zone__empty">
              <FormattedMessage id="office.zone.noAgents" />
            </span>
          ) : (
            <AgentStatus
              state={here.state}
              count={here.state === 'paused' ? here.paused : here.active}
            />
          )}
          <span className="zone__enter" aria-hidden="true">
            <FormattedMessage id="office.zone.enterShort" />
            <Icon name="chevron" size={14} />
          </span>
        </span>
      </a>
    </li>
  );
}

export function agentsSummary(intl: ReturnType<typeof useIntl>, here: DepartmentAgents): string {
  if (here.active > 0)
    return intl.formatMessage({ id: 'office.agents.active' }, { count: here.active });
  if (here.paused > 0)
    return intl.formatMessage({ id: 'office.agents.paused' }, { count: here.paused });
  return intl.formatMessage({ id: 'office.zone.noAgents' });
}

/** How many of a department's workstations are taken, in words. */
export function seatsSummary(intl: ReturnType<typeof useIntl>, seating: DepartmentSeating): string {
  return intl.formatMessage(
    { id: 'office.seats.summary' },
    { occupied: seating.occupied, total: seating.workstations.length },
  );
}

/** The city behind the office at dusk: background only. */
function Skyline() {
  // x and height, in % of the sky: the city stands on the horizon at 58%.
  const towers = [
    [4, 22],
    [9, 30],
    [14, 18],
    [19, 34],
    [24, 26],
    [30, 40],
    [36, 28],
    [42, 32],
    [48, 44],
    [53, 36],
    [58, 30],
    [63, 42],
    [69, 26],
    [74, 38],
    [80, 30],
    [85, 44],
    [90, 24],
    [95, 34],
  ] as const;
  return (
    <svg
      className="office-scene__skyline"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="mo-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b2433" />
          <stop offset="0.55" stopColor="#b3563c" />
          <stop offset="1" stopColor="#f2a15f" />
        </linearGradient>
        <radialGradient id="mo-sun" cx="0.5" cy="1" r="0.6">
          <stop offset="0" stopColor="#ffd08a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffd08a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill="url(#mo-sky)" />
      <rect width="100" height="100" fill="url(#mo-sun)" />
      {towers.map(([x, height]) => (
        <rect
          key={x}
          x={x - 2.2}
          y={58 - height}
          width="4.4"
          height={height}
          fill="#2a1a22"
          opacity={0.3 + (height % 3) * 0.1}
        />
      ))}
    </svg>
  );
}
