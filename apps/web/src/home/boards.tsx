import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useCan } from '../identity/AuthProvider.js';
import { navigate } from '../identity/router.js';
import { AgentAvatar } from '../office/agents.js';
import { departmentName } from '../office/departments.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { isCurrentTask, workStateOf, type AgentWork } from '../office/scene/agentWork.js';
import type { MotorState } from '../office/scene/motor.js';
import { paths } from '../shell/routes.js';
import { Panel } from './panels.js';

/**
 * The Home's boards beside the office, on a screen wider than the office can be (home.css): the
 * office's real agents with their real state, and MelonMotor's real flows. Nothing is made up: an
 * office with no agents says so, and a role that may not read the plans is told that too.
 */
export function HomeBoards({
  work,
  motor,
  onAgent,
  onMotor,
}: {
  readonly work: AgentWork;
  readonly motor: MotorState;
  /** Opens an agent's card; the element is where focus returns when it closes. */
  readonly onAgent: (agentId: string, from: HTMLElement) => void;
  readonly onMotor: () => void;
}) {
  const intl = useIntl();
  return (
    <aside className="home4__boards" aria-label={intl.formatMessage({ id: 'home.boards.label' })}>
      <MotorBoard motor={motor} work={work} onMotor={onMotor} />
      <TeamBoard work={work} onAgent={onAgent} />
    </aside>
  );
}

function TeamBoard({
  work,
  onAgent,
}: {
  readonly work: AgentWork;
  readonly onAgent: (agentId: string, from: HTMLElement) => void;
}) {
  const intl = useIntl();
  const canReadAgents = useCan('specialist.read');
  const { specialists, departments } = useOfficeData();
  const ready = readyList(departments);
  const team = readyList(specialists).flatMap((agent) => {
    const state = workStateOf(agent, work.get(agent.id));
    return state === undefined || state === 'offline' ? [] : [{ agent, state }];
  });
  return (
    <Panel titleId="home.team.title" icon="user">
      {specialists.status !== 'ready' ? null : team.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="home.team.empty" />
        </p>
      ) : (
        <ul className="board__list">
          {team.map(({ agent, state }) => {
            const department = ready.find((d) => d.id === agent.departmentId);
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className="board__agent"
                  onClick={(event) => onAgent(agent.id, event.currentTarget)}
                >
                  <AgentAvatar name={agent.displayName} size={28} />
                  <span className="board__who">
                    <span className="board__name">{agent.displayName}</span>
                    {department === undefined ? null : (
                      <span className="board__meta">{departmentName(intl, department)}</span>
                    )}
                  </span>
                  <span className={`board__state board__state--${state}`}>
                    <FormattedMessage id={`office.agentState.${state}`} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {canReadAgents ? (
        <button type="button" className="panel__link" onClick={() => navigate(paths.agents())}>
          <FormattedMessage id="home.team.all" />
        </button>
      ) : null}
    </Panel>
  );
}

function MotorBoard({
  motor,
  work,
  onMotor,
}: {
  readonly motor: MotorState;
  readonly work: AgentWork;
  readonly onMotor: () => void;
}) {
  const tasks = [...work.values()].filter(isCurrentTask).length;
  return (
    <Panel titleId="office.motor.name" icon="automations">
      {motor.status === 'hidden' ? (
        <p className="panel__empty">
          <FormattedMessage id="office.motor.flowsHidden" />
        </p>
      ) : motor.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="office.motor.loading" />
        </p>
      ) : motor.status === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="office.motor.error" />
        </p>
      ) : (
        <p className="panel__empty">
          {motor.flows.length > 0 ? (
            <FormattedMessage id="home.motor.flows" values={{ count: motor.flows.length }} />
          ) : (
            <FormattedMessage id="office.motor.noFlows" values={{ count: motor.running }} />
          )}
        </p>
      )}
      <p className="board__meta">
        <FormattedMessage id="office.motor.tasks" values={{ count: tasks }} />
      </p>
      <button type="button" className="panel__link" onClick={onMotor}>
        <FormattedMessage id="home.motor.see" />
      </button>
    </Panel>
  );
}
