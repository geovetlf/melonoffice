import {
  FormattedMessage,
  I18nProvider,
  useIntl,
  type Locale,
  type Messages,
} from '@melonoffice/i18n';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityProvider } from '../activity/ActivityFeed.js';
import { createActivityClient } from '../activity/activityClient.js';
import { BusinessPage } from '../business/BusinessPage.js';
import { createBusinessClient } from '../business/businessClient.js';
import { HOME_TIME_ZONE } from '../business/defaults.js';
import { ConnectionsPage, permissionsOf } from '../connections/ConnectionsPage.js';
import { createConnectionsClient } from '../connections/connectionsClient.js';
import { ConversationsCenter } from '../conversations/ConversationsCenter.js';
import { createInboxClient } from '../conversations/inboxClient.js';
import { CustomersSection, todayIn } from '../customers/CustomersSection.js';
import { createCustomersClient } from '../customers/customersClient.js';
import { OpportunitiesSection } from '../opportunities/OpportunitiesSection.js';
import { createOpportunitiesClient } from '../opportunities/opportunitiesClient.js';
import { HomePage } from '../home/HomePage.js';
import { useAuth, useCan } from '../identity/AuthProvider.js';
import type { LocaleProps } from '../identity/pages.js';
import { usePath } from '../identity/router.js';
import { GiaChatProvider } from '../gia/GiaChat.js';
import { createGiaClient } from '../gia/giaClient.js';
import { GiaWorkplace } from '../gia/GiaWorkplace.js';
import { AgentPlace, DepartmentOffice, NotFound } from '../office/DepartmentOffice.js';
import { createOfficeClient } from '../office/officeClient.js';
import { MemoryPage } from '../memory/MemoryPage.js';
import { createMemoryClient } from '../memory/memoryClient.js';
import { OfficeDataProvider, useOfficeData } from '../office/OfficeData.js';
import { parseRoute } from './routes.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';

/**
 * The signed-in frame (ADR-0036, ADR-0040): the sidebar and top bar around the page the path
 * names: the Home (the office), a department's office, GIA, or the Conversations Center
 * (ADR-0035), Settings → Connections (ADR-0044) or Settings → Business (ADR-0048). The office's activity (ADR-0049) is read only by a role
 * that may read it. Every page reaches the API only through the session's authenticated client, for the
 * organization the API gave this user; none has sign-in, tenant choice or permission rules of its
 * own.
 */
export function AppShell(locale: LocaleProps) {
  const { state, services, signOut } = useAuth();
  const canReadConversations = useCan('conversation.read');
  const canReadConnections = useCan('channel.read');
  const canReadBusiness = useCan('organization.read');
  const canEditBusiness = useCan('organization.update');
  const canReadActivity = useCan('activity.read');
  const canAskGia = useCan('gia.ask');
  const canReadContacts = useCan('contact.read');
  const canManageContacts = useCan('contact.manage');
  const canReadOpportunities = useCan('opportunity.read');
  const canManageOpportunities = useCan('opportunity.manage');
  const canManagePipeline = useCan('pipeline.manage');
  const canReadKnowledge = useCan('knowledge.read');
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
            activity: createActivityClient(services.api.request, organizationId),
            gia: createGiaClient(services.api.request, organizationId),
            customers: createCustomersClient(services.api.request, organizationId),
            opportunities: createOpportunitiesClient(services.api.request, organizationId),
            memory: createMemoryClient(services.api.request, organizationId),
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
      // The Home is always the first screen: describing the business lives in the company's
      // memory (ADR-0056), never in front of the Home.
      page = <HomePage />;
      break;
    case 'memory':
      page =
        canReadBusiness || canReadKnowledge ? (
          <div className="light-surface">
            <MemoryPage
              client={clients.memory}
              can={can}
              {...(canReadBusiness
                ? {
                    business: (
                      <BusinessPage
                        client={clients.business}
                        organizationName={workspace.organization.name}
                        canEdit={canEditBusiness}
                      />
                    ),
                  }
                : {})}
            />
          </div>
        ) : (
          <NotFound />
        );
      break;
    case 'office':
      page = (
        <DepartmentOffice
          slug={route.slug}
          customers={
            canReadContacts ? (
              <BusinessTimeZone>
                {(timeZone) => (
                  <CustomersSection
                    client={clients.customers}
                    canManage={canManageContacts}
                    currentUserId={me.userId}
                    timeZone={timeZone}
                  />
                )}
              </BusinessTimeZone>
            ) : undefined
          }
          opportunities={
            canReadOpportunities ? (
              <BusinessTimeZone>
                {(timeZone) => (
                  <OpportunitiesSection
                    client={clients.opportunities}
                    {...(canReadContacts ? { customers: clients.customers } : {})}
                    canManage={canManageOpportunities}
                    canManagePipeline={canManagePipeline}
                    currentUserId={me.userId}
                    today={todayIn(timeZone)}
                  />
                )}
              </BusinessTimeZone>
            ) : undefined
          }
        />
      );
      break;
    case 'agent':
      page = <AgentPlace slug={route.slug} agentId={route.agentId} />;
      break;
    case 'gia':
      page = <GiaWorkplace />;
      break;
    case 'conversations':
      page = canReadConversations ? (
        <div className="light-surface">
          {canReadContacts ? (
            <BusinessTimeZone>
              {(timeZone) => (
                <ConversationsCenter
                  client={clients.inbox}
                  currentUserId={me.userId}
                  can={can}
                  commercial={{ read: clients.customers.get, today: todayIn(timeZone) }}
                />
              )}
            </BusinessTimeZone>
          ) : (
            <ConversationsCenter client={clients.inbox} currentUserId={me.userId} can={can} />
          )}
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
      <ActivityProvider client={canReadActivity ? clients.activity : undefined}>
        <BusinessFormats locale={locale.locale}>
          <GiaChatProvider client={canAskGia ? clients.gia : undefined}>
            <div className="app">
              <Sidebar
                route={route}
                canReadConversations={canReadConversations}
                canReadConnections={canReadConnections}
                canReadMemory={canReadBusiness || canReadKnowledge}
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
          </GiaChatProvider>
        </BusinessFormats>
      </ActivityProvider>
    </OfficeDataProvider>
  );
}

/** The business's time zone once it is described, else the default of ADR-0048. */
function BusinessTimeZone({ children }: { readonly children: (timeZone: string) => ReactNode }) {
  const { business } = useOfficeData();
  const profile = business.status === 'ready' ? business.value.profile : null;
  return <>{children(profile?.timeZone ?? HOME_TIME_ZONE)}</>;
}

/**
 * Dates, numbers and money follow the business's country once it is described (ADR-0048): a
 * Peruvian business in Spanish formats as es-PE. The words stay the chosen language's.
 */
function BusinessFormats({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}) {
  const { business } = useOfficeData();
  // The words stay the ones already chosen above (the language's catalog, or a test's own).
  const { messages } = useIntl();
  const country =
    business.status === 'ready' && business.value.profile !== null
      ? business.value.profile.country
      : undefined;
  // Always the same element, so the page below is never remounted when the profile arrives.
  return (
    <I18nProvider
      locale={locale}
      messages={messages as Messages}
      {...(country === undefined ? {} : { region: country })}
    >
      {children}
    </I18nProvider>
  );
}
