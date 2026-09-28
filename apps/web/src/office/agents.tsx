import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import type { AgentState } from './departments.js';
import { Icon, type IconName } from './icons.js';
import type { SpecialistView } from './officeClient.js';
import { paths } from '../shell/routes.js';
import { navigateInto } from './transition.js';
import { presenceOf } from './workstations.js';

/**
 * How agents appear in the office (ADR-0040). An agent is a specialist record (D-28): its name,
 * department and status come from the API. What it is doing right now does not exist yet, so no
 * component here claims it; `AgentState` already has room for it.
 */

const STATE_ICONS: Readonly<Record<AgentState, IconName>> = {
  working: 'cog',
  waiting: 'hourglass',
  processing: 'spinner',
  available: 'check',
  attention: 'alert',
  paused: 'pause',
  offline: 'moon',
};

/** A state, by shape and word as well as color, so it never depends on color alone. */
export function AgentStatus({
  state,
  count,
}: {
  readonly state: AgentState;
  readonly count?: number;
}) {
  return (
    <span className={`agent-status agent-status--${state}`}>
      <Icon name={STATE_ICONS[state]} size={14} />
      {count === undefined ? (
        <FormattedMessage id={`office.agentState.${state}`} />
      ) : (
        <FormattedMessage id={`office.agentState.${state}.count`} values={{ count }} />
      )}
    </span>
  );
}

/**
 * A specialist's state as the office shows it: from its record only (see `presenceOf`), never
 * activity. Archived ones are not in the office.
 */
export function agentStateOf(specialist: Pick<SpecialistView, 'status'>): AgentState | undefined {
  if (specialist.status === 'archived') return undefined;
  return presenceOf({ id: '', status: specialist.status }, null).state;
}

export function AgentAvatar({
  name,
  size = 40,
}: {
  readonly name: string;
  readonly size?: number;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span className="agent-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {initials === '' ? <Icon name="user" size={size * 0.5} /> : initials}
    </span>
  );
}

/**
 * An agent at its desk, in a department's office. It opens the agent's place (level 3, reserved
 * until the agent workspace exists).
 */
export function AgentPresence({
  specialist,
  departmentSlug,
}: {
  readonly specialist: SpecialistView;
  readonly departmentSlug: string;
}) {
  const intl = useIntl();
  const state = agentStateOf(specialist);
  const href = paths.agent(departmentSlug, specialist.id);
  return (
    <li className="agent-presence">
      <a
        href={href}
        className="agent-presence__link"
        aria-label={intl.formatMessage(
          { id: 'office.agent.open' },
          { name: specialist.displayName },
        )}
        onClick={(event) => {
          event.preventDefault();
          navigateInto(href);
        }}
      >
        <AgentAvatar name={specialist.displayName} />
        <span className="agent-presence__name">{specialist.displayName}</span>
        {state === undefined ? (
          <span className="agent-presence__muted">
            <FormattedMessage id={`office.specialistStatus.${specialist.status}`} />
          </span>
        ) : (
          <AgentStatus state={state} />
        )}
      </a>
    </li>
  );
}
