import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { AutomationsClient } from '../automations/automationsClient.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { AgentSheet, type AgentSheetAccess } from '../office/scene/AgentSheet.js';
import { useAgentWork, workStateOf } from '../office/scene/agentWork.js';
import { useMotorFlows } from '../office/scene/motor.js';
import { MotorPanel } from '../office/scene/MotorPanel.js';
import { OfficeStage } from '../office/scene/OfficeStage.js';
import { SCENE_ASPECT } from '../office/scene/officeScene.js';
import { GiaCommandBar, QuickActions } from './gia.js';
import { CreditsUsage, RecentActivity, UpcomingMeetings } from './panels.js';
import { attentionCount, TodayWork, useTodayWork } from './TodayWork.js';

/**
 * How many entries the day's lists show. The Home scrolls below its building (home.css), so every
 * window shows the same three, each list keeping its link to all of them.
 */
const ENTRIES_SHOWN = 3;

/** What the Home's office may do, by the person's permissions (see `AppShell`). */
export interface HomeOfficeAccess extends AgentSheetAccess {
  /** `plan.read`: the plans MelonMotor shows moving between departments. */
  readonly automations?: AutomationsClient | undefined;
}

/**
 * The Home (ADR-0040, Home V5): the organization's office is the page. The office is one picture
 * (`OfficeStage`): GIA's desk in the centre, six desks around it and the glass wall behind; the
 * day's context sits beside it (activity, what waits on the person, meetings, credits) and GIA's
 * command box below. Everything written on the page is read from the office's data, the agents'
 * tasks and the panels' own sources.
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
  const shown = ENTRIES_SHOWN;
  // An agent's card, opened from the agent at their desk; focus goes back there when it closes.
  const [agent, setAgent] = useState<string>();
  const [motorOpen, setMotorOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const page = useOfficeWidth();
  const closeAgent = useCallback(() => {
    setAgent(undefined);
    opener.current?.focus();
  }, []);
  const closeMotor = useCallback(() => setMotorOpen(false), []);

  const activeAgents = agents.filter((s) => s.status === 'active');
  const active = activeAgents.length;
  const activeDepartments = new Set(activeAgents.map((s) => s.departmentId)).size;
  const working = agents.filter((s) => workStateOf(s, work.get(s.id)) === 'working').length;
  const waiting = attentionCount(today);

  return (
    <div ref={page} className="home4" style={{ '--stage-aspect': SCENE_ASPECT } as CSSProperties}>
      <header className="home4__header">
        <div className="home4__heading">
          <h1 className="home4__title">
            <FormattedMessage id={active > 0 ? 'home.hero.working' : 'home.hero.ready'} />
          </h1>
          {specialists.status === 'ready' ? (
            <p className="home4__context">
              {active > 0 ? (
                <FormattedMessage
                  id="home.context.active"
                  values={{ agents: active, departments: activeDepartments }}
                />
              ) : (
                <FormattedMessage id="home.context.none" />
              )}
            </p>
          ) : null}
        </div>
      </header>
      <div className="home4__layout">
        <div className="home4__main">
          <div className="home4__office">
            {/* The office's figures are on its glass wall, not in pills over the page. */}
            <OfficeStage
              figures={{
                active,
                working,
                attention: waiting,
                agentsKnown: specialists.status === 'ready',
              }}
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
          <RecentActivity shown={shown} />
          <TodayWork work={today} shown={shown} />
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

/**
 * The office's frame is the largest of the picture's shape that fits the window (home.css): the
 * Home sets its heading on the frame and lines the page up with it by where the frame really is,
 * measured, never guessed (`--stage-width`, `--stage-top`).
 */
function useOfficeWidth() {
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = page.current;
    const frame = root?.querySelector<HTMLElement>('.stage__frame');
    const office = frame?.closest<HTMLElement>('.home4__office');
    if (
      root === null ||
      root === undefined ||
      frame === null ||
      frame === undefined ||
      office === null ||
      office === undefined
    ) {
      return undefined;
    }
    const measure = () => {
      root.style.setProperty('--stage-width', `${frame.offsetWidth}px`);
      const top = frame.getBoundingClientRect().top - office.getBoundingClientRect().top;
      root.style.setProperty('--stage-top', `${Math.max(0, Math.round(top))}px`);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(office);
    return () => observer.disconnect();
  }, []);
  return page;
}
