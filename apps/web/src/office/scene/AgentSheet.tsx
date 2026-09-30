import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentsClient } from '../../agents/agentsClient.js';
import { navigate } from '../../identity/router.js';
import { paths } from '../../shell/routes.js';
import { AgentAvatar, AgentStatus } from '../agents.js';
import { AgentTasks, statusKey } from '../AgentTasks.js';
import type { AgentTasksClient } from '../agentTasksClient.js';
import { departmentName, lookOf, officeSlug } from '../departments.js';
import { Icon } from '../icons.js';
import { readyList, useOfficeData, useSpecialistSaved } from '../OfficeData.js';
import { agentRole } from '../WorkstationMap.js';
import { isCurrentTask, workStateOf, type AgentWork } from './agentWork.js';

/** What the Home may do with an agent, by the person's permissions (see `AppShell`). */
export interface AgentSheetAccess {
  /** `specialist.read`: the agent's tasks; `canAsk` (`specialist.task`) may give it one. */
  readonly tasks?: {
    readonly client: AgentTasksClient;
    readonly canAsk: boolean;
    readonly stop?: ((taskId: string) => Promise<void>) | undefined;
    readonly decide?:
      ((approvalId: string, decision: 'approve' | 'reject') => Promise<void>) | undefined;
  };
  /** `specialist.manage`: may pause and resume the agent (ADR-0025). */
  readonly agents?: AgentsClient;
  readonly canManageAgents?: boolean;
  /** `document.read`: the organization's documents. */
  readonly canReadDocuments?: boolean;
}

/** Where the task stands, in the steps the runtime reports (ADR-0024). */
const STEPS = ['pending', 'planning', 'running', 'verifying', 'completed'] as const;
const stepOf = (status: string): number => {
  if (status === 'retrying') return 2;
  if (status === 'waiting_approval') return 1;
  const at = STEPS.indexOf(status as (typeof STEPS)[number]);
  return at === -1 ? 0 : at;
};

/**
 * An agent's card on the Home (Home V4): who the agent is and what it is doing, from its record
 * and its latest task, with what the person can do next. It is the same agent as its place in the
 * office (level 3): giving instructions uses the agent tasks already there (ADR-0063), and every
 * other action opens the screen where it is done. On a phone it rises from the bottom.
 */
