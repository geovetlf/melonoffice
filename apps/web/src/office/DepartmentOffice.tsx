import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { AgentAvatar, AgentPresence, AgentStatus, agentStateOf } from './agents.js';
import { agentsOf, departmentName, findBySlug, lookOf, officeSlug } from './departments.js';
import { Icon } from './icons.js';

import { readyList, useOfficeData } from './OfficeData.js';
import { agentsSummary } from './OfficeScene.js';
import { RoomArt } from './RoomArt.js';
import { ROOM_TRANSITION } from './transition.js';

/**
 * A department's office (ADR-0040, level 2): the room from the Home, entered. It shows the
 * department's real agents (specialist records) and leaves room for what the office will hold
 * (projects, tasks, activity, documents) once that data exists.
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
          <p className="dept-office__summary">{agentsSummary(intl, here)}</p>
        </div>
      </header>
      <div className="dept-office__room" style={{ viewTransitionName: ROOM_TRANSITION }}>
        <RoomArt motif={look.motif} hue={look.hue} variant="office" agents={here} />
      </div>
      <div className="dept-office__grid">
        <section className="dept-office__section" aria-labelledby="dept-agents">
          <h2 id="dept-agents">
            <FormattedMessage id="office.department.agents" />
          </h2>
          {specialists.status === 'hidden' ? (
            <p className="panel__empty">
              <FormattedMessage id="office.department.agentsHidden" />
            </p>
          ) : agents.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="office.department.noAgents" />
            </p>
          ) : (
            <ul className="agent-list">
              {agents.map((specialist) => (
                <AgentPresence key={specialist.id} specialist={specialist} departmentSlug={slug} />
              ))}
            </ul>
          )}
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
 * An agent's place (level 3), reserved: it shows who the agent is from its record, and what its
 * workspace will hold. It never shows a task or activity the agent does not have.
 */
export function AgentPlace({ slug, agentId }: { readonly slug: string; readonly agentId: string }) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const department = findBySlug(readyList(departments), slug);
  const agent = readyList(specialists).find(
    (s) => s.id === agentId && s.departmentId === department?.id,
  );
  if (departments.status === 'loading' || specialists.status === 'loading') {
    return (
      <p className="page-notice" role="status">
        <FormattedMessage id="office.scene.loading" />
      </p>
    );
  }
  if (department === undefined || agent === undefined) return <NotFound />;
  const state = agentStateOf(agent);
  return (
    <article
      className="dept-office"
      style={{ '--zone-hue': lookOf(department).hue } as CSSProperties}
    >
      <OfficeBreadcrumb
        trail={[
          { label: departmentName(intl, department), path: paths.office(officeSlug(department)) },
          { label: agent.displayName },
        ]}
      />
      <header className="dept-office__header">
        <AgentAvatar name={agent.displayName} size={56} />
        <div>
          <h1 className="dept-office__title">{agent.displayName}</h1>
          <p className="dept-office__summary">
            {departmentName(intl, department, 'name')}
            {state === undefined ? null : (
              <>
                {' '}
                · <AgentStatus state={state} />
              </>
            )}
          </p>
        </div>
      </header>
      <ComingAreas
        titleId="office.agent.coming"
        areas={['currentTask', 'project', 'documents', 'activity', 'tools', 'results']}
      />
    </article>
  );
}

export function GiaPlace() {
  return (
    <article className="dept-office">
      <OfficeBreadcrumb trail={[{ label: <FormattedMessage id="gia.name" /> }]} />
      <header className="dept-office__header">
        <span className="dept-office__icon" aria-hidden="true">
          <Icon name="gia" size={26} />
        </span>
        <div>
          <h1 className="dept-office__title">
            <FormattedMessage id="gia.name" />
          </h1>
          <p className="dept-office__summary">
            <FormattedMessage id="gia.role" />
          </p>
        </div>
      </header>
      <p className="page-notice">
        <FormattedMessage id="gia.page.notYet" />
      </p>
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
