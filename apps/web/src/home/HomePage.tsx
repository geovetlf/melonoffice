import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useCallback, useRef, useState } from 'react';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { AutomationsClient } from '../automations/automationsClient.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { AgentSheet, type AgentSheetAccess } from '../office/scene/AgentSheet.js';
import { useAgentWork, workStateOf } from '../office/scene/agentWork.js';
import { useMotorFlows } from '../office/scene/motor.js';
import { MotorPanel } from '../office/scene/MotorPanel.js';
import { OfficeBuilding } from '../office/scene/OfficeBuilding.js';
import { GiaCommandBar, QuickActions } from './gia.js';
import { CreditsUsage, RecentActivity, UpcomingMeetings } from './panels.js';
import { attentionCount, TodayWork, useTodayWork } from './TodayWork.js';

/** What the Home's office may do, by the person's permissions (see `AppShell`). */
export interface HomeOfficeAccess extends AgentSheetAccess {
  /** `plan.read`: the plans MelonMotor shows moving between departments. */
  readonly automations?: AutomationsClient | undefined;
}

/**
 * The Home (ADR-0040, Home V4): the organization's office is the page. The building fills the
 * centre, with GIA in headquarters and MelonMotor in the atrium; the day's context sits beside it
 * (activity, what waits on the person, meetings, credits) and GIA's command box below. Everything
 * it shows is read from the office's data, the agents' tasks and the panels' own sources.
 */
export function HomePage({
  canReadAIUsage = false,
  followUps,
  approvals,
  office = {},
}: {
  readonly canReadAIUsage?: boolean;
  /** Today's follow-ups, for a person with `follow_up.read`. */
  readonly followUps?: FollowUpsClient | undefined;
  /** Approvals waiting, for a person with `approval.read`. */
  readonly approvals?: ApprovalsClient | undefined;
  readonly office?: HomeOfficeAccess;
}) {
  const intl = useIntl();
  const { specialists, credits } = useOfficeData();
  const agents = readyList(specialists);
  const work = useAgentWork(office.tasks?.client, agents);
  const motor = useMotorFlows(office.automations);
  const today = useTodayWork(followUps, approvals);
  const [agent, setAgent] = useState<string>();
  const [motorOpen, setMotorOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const active = agents.filter((s) => s.status === 'active').length;
  const working = agents.filter((s) => workStateOf(s, work.get(s.id)) === 'working').length;
  const waiting = attentionCount(today);
  const [now] = useState(() => new Date());
  const hour = now.getHours();
  const partOfDay = hour < 12 ? 'morning' : hour < 19 ? 'afternoon' : 'evening';

  const closeAgent = useCallback(() => {
    setAgent(undefined);
    opener.current?.focus();
  }, []);
  const closeMotor = useCallback(() => setMotorOpen(false), []);

  return (
    <div className="home4">
      <header className="home4__header">
        <div>
          <time className="home4__date" dateTime={now.toISOString().slice(0, 10)}>
            {intl.formatDate(now, { weekday: 'long', day: 'numeric', month: 'long' })}
          </time>
          <p className="home4__greeting">
            <FormattedMessage id={`home.greeting.${partOfDay}`} />
          </p>
          <h1 className="home4__title">
            <FormattedMessage id={active > 0 ? 'home.hero.working' : 'home.hero.ready'} />
          </h1>
        </div>
        <ul className="home4__chips" aria-label={intl.formatMessage({ id: 'home.chips.label' })}>
          {specialists.status === 'ready' ? (
            <li className="home4__chip">
              <span className="home4__chip-dot home4__chip-dot--working" />
              <FormattedMessage id="home.chips.working" values={{ count: working }} />
            </li>
          ) : null}
          {waiting === undefined ? null : (
            <li className="home4__chip">
              <span
                className={`home4__chip-dot${waiting > 0 ? ' home4__chip-dot--attention' : ''}`}
              />
              <FormattedMessage id="home.chips.attention" values={{ count: waiting }} />
            </li>
          )}
        </ul>
      </header>
      <div className="home4__layout">
        <div className="home4__main">
          <div className="home4__office">
            <OfficeBuilding
              work={work}
              motor={motor}
              motorOpen={motorOpen}
              onMotor={() => setMotorOpen((open) => !open)}
              onAgent={(id, from) => {
                opener.current = from;
                setAgent(id);
              }}
            />
            {motorOpen ? (
              <MotorPanel
                motor={motor}
                work={work}
                canReadPlans={office.automations !== undefined}
                onClose={closeMotor}
              />
            ) : null}
          </div>
          <div className="home4__command">
            <GiaCommandBar suggestions more={<QuickActions />} />
          </div>
        </div>
        <aside className="home4__side" aria-label={intl.formatMessage({ id: 'home.side.label' })}>
          <RecentActivity />
          <TodayWork work={today} />
          <UpcomingMeetings />
          <CreditsUsage credits={credits} showUsage={canReadAIUsage} />
        </aside>
      </div>
      {agent === undefined ? null : (
        <AgentSheet key={agent} agentId={agent} work={work} access={office} onClose={closeAgent} />
      )}
    </div>
  );
}
