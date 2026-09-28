import { FormattedMessage } from '@melonoffice/i18n';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BusinessPage } from '../business/BusinessPage.js';
import { createBusinessClient } from '../business/businessClient.js';
import { ConnectionsPage, permissionsOf } from '../connections/ConnectionsPage.js';
import { createConnectionsClient } from '../connections/connectionsClient.js';
import { ConversationsCenter } from '../conversations/ConversationsCenter.js';
import { createInboxClient } from '../conversations/inboxClient.js';
import { HomePage } from '../home/HomePage.js';
import { useAuth, useCan } from '../identity/AuthProvider.js';
import type { LocaleProps } from '../identity/pages.js';
import { usePath } from '../identity/router.js';
import { AgentPlace, DepartmentOffice, GiaPlace, NotFound } from '../office/DepartmentOffice.js';
import { createOfficeClient } from '../office/officeClient.js';
import { OfficeDataProvider, useOfficeData } from '../office/OfficeData.js';
import { parseRoute } from './routes.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';

/**
 * The signed-in frame (ADR-0036, ADR-0040): the sidebar and top bar around the page the path
 * names: the Home (the office), a department's office, GIA, or the Conversations Center
 * (ADR-0035), Settings → Connections (ADR-0044) or Settings → Business (ADR-0048). Every page reaches the API only through the session's authenticated client, for the
 * organization the API gave this user; none has sign-in, tenant choice or permission rules of its
 * own.
 */
export function AppShell(locale: LocaleProps) {
  const { state, services, signOut } = useAuth();
  const canReadConversations = useCan('conversation.read');
  const canReadConnections = useCan('channel.read');
  const canReadBusiness = useCan('organization.read');
  const canEditBusiness = useCan('organization.update');
  const route = parseRoute(usePath());
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    globalThis.addEventListener('keydown', close);
    return () => globalThis.removeEventListener('keydown', close);
  }, [menuOpen]);
  const workspace = state.status === 'signed_in' ? state.workspace : undefined;
  const organizationId = workspace?.organization.id;
  const clients = useMemo(
    () =>
      organizationId === undefined
        ? undefined
        : {
            inbox: createInboxClient(services.api.request, organizationId),
            office: createOfficeClient(services.api.request, organizationId),
            connections: createConnectionsClient(services.api.request, organizationId),
            business: createBusinessClient(services.api.request, organizationId),
          },
    [services, organizationId],
  );
  const can = useMemo(
    () => (permission: string) => workspace?.permissions.has(permission) === true,
    [workspace],
  );
  if (state.status !== 'signed_in' || workspace === undefined || clients === undefined) return null;
  const { me } = state;

  let page;
  switch (route.kind) {
    case 'home':
      page = (
        <FirstBusinessStep
          show={canEditBusiness}
          step={
            <div className="light-surface">
              <BusinessPage
                client={clients.business}
                organizationName={workspace.organization.name}
                canEdit
                onboarding
              />
            </div>
          }
        >
          <HomePage />
        </FirstBusinessStep>
      );
      break;
    case 'business_profile':
      page = canReadBusiness ? (
        <div className="light-surface">
          <BusinessPage
            client={clients.business}
            organizationName={workspace.organization.name}
            canEdit={canEditBusiness}
          />
        </div>
      ) : (
        <NotFound />
      );
      break;
    case 'office':
      page = <DepartmentOffice slug={route.slug} />;
      break;
    case 'agent':
      page = <AgentPlace slug={route.slug} agentId={route.agentId} />;
      break;
    case 'gia':
      page = <GiaPlace />;
      break;
    case 'conversations':
      page = canReadConversations ? (
        <div className="light-surface">
          <ConversationsCenter client={clients.inbox} currentUserId={me.userId} can={can} />
        </div>
      ) : (
        <div className="page-notice">
          <h1>
            <FormattedMessage id="nav.communications" />
          </h1>
          <p>
            <FormattedMessage id="home.noConversations" />
          </p>
        </div>
      );
      break;
    case 'connections':
      page = canReadConnections ? (
        <div className="light-surface">
          <ConnectionsPage
            client={clients.connections}
            permissions={permissionsOf(can)}
            apiUrl={services.api.baseUrl}
          />
        </div>
      ) : (
        <NotFound />
      );
      break;
    default:
      page = <NotFound />;
  }

  return (
    <OfficeDataProvider client={clients.office} business={clients.business} can={can}>
      <div className="app">
        <Sidebar
          route={route}
          canReadConversations={canReadConversations}
          canReadConnections={canReadConnections}
          canReadBusiness={canReadBusiness}
          open={menuOpen}
          onNavigate={() => setMenuOpen(false)}
        />
        {menuOpen ? (
          <div className="app__scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />
        ) : null}
        <div className="app__body">
          <TopBar
            organizationName={workspace.organization.name}
            email={me.email ?? me.userId}
            onSignOut={signOut}
            menuOpen={menuOpen}
            onMenu={() => setMenuOpen((open) => !open)}
            locale={locale}
          />
          <main className="app__main" key={route.kind === 'office' ? route.slug : route.kind}>
            {page}
          </main>
        </div>
      </div>
    </OfficeDataProvider>
  );
}

/**
 * The first step of a new organization (ADR-0048): while its business is not described, the
 * person who can describe it sees the business form in place of the Home. Everyone else, and every
 * other page, is unaffected; once it is saved the Home appears.
 */
function FirstBusinessStep({
  show,
  step,
  children,
}: {
  readonly show: boolean;
  readonly step: ReactNode;
  readonly children: ReactNode;
}) {
  const { business } = useOfficeData();
  const missing = business.status === 'ready' && business.value.profile === null;
  return <>{show && missing ? step : children}</>;
}
