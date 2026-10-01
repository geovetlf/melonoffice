import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { paths } from '../shell/routes.js';
import { AgentAvatar, AgentPresence, AgentStatus } from './agents.js';
import { lookOf } from './departments.js';
import { Icon } from './icons.js';
import type { DepartmentView, SpecialistView } from './officeClient.js';
import { RoomArt } from './RoomArt.js';
import { ROOM_TRANSITION, navigateInto } from './transition.js';
import {
  agentAt,
  presenceOf,
  roomSeats,
  type DepartmentSeating,
  type Workstation,
} from './workstations.js';

/**
 * A department's office floor (ADR-0041): the room, entered, with each workstation a place the
 * person can point at. On a wide screen the workstations sit on the drawn desks; on a phone the
 * same list flows as cards under the room. An occupied workstation opens its agent; a free one
 * shows what can be done with it, all of it still to come.
 */
export function WorkstationMap({
  department,
  slug,
  seating,
  specialists,
}: {
  readonly department: DepartmentView;
  readonly slug: string;
  readonly seating: DepartmentSeating;
  readonly specialists: readonly SpecialistView[];
}) {
  const intl = useIntl();
  const [open, setOpen] = useState<string | null>(null);
  const panelId = useId();
  const look = lookOf(department);
  const openSeat = seating.workstations.find((w) => w.id === open);
  return (
    <div className="office-floor">
      <div className="dept-office__room" style={{ viewTransitionName: ROOM_TRANSITION }}>
        <RoomArt
          motif={look.motif}
          hue={look.hue}
          variant="office"
          seats={roomSeats(seating, specialists)}
        />
        <ul className="seats" aria-label={intl.formatMessage({ id: 'office.seats.label' })}>
          {seating.workstations.map((workstation) => {
            const agent = specialists.find((s) => s.id === agentAt(workstation));
            return agent === undefined ? (
              <FreeSeat
                key={workstation.id}
                workstation={workstation}
                open={open === workstation.id}
                panelId={panelId}
                onToggle={(next) => setOpen(next ? workstation.id : null)}
              />
            ) : (
              <TakenSeat key={workstation.id} workstation={workstation} agent={agent} slug={slug} />
            );
          })}
        </ul>
      </div>
      {openSeat === undefined ? null : (
        <SeatPanel id={panelId} workstation={openSeat} onClose={() => setOpen(null)} />
      )}
      {seating.unseated.length > 0 ? (
        <section className="mo-panel mo-page-section" aria-labelledby="unseated-agents">
          <h2 id="unseated-agents" className="mo-section-title">
            <FormattedMessage id="office.seats.unseated" />
          </h2>
          <p className="mo-lead">
            <FormattedMessage id="office.seats.unseatedBody" />
          </p>
          <ul className="agent-list">
            {seating.unseated.map((agent) => (
              <AgentPresence key={agent.id} specialist={agent} departmentSlug={slug} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const placeStyle = (workstation: Workstation) =>
  ({
    '--seat-x': workstation.position.x,
    '--seat-y': workstation.position.y,
  }) as CSSProperties;

/** What an agent is for: its purpose, in the owner's words, until roles have names (D-27). */
export function agentRole(agent: SpecialistView): string | null {
  const purpose = agent.purpose?.trim();
  return purpose === undefined || purpose === '' ? null : purpose;
}

function TakenSeat({
  workstation,
  agent,
  slug,
}: {
  readonly workstation: Workstation;
  readonly agent: SpecialistView;
  readonly slug: string;
}) {
  const intl = useIntl();
  const { state } = presenceOf(agent, workstation.id);
  const role = agentRole(agent);
  const href = paths.agent(slug, agent.id);
  const label = [
    agent.displayName,
    role,
    intl.formatMessage({ id: `office.agentState.${state}` }),
    intl.formatMessage({ id: 'office.seats.number' }, { number: workstation.number }),
  ]
    .filter((part): part is string => part !== null)
    .join('. ');
  return (
    <li className={`seat seat--taken seat--${state}`} style={placeStyle(workstation)}>
      <a
        href={href}
        className="seat__spot"
        aria-label={label}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigateInto(href);
        }}
      >
        <span className="seat__plate" aria-hidden="true">
          {agent.displayName}
        </span>
        <span className="seat__card" aria-hidden="true">
          <AgentAvatar name={agent.displayName} size={36} />
          <span className="seat__text">
            <span className="seat__name">{agent.displayName}</span>
            {role === null ? null : <span className="seat__role">{role}</span>}
            <AgentStatus state={state} />
            <span className="seat__number">
              <FormattedMessage id="office.seats.number" values={{ number: workstation.number }} />
            </span>
          </span>
        </span>
      </a>
    </li>
  );
}

/** Actions a free workstation will offer. None has a backend or a permission yet (ADR-0041). */
const SEAT_ACTIONS = ['assign', 'move', 'remove'] as const;

function FreeSeat({
  workstation,
  open,
  panelId,
  onToggle,
}: {
  readonly workstation: Workstation;
  readonly open: boolean;
  readonly panelId: string;
  readonly onToggle: (open: boolean) => void;
}) {
  const intl = useIntl();
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Closing the options gives focus back to the workstation they belong to.
  useEffect(() => {
    if (!open && wasOpen.current) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const number = intl.formatMessage({ id: 'office.seats.number' }, { number: workstation.number });
  const ambient = workstation.occupant?.kind === 'ambient';
  return (
    <li
      className={['seat', 'seat--free', ambient ? 'seat--ambient' : '', open ? 'seat--open' : '']
        .filter(Boolean)
        .join(' ')}
      style={placeStyle(workstation)}
    >
      <button
        ref={button}
        type="button"
        className="seat__spot"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${number}. ${intl.formatMessage({ id: 'office.seats.free' })}`}
        onClick={() => onToggle(!open)}
      >
        {/* A desk with an ambient figure needs no plate: the figure is decoration, not a person. */}
        {ambient ? null : (
          <span className="seat__plate" aria-hidden="true">
            <FormattedMessage id="office.seats.freeShort" />
          </span>
        )}
        <span className="seat__card" aria-hidden="true">
          <span className="seat__chair">
            <Icon name="seat" size={20} />
          </span>
          <span className="seat__text">
            <span className="seat__name">
              <FormattedMessage id="office.seats.free" />
            </span>
            <span className="seat__number">{number}</span>
            {ambient ? (
              <span className="seat__number">
                <FormattedMessage id="office.seats.ambientNote" />
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/** A free workstation's options, under the room so the drawing never hides them. */
function SeatPanel({
  id,
  workstation,
  onClose,
}: {
  readonly id: string;
  readonly workstation: Workstation;
  readonly onClose: () => void;
}) {
  const intl = useIntl();
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => heading.current?.focus(), [workstation.id]);
  // Escape anywhere in the options closes them.
  useEffect(() => {
    const element = panel.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    element?.addEventListener('keydown', onKey);
    return () => element?.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={panel} id={id} className="seat__panel" role="dialog" aria-labelledby={`${id}-title`}>
      <div className="seat__panel-head">
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
          <FormattedMessage id="office.seats.number" values={{ number: workstation.number }} />
        </h3>
        <button
          type="button"
          className="seat__close"
          aria-label={intl.formatMessage({ id: 'office.seats.close' })}
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <p>
        <FormattedMessage id="office.seats.freeBody" />
      </p>
      <ul className="seat__actions">
        {SEAT_ACTIONS.map((action) => (
          <li key={action}>
            <button
              type="button"
              className="seat__action"
              aria-disabled="true"
              title={intl.formatMessage({ id: 'common.soon' })}
              onClick={(event) => event.preventDefault()}
            >
              <FormattedMessage id={`office.seats.action.${action}`} />
              <span className="mo-badge mo-badge--outline coming__soon">
                <FormattedMessage id="common.soon" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
