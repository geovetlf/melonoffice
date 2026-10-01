import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, PageHeader, StateMessage } from '@melonoffice/ui';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { AgentAvatar, AgentStatus } from './agents.js';
import { AgentTasks } from './AgentTasks.js';
import type { AgentTasksClient } from './agentTasksClient.js';
import { agentsOf, departmentName, findBySlug, lookOf, officeSlug } from './departments.js';
import { Icon } from './icons.js';
import { readyList, useOfficeData } from './OfficeData.js';
import { agentsSummary, seatsSummary } from './OfficeScene.js';
import { agentRole, WorkstationMap } from './WorkstationMap.js';
import { agentAt, presenceOf, seatAgents } from './workstations.js';
import { AgentCapabilities } from '../agents/AgentCapabilities.js';
import type { AgentsClient } from '../agents/agentsClient.js';

/**
 * Moves focus to the page's title once it shows, so a reader starts at the room it entered. The
 * title is the PageHeader's `h1`, found by its id.
 */
function useFocusTitle(titleId: string, key: string | undefined) {
  useEffect(() => {
    if (key === undefined) return;
    const title = document.getElementById(titleId);
    if (title === null) return;
    title.tabIndex = -1;
    title.focus();
  }, [titleId, key]);
}

/**
 * A department's office (ADR-0040, level 2): the room from the Home, entered. Its workstations
 * (ADR-0041) hold the department's real agents (specialist records), and it leaves room for what
 * the office will hold (projects, tasks, activity, documents) once that data exists. Comercial's
 * office also holds its follow-ups (C5), its opportunities (C2) and its customers and leads (C1).
 */
export function DepartmentOffice({
  slug,
  customers,
  opportunities,
  followUps,
  reports,
}: {
  readonly slug: string;
  /** The reports of the metrics this department is served by (ADR-0060), for `report.read`. */
  readonly reports?: (typeId: string) => ReactNode;
  /** The Comercial office's pending follow-ups (C5, ADR-0058), for a role that may read them. */
  readonly followUps?: ReactNode;
  /** The Comercial office's customers and leads (C1, ADR-0053), for a role that may read them. */
  readonly customers?: ReactNode;
  /** The Comercial office's opportunities and pipeline (C2, ADR-0054), likewise. */
  readonly opportunities?: ReactNode;
}) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const department = findBySlug(readyList(departments), slug);
  useFocusTitle('dept-office-title', department?.id);

  if (departments.status === 'loading') {
    return (
      <StateMessage kind="loading">
        <FormattedMessage id="office.scene.loading" />
      </StateMessage>
    );
  }
  if (department === undefined) return <NotFound />;

  const look = lookOf(department);
  const name = departmentName(intl, department, 'name');
  const agents = readyList(specialists).filter((s) => s.departmentId === department.id);
  const here = agentsOf(department, agents);
  const seating = seatAgents(department, agents);
  return (
    <article className="mo-page dept-office" style={{ '--zone-hue': look.hue } as CSSProperties}>
      <OfficeBreadcrumb trail={[{ label: departmentName(intl, department) }]} />
      <PageHeader
        titleId="dept-office-title"
        title={name}
        leading={
          <span className="dept-office__icon" aria-hidden="true">
            <Icon name={look.icon} size={26} />
          </span>
        }
        meta={
          <>
            {agentsSummary(intl, here)} · {seatsSummary(intl, seating)}
          </>
        }
      />
      <WorkstationMap department={department} slug={slug} seating={seating} specialists={agents} />
      {department.typeId === 'sales' ? followUps : null}
      {department.typeId === 'sales' ? opportunities : null}
      {department.typeId === 'sales' ? customers : null}
      {department.typeId === null ? null : reports?.(department.typeId)}
      <div className="dept-office__grid">
        <section className="mo-panel mo-page-section" aria-labelledby="dept-agents">
          <h2 id="dept-agents" className="mo-section-title">
            <FormattedMessage id="office.department.agents" />
          </h2>
          {specialists.status !== 'hidden' &&
          here.active + here.paused === 0 &&
          seating.occupied === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="office.department.noAgents" />
            </StateMessage>
          ) : (
            <p className="mo-lead">
              <FormattedMessage
                id={
                  specialists.status === 'hidden'
                    ? 'office.department.agentsHidden'
                    : 'office.department.atSeats'
                }
              />
            </p>
          )}
          <p className="mo-hint">
            <FormattedMessage id="office.seats.provisional" />
          </p>
        </section>
        <ComingAreas
          titleId="office.department.coming"
          areas={['projects', 'tasks', 'activity', 'documents']}
        />
      </div>
    </article>
  );
}

