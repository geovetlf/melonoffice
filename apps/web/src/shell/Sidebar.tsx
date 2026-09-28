import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import type { ReactNode } from 'react';
import { navigate } from '../identity/router.js';
import { departmentName, lookOf, officeDepartments, officeSlug } from '../office/departments.js';
import { Icon, type IconName } from '../office/icons.js';
import { departmentPriority, readyList, useOfficeData } from '../office/OfficeData.js';
import { paths, type Route } from './routes.js';

/**
 * The sidebar (ADR-0040): the office (Home, GIA and each department's room, from the
 * organization's departments) apart from the product's tools. A tool that does not exist yet is
 * shown as coming, never as a link to nowhere.
 */

const TOOLS: readonly { readonly id: string; readonly icon: IconName }[] = [
  { id: 'projects', icon: 'projects' },
  { id: 'documents', icon: 'documents' },
  { id: 'calendar', icon: 'calendar' },
  { id: 'communications', icon: 'communications' },
  { id: 'automations', icon: 'automations' },
  { id: 'reports', icon: 'reports' },
  { id: 'apps', icon: 'apps' },
  { id: 'settings', icon: 'settings' },
];

export function Sidebar({
  route,
  canReadConversations,
  canReadConnections = false,
  canReadBusiness = false,
  open,
  onNavigate,
}: {
  readonly route: Route;
  readonly canReadConversations: boolean;
  /** Settings → Connections, for a person with `channel.read` (ADR-0044). */
  readonly canReadConnections?: boolean;
  /** Settings → Business, for a member who can read the organization (ADR-0048). */
  readonly canReadBusiness?: boolean;
  readonly open: boolean;
  readonly onNavigate: () => void;
}) {
  const intl = useIntl();
  const { departments, business } = useOfficeData();
  const { headquarters, floor } = officeDepartments(
    readyList(departments),
    departmentPriority(business),
  );
  const go = (path: string) => {
    navigate(path);
    onNavigate();
  };
  const currentSlug = route.kind === 'office' || route.kind === 'agent' ? route.slug : undefined;
  return (
    <aside id="app-sidebar" className={`sidebar${open ? ' sidebar--open' : ''}`}>
      <div className="sidebar__brand">
        <span className="sidebar__logo">
          <FormattedMessage id="app.logo" />
        </span>
        <span className="sidebar__tagline">
          <FormattedMessage id="app.tagline" />
        </span>
      </div>
      <nav aria-label={intl.formatMessage({ id: 'nav.office' })} className="sidebar__nav">
        <p className="sidebar__heading">
          <FormattedMessage id="nav.office" />
        </p>
        <ul>
          <NavLink icon="home" path={paths.home()} current={route.kind === 'home'} go={go}>
            <FormattedMessage id="nav.home" />
          </NavLink>
          <NavLink icon="gia" path={paths.gia()} current={route.kind === 'gia'} go={go}>
            <FormattedMessage id="gia.name" />
          </NavLink>
          {[...headquarters, ...floor].map((department) => {
            const slug = officeSlug(department);
            return (
              <NavLink
                key={department.id}
                icon={lookOf(department).icon}
                path={paths.office(slug)}
                current={currentSlug === slug}
                go={go}
                room
              >
                {departmentName(intl, department)}
              </NavLink>
            );
          })}
        </ul>
      </nav>
      <nav aria-label={intl.formatMessage({ id: 'nav.tools' })} className="sidebar__nav">
        <p className="sidebar__heading">
          <FormattedMessage id="nav.tools" />
        </p>
        <ul>
          {TOOLS.map((tool) =>
            tool.id === 'communications' && canReadConversations ? (
              <NavLink
                key={tool.id}
                icon={tool.icon}
                path={paths.conversations()}
                current={route.kind === 'conversations'}
                go={go}
              >
                <FormattedMessage id={`nav.${tool.id}`} />
              </NavLink>
            ) : tool.id === 'settings' && canReadConnections ? (
              <NavLink
                key={tool.id}
                icon={tool.icon}
                path={paths.connections()}
                current={route.kind === 'connections'}
                go={go}
              >
                <FormattedMessage id={`nav.${tool.id}`} />
              </NavLink>
            ) : (
              <li key={tool.id}>
                <span className="sidebar__item sidebar__item--soon" aria-disabled="true">
                  <Icon name={tool.icon} size={18} />
                  <span className="sidebar__label">
                    <FormattedMessage id={`nav.${tool.id}`} />
                  </span>
                  <span className="sidebar__soon">
                    <FormattedMessage id="common.soon" />
                  </span>
                </span>
              </li>
            ),
          )}
          {canReadBusiness ? (
            <NavLink
              icon="building"
              path={paths.business()}
              current={route.kind === 'business_profile'}
              go={go}
            >
              <FormattedMessage id="nav.business" />
            </NavLink>
          ) : null}
        </ul>
      </nav>
      <PlanCard />
    </aside>
  );
}

function NavLink({
  icon,
  path,
  current,
  go,
  room = false,
  children,
}: {
  readonly icon: IconName;
  readonly path: string;
  readonly current: boolean;
  readonly go: (path: string) => void;
  readonly room?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li>
      <a
        href={path}
        className={`sidebar__item${room ? ' sidebar__item--room' : ''}`}
        aria-current={current ? 'page' : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          go(path);
        }}
      >
        <Icon name={icon} size={18} />
        <span className="sidebar__label">{children}</span>
      </a>
    </li>
  );
}

/**
 * The organization's plan and credits, from billing (ADR-0022) and the wallet (ADR-0023). Only
 * Emprendedor is active at launch, so no upgrade is offered.
 */
function PlanCard() {
  const intl = useIntl();
  const { billing, credits } = useOfficeData();
  if (billing.status === 'hidden' && credits.status === 'hidden') return null;
  const planId =
    billing.status === 'ready' && billing.value.status === 'present'
      ? billing.value.subscription.plan.id
      : undefined;
  const planKey = planId === undefined ? undefined : `plan.${planId}.name`;
  const balance =
    credits.status === 'ready' && credits.value.status === 'present'
      ? credits.value.balance
      : undefined;
  return (
    <section className="plan-card" aria-label={intl.formatMessage({ id: 'plan.label' })}>
      <p className="plan-card__name">
        {planKey !== undefined && intl.messages[planKey] !== undefined ? (
          <FormattedMessage id={planKey} />
        ) : (
          <FormattedMessage id="plan.label" />
        )}
      </p>
      {balance === undefined ? null : (
        <p className="plan-card__credits">
          <FormattedMessage id="plan.credits" values={{ count: balance }} />
        </p>
      )}
    </section>
  );
}
