import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { AgentAvatar, AgentStatus } from './agents.js';
import { agentsOf, departmentName, findBySlug, lookOf, officeSlug } from './departments.js';
import { Icon } from './icons.js';
import { readyList, useOfficeData } from './OfficeData.js';
import { agentsSummary, seatsSummary } from './OfficeScene.js';
import { agentRole, WorkstationMap } from './WorkstationMap.js';
import { agentAt, presenceOf, seatAgents } from './workstations.js';

/**
 * A department's office (ADR-0040, level 2): the room from the Home, entered. Its workstations
 * (ADR-0041) hold the department's real agents (specialist records), and it leaves room for what
 * the office will hold (projects, tasks, activity, documents) once that data exists.
 */
export function DepartmentOffice({ slug }: { readonly slug: string }) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const department = findBySlug(readyList(departments), slug);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [department?.id]);

  if (departments.status === 'loading') {
    return (
      <p className="page-notice" role="status">
        <FormattedMessage id="office.scene.loading" />
      </p>
    );
  }
  if (department === undefined) return <NotFound />;

  const look = lookOf(department);
  const name = departmentName(intl, department, 'name');
  const agents = readyList(specialists).filter((s) => s.departmentId === department.id);
  const here = agentsOf(department, agents);
  const seating = seatAgents(department, agents);
  return (
    <article className="dept-office" style={{ '--zone-hue': look.hue } as CSSProperties}>
      <OfficeBreadcrumb trail={[{ label: departmentName(intl, department) }]} />
      <header className="dept-office__header">
        <span className="dept-office__icon" aria-hidden="true">
          <Icon name={look.icon} size={26} />
        </span>
        <div>
          <h1 ref={heading} tabIndex={-1} className="dept-office__title">
            {name}
          </h1>
          <p className="dept-office__summary">
            {agentsSummary(intl, here)} · {seatsSummary(intl, seating)}
          </p>
        </div>
      </header>
      <WorkstationMap department={department} slug={slug} seating={seating} specialists={agents} />
      <div className="dept-office__grid">
        <section className="dept-office__section" aria-labelledby="dept-agents">
          <h2 id="dept-agents">
            <FormattedMessage id="office.department.agents" />
          </h2>
          <p className="panel__empty">
            <FormattedMessage
              id={
                specialists.status === 'hidden'
                  ? 'office.department.agentsHidden'
                  : here.active + here.paused === 0 && seating.occupied === 0
                    ? 'office.department.noAgents'
                    : 'office.department.atSeats'
              }
            />
          </p>
          <p className="panel__empty">
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
export function AgentPlace({ slug, agentId }: { readonly slug: string; readonly agentId: string }) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const department = findBySlug(readyList(departments), slug);
  const everyone = readyList(specialists);
  const agent = everyone.find((s) => s.id === agentId && s.departmentId === department?.id);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [agent?.id]);
  if (departments.status === 'loading' || specialists.status === 'loading') {
    return (
      <p className="page-notice" role="status">
        <FormattedMessage id="office.scene.loading" />
      </p>
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
  const work = [
    ['office.profile.activity', 'office.profile.noActivity'],
    ['office.profile.task', 'office.profile.noTask'],
    ['office.profile.lastActivity', 'office.profile.noLastActivity'],
    ['office.profile.projects', 'office.profile.noProjects'],
  ] as const;
  return (
    <article
      className="dept-office agent-profile"
      style={{ '--zone-hue': lookOf(department).hue } as CSSProperties}
    >
      <OfficeBreadcrumb
        trail={[
          { label: departmentName(intl, department), path: paths.office(officeSlug(department)) },
          { label: agent.displayName },
        ]}
      />
      <header className="dept-office__header">
        <AgentAvatar name={agent.displayName} size={64} />
        <div>
          <h1 ref={heading} tabIndex={-1} className="dept-office__title">
            {agent.displayName}
          </h1>
          <p className="dept-office__summary">{role ?? departmentName(intl, department, 'name')}</p>
        </div>
      </header>
      <div className="dept-office__grid">
        <section className="dept-office__section" aria-labelledby="agent-facts">
          <h2 id="agent-facts">
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
          <p className="panel__empty">
            <FormattedMessage id="office.profile.stateSource" />
          </p>
        </section>
        <section className="dept-office__section" aria-labelledby="agent-work">
          <h2 id="agent-work">
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
      <ComingAreas
        titleId="office.agent.coming"
        areas={['documents', 'tools', 'results', 'actions']}
      />
    </article>
  );
}

export function NotFound() {
  return (
    <div className="page-notice">
      <h1>
        <FormattedMessage id="office.notFound.title" />
      </h1>
      <p>
        <FormattedMessage id="office.notFound.body" />
      </p>
      <BackToOffice />
    </div>
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
    <section className="dept-office__section" aria-labelledby={id}>
      <h2 id={id}>
        <FormattedMessage id={titleId} />
      </h2>
      <p className="panel__empty">
        <FormattedMessage id="office.coming.body" />
      </p>
      <ul className="coming">
        {areas.map((area) => (
          <li key={area} className="coming__item">
            <FormattedMessage id={`office.area.${area}`} />
            <span className="coming__soon">
              <FormattedMessage id="common.soon" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