export function AgentSheet({
  agentId,
  work,
  access,
  onClose,
}: {
  readonly agentId: string;
  readonly work: AgentWork;
  readonly access: AgentSheetAccess;
  readonly onClose: () => void;
}) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const saved = useSpecialistSaved();
  const heading = useRef<HTMLHeadingElement>(null);
  const [instructing, setInstructing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const agent = readyList(specialists).find((s) => s.id === agentId);
  const department = readyList(departments).find((d) => d.id === agent?.departmentId);

  useEffect(() => {
    heading.current?.focus();
  }, [agentId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (agent === undefined || department === undefined || agent.status === 'archived') return null;
  const task = work.get(agent.id);
  const state = workStateOf(agent, task) ?? 'offline';
  const current = isCurrentTask(task) ? task : undefined;
  const latest = task ?? undefined;
  const role = agentRole(agent);
  const place = paths.agent(officeSlug(department), agent.id);
  const canPause =
    access.canManageAgents === true &&
    access.agents !== undefined &&
    (agent.status === 'active' || agent.status === 'paused');

  const togglePause = async () => {
    if (access.agents === undefined) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const to = agent.status === 'active' ? 'paused' : 'active';
      saved(await access.agents.setStatus(agent.id, agent.status, to));
      setNotice(to === 'paused' ? 'office.sheet.paused' : 'office.sheet.resumed');
    } catch {
      setNotice('office.sheet.pauseFailed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className="agent-sheet"
      role="dialog"
      aria-labelledby="agent-sheet-title"
      style={{ '--zone-hue': lookOf(department).hue } as CSSProperties}
    >
      <header className="agent-sheet__header">
        <AgentAvatar name={agent.displayName} size={48} />
        <div className="agent-sheet__who">
          <h2 id="agent-sheet-title" ref={heading} tabIndex={-1}>
            {agent.displayName}
          </h2>
          <p>
            {departmentName(intl, department, 'name')}
            {role === null ? null : ` · ${role}`}
          </p>
        </div>
        <button
          type="button"
          className="mo-button mo-button--ghost mo-button--icon agent-sheet__close"
          aria-label={intl.formatMessage({ id: 'office.sheet.close' })}
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="agent-sheet__body">
        <dl className="agent-sheet__facts">
          <div>
            <dt>
              <FormattedMessage id="office.profile.state" />
            </dt>
            <dd>
              <AgentStatus state={state} />
            </dd>
          </div>
          <div>
            <dt>
              <FormattedMessage id="office.sheet.current" />
            </dt>
            <dd>
              {current === undefined ? (
                <span className="agent-sheet__none">
                  <FormattedMessage
                    id={
                      access.tasks === undefined
                        ? 'office.profile.noTask'
                        : 'office.sheet.noCurrent'
                    }
                  />
                </span>
              ) : (
                <>
                  <span className="agent-sheet__task">{current.request}</span>
                  <span className="agent-sheet__meta">
                    <FormattedMessage id={statusKey(current)} />
                  </span>
                  <ol
                    className="agent-sheet__steps"
                    aria-label={intl.formatMessage({ id: 'office.sheet.progress' })}
                  >
                    {STEPS.slice(0, 4).map((step, i) => (
                      <li
                        key={step}
                        className={i <= stepOf(current.status) ? 'agent-sheet__step--done' : ''}
                      >
                        <FormattedMessage id={`office.sheet.step.${step}`} />
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </dd>
          </div>
          {latest !== undefined && latest.status === 'completed' && latest.answer !== null ? (
            <div>
              <dt>
                <FormattedMessage id="office.sheet.result" />
              </dt>
              <dd>
                <span className="agent-sheet__task">{latest.request}</span>
                <span className="agent-sheet__answer">{latest.answer.answer}</span>
              </dd>
            </div>
          ) : null}
        </dl>
        {notice === undefined ? null : (
          <p className="agent-sheet__notice" role="status">
            <FormattedMessage id={notice} values={{ name: agent.displayName }} />
          </p>
        )}
        <div className="agent-sheet__actions">
          {access.tasks?.canAsk === true && agent.status === 'active' ? (
            <button
              type="button"
              className="mo-button mo-button--primary mo-button--sm"
              aria-expanded={instructing}
              onClick={() => setInstructing((open) => !open)}
            >
              <Icon name="gia" size={16} />
              <FormattedMessage id="office.sheet.instruct" />
            </button>
          ) : null}
          {canPause ? (
            <button
              type="button"
              className="mo-button mo-button--secondary mo-button--sm"
              disabled={busy}
              onClick={() => void togglePause()}
            >
              <Icon name={agent.status === 'active' ? 'pause' : 'check'} size={16} />
              <FormattedMessage
                id={agent.status === 'active' ? 'office.sheet.pause' : 'office.sheet.resume'}
              />
            </button>
          ) : null}
          <button
            type="button"
            className="mo-button mo-button--secondary mo-button--sm"
            onClick={() => navigate(place)}
          >
            <Icon name="user" size={16} />
            <FormattedMessage id="office.sheet.work" />
          </button>
          {access.canReadDocuments === true ? (
            <button
              type="button"
              className="mo-button mo-button--secondary mo-button--sm"
              onClick={() => navigate(paths.documents())}
            >
              <Icon name="documents" size={16} />
              <FormattedMessage id="office.sheet.documents" />
            </button>
          ) : null}
          {access.tasks === undefined ? null : (
            <button
              type="button"
              className="mo-button mo-button--secondary mo-button--sm"
              onClick={() => navigate(place)}
            >
              <Icon name="check" size={16} />
              <FormattedMessage id="office.sheet.results" />
            </button>
          )}
        </div>
        {instructing && access.tasks !== undefined ? (
          <AgentTasks
            key={agent.id}
            client={access.tasks.client}
            agentId={agent.id}
            agentName={agent.displayName}
            canAsk={access.tasks.canAsk}
            agentActive={agent.status === 'active'}
            stop={access.tasks.stop}
            decide={access.tasks.decide}
          />
        ) : null}
      </div>
    </aside>
  );
}