/**
 * An agent's place (level 3): who the agent is, from its record, where it sits, and the areas
 * its workspace will fill once the runtime reports them (ADR-0041). It never shows a task or
 * activity the agent does not have: with none reported, it says so.
 */
export function AgentPlace({
  slug,
  agentId,
  tasks,
  agents,
  canManageAgents = false,
}: {
  readonly slug: string;
  readonly agentId: string;
  /** The agent's tasks (ADR-0063), for a person who may read them; absent, none are shown. */
  readonly tasks?: {
    readonly client: AgentTasksClient;
    readonly canAsk: boolean;
    /** With `execution.cancel`: stops a task still working. */
    readonly stop?: ((taskId: string) => Promise<void>) | undefined;
    /** With `approval.approve`: decides the follow-up an agent proposed (ADR-0084). */
    readonly decide?:
      ((approvalId: string, decision: 'approve' | 'reject') => Promise<void>) | undefined;
  };
  /** What the agent can do now (ADR-0062), for a person who may read agents. */
  readonly agents?: AgentsClient;
  /** `specialist.manage`: may move a skill of the agent to its newer version (ADR-0084). */
  readonly canManageAgents?: boolean;
}) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const department = findBySlug(readyList(departments), slug);
  const everyone = readyList(specialists);
  const agent = everyone.find((s) => s.id === agentId && s.departmentId === department?.id);
  useFocusTitle('agent-profile-title', agent?.id);
  if (departments.status === 'loading' || specialists.status === 'loading') {
    return (
      <StateMessage kind="loading">
        <FormattedMessage id="office.scene.loading" />
      </StateMessage>
    );
  }
  if (department === undefined || agent === undefined || agent.status === 'archived') {
    return <NotFound />;
  }
  const workstation = seatAgents(department, everyone).workstations.find(
    (w) => agentAt(w) === agent.id,
  );
  const presence = presenceOf(agent, workstation?.id ?? null);
  const role = agentRole(agent);
  const facts: readonly { readonly term: string; readonly value: ReactNode }[] = [
    { term: 'office.profile.role', value: role ?? <FormattedMessage id="office.profile.noRole" /> },
    { term: 'office.profile.department', value: departmentName(intl, department, 'name') },
    { term: 'office.profile.state', value: <AgentStatus state={presence.state} /> },
    {
      term: 'office.profile.seat',
      value:
        workstation === undefined ? (
          <FormattedMessage id="office.profile.noSeat" />
        ) : (
          <FormattedMessage id="office.seats.number" values={{ number: workstation.number }} />
        ),
    },
  ];
  // What the runtime will report; today nothing does, and each says so (never an invented one).
  // Its tasks, when they can be read, have their own section below.
  const work = [
    ['office.profile.activity', 'office.profile.noActivity'],
    ...(tasks === undefined ? ([['office.profile.task', 'office.profile.noTask']] as const) : []),
    ['office.profile.lastActivity', 'office.profile.noLastActivity'],
    ['office.profile.projects', 'office.profile.noProjects'],
  ] as const;
  return (
    <article
      className="mo-page dept-office agent-profile"
      style={{ '--zone-hue': lookOf(department).hue } as CSSProperties}
    >
      <OfficeBreadcrumb
        trail={[
          { label: departmentName(intl, department), path: paths.office(officeSlug(department)) },
          { label: agent.displayName },
        ]}
      />
      <PageHeader
        titleId="agent-profile-title"
        title={agent.displayName}
        leading={<AgentAvatar name={agent.displayName} size={64} />}
        meta={role ?? departmentName(intl, department, 'name')}
      />
      <div className="dept-office__grid">
        <section className="mo-panel mo-page-section" aria-labelledby="agent-facts">
          <h2 id="agent-facts" className="mo-section-title">
            <FormattedMessage id="office.profile.title" />
          </h2>
          <dl className="agent-facts">
            {facts.map((fact) => (
              <div key={fact.term} className="agent-facts__row">
                <dt>
                  <FormattedMessage id={fact.term} />
                </dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mo-hint">
            <FormattedMessage id="office.profile.stateSource" />
          </p>
        </section>
        {agents === undefined ? null : (
          <AgentCapabilities client={agents} agentId={agent.id} canManage={canManageAgents} />
        )}
        <section className="mo-panel mo-page-section" aria-labelledby="agent-work">
          <h2 id="agent-work" className="mo-section-title">
            <FormattedMessage id="office.profile.work" />
          </h2>
          <dl className="agent-facts">
            {work.map(([term, none]) => (
              <div key={term} className="agent-facts__row">
                <dt>
                  <FormattedMessage id={term} />
                </dt>
                <dd className="agent-facts__none">
                  <FormattedMessage id={none} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      {tasks === undefined ? null : (
        <AgentTasks
          key={agent.id}
          client={tasks.client}
          agentId={agent.id}
          agentName={agent.displayName}
          canAsk={tasks.canAsk}
          agentActive={agent.status === 'active'}
          stop={tasks.stop}
          decide={tasks.decide}
        />
      )}
      <ComingAreas
        titleId="office.agent.coming"
        areas={['documents', 'tools', 'results', 'actions']}
      />
    </article>
  );
}

export function NotFound() {
  return (
    <article className="mo-page">
      <PageHeader
        title={<FormattedMessage id="office.notFound.title" />}
        description={<FormattedMessage id="office.notFound.body" />}
      />
      <BackToOffice />
    </article>
  );
}

function BackToOffice() {
  return (
    <a
      href={paths.home()}
      className="back-link"
      onClick={(event) => {
        event.preventDefault();
        navigate(paths.home());
      }}
    >
      <Icon name="back" size={16} />
      <FormattedMessage id="office.back" />
    </a>
  );
}

/** Where the person is in the office: Office / Department / Agent, each a way back. */
export function OfficeBreadcrumb({
  trail,
}: {
  readonly trail: readonly { readonly label: ReactNode; readonly path?: string }[];
}) {
  const intl = useIntl();
  return (
    <nav className="breadcrumb" aria-label={intl.formatMessage({ id: 'office.breadcrumb' })}>
      <ol>
        <li>
          <BackToOffice />
        </li>
        {trail.map((step, i) => (
          <li key={i}>
            {step.path === undefined ? (
              <span aria-current="page">{step.label}</span>
            ) : (
              <a
                href={step.path}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(step.path ?? paths.home());
                }}
              >
                {step.label}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function ComingAreas({
  titleId,
  areas,
}: {
  readonly titleId: string;
  readonly areas: readonly string[];
}) {
  const id = `coming-${titleId.replaceAll('.', '-')}`;
  return (
    <section className="mo-panel mo-page-section" aria-labelledby={id}>
      <h2 id={id} className="mo-section-title">
        <FormattedMessage id={titleId} />
      </h2>
      <p className="mo-hint">
        <FormattedMessage id="office.coming.body" />
      </p>
      <ul className="coming">
        {areas.map((area) => (
          <li key={area} className="coming__item">
            <FormattedMessage id={`office.area.${area}`} />
            <Badge outline className="coming__soon">
              <FormattedMessage id="common.soon" />
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
