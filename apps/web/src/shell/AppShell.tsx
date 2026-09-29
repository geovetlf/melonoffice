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
import { AutomationsPage } from '../automations/AutomationsPage.js';
import { createAutomationsClient } from '../automations/automationsClient.js';
import { BusinessPage } from '../business/BusinessPage.js';
import { createBusinessClient } from '../business/businessClient.js';
import { HOME_TIME_ZONE } from '../business/defaults.js';
import { ConnectionsPage, permissionsOf } from '../connections/ConnectionsPage.js';
import { createConnectionsClient } from '../connections/connectionsClient.js';
import { ConversationsCenter } from '../conversations/ConversationsCenter.js';
import { createInboxClient } from '../conversations/inboxClient.js';
import { CustomersSection, todayIn } from '../customers/CustomersSection.js';
import { createCustomersClient } from '../customers/customersClient.js';
import { FollowUpsSection } from '../followUps/FollowUps.js';
import { createFollowUpsClient } from '../followUps/followUpsClient.js';
import { OpportunitiesSection } from '../opportunities/OpportunitiesSection.js';
import { createOpportunitiesClient } from '../opportunities/opportunitiesClient.js';
import { HomePage } from '../home/HomePage.js';
import { useAuth, useCan } from '../identity/AuthProvider.js';
import type { LocaleProps } from '../identity/pages.js';
import { usePath } from '../identity/router.js';
import { GiaChatProvider } from '../gia/GiaChat.js';
import { GiaQuickAsk } from '../gia/GiaQuickAsk.js';
import { createGiaClient } from '../gia/giaClient.js';
import { GiaWorkplace } from '../gia/GiaWorkplace.js';
import { AgentPlace, DepartmentOffice, NotFound } from '../office/DepartmentOffice.js';
import { createOfficeClient } from '../office/officeClient.js';
import { createAgentTasksClient } from '../office/agentTasksClient.js';
import { MemoryPage } from '../memory/MemoryPage.js';
import { ReportsPage, ReportsSection } from '../reports/Reports.js';
import { createReportsClient } from '../reports/reportsClient.js';
import { AIUsagePage } from '../aiUsage/AIUsagePage.js';
import { CommandCenterPage } from '../commandCenter/CommandCenterPage.js';
import { AgentsPage } from '../agents/AgentsPage.js';
import { createAgentsClient } from '../agents/agentsClient.js';
import { ApprovalsPage } from '../approvals/ApprovalsPage.js';
import { createApprovalsClient } from '../approvals/approvalsClient.js';
import { createAIUsageClient } from '../aiUsage/aiUsageClient.js';
import { PlatformPage } from '../platform/PlatformPage.js';
import { createPlatformClient } from '../platform/platformClient.js';
import { DocumentsPage } from '../documents/DocumentsPage.js';
import { createDocumentsClient } from '../documents/documentsClient.js';
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
  const canReadFollowUps = useCan('follow_up.read');
  const canManageFollowUps = useCan('follow_up.manage');
  const canReadKnowledge = useCan('knowledge.read');
  const canReadReports = useCan('report.read');
  const canReadDocuments = useCan('document.read');
  const canUploadDocuments = useCan('document.upload');
  const canReadAIUsage = useCan('ai_usage.read');
  const canReadApprovals = useCan('approval.read');
  const canManageAgents = useCan('specialist.manage');
  const canReadTools = useCan('tool.read');
  // Agent tasks (ADR-0063): read with the agents, asked only with `specialist.task`.
  const canReadAgents = useCan('specialist.read');
  const canAskAgents = useCan('specialist.task');
  // Automations (WF-3): workflows and their plans; approving a plan starts it (ADR-0070).
  const canReadWorkflows = useCan('workflow.read');
  const canReadPlans = useCan('plan.read');
  const canPlanWorkflows = useCan('plan.create');
  const canDecidePlans = useCan('approval.approve');
  const canManageWorkflows = useCan('workflow.manage');
  const route = parseRoute(usePath());
  const [menuOpen, setMenuOpen] = useState(false);
  // The platform AI view (ADR-0082) is the MelonOffice platform administrator's, never a
  // company role: the server says who that is, and refuses everyone else whatever this shows.
  const signedIn = state.status === 'signed_in';
  const platform = useMemo(() => createPlatformClient(services.api.request), [services]);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void platform.access().then((admin) => live && setPlatformAdmin(admin));
    return () => {
      live = false;
    };
  }, [platform, signedIn]);
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
            followUps: createFollowUpsClient(services.api.request, organizationId),
            memory: createMemoryClient(services.api.request, organizationId),
            reports: createReportsClient(services.api.request, organizationId),
            documents: createDocumentsClient(services.api.request, organizationId),
            aiUsage: createAIUsageClient(services.api.request, organizationId),
            approvals: createApprovalsClient(services.api.request, organizationId),
            agents: createAgentsClient(services.api.request, organizationId),
            agentTasks: createAgentTasksClient(services.api.request, organizationId),
            automations: createAutomationsClient(services.api.request, organizationId),
          },
    [services, organizationId],
  );
  const can = useMemo(
    () => (permission: string) => workspace?.permissions.has(permission) === true,
    [workspace],
  );
  if (state.status !== 'signed_in' || workspace === undefined || clients === undefined) return null;
  const { me } = state;
  // A contact's and an opportunity's follow-ups (C5), for a role that may read them.
  const followUps = canReadFollowUps
    ? { client: clients.followUps, canManage: canManageFollowUps }
    : undefined;

  let page;
  switch (route.kind) {
    case 'home':
      // The Home is always the first screen: describing the business lives in the company's
      // memory (ADR-0056), never in front of the Home.
      page = (
        <HomePage
          canReadAIUsage={canReadAIUsage}
          followUps={canReadFollowUps ? clients.followUps : undefined}
          approvals={canReadApprovals ? clients.approvals : undefined}
        />
      );
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
          {...(canReadReports
            ? {
                reports: (typeId: string) => (
                  <ReportsSection client={clients.reports} department={typeId} />
                ),
              }
            : {})}
          followUps={
            canReadFollowUps ? (
              <FollowUpsSection client={clients.followUps} canManage={canManageFollowUps} />
            ) : undefined
          }
          customers={
            canReadContacts ? (
              <BusinessTimeZone>
                {(timeZone) => (
                  <CustomersSection
                    client={clients.customers}
                    canManage={canManageContacts}
                    currentUserId={me.userId}
                    timeZone={timeZone}
                    {...(followUps === undefined ? {} : { followUps })}
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
                    {...(followUps === undefined ? {} : { followUps })}
                  />
                )}
              </BusinessTimeZone>
            ) : undefined
          }
        />
      );
      break;
    case 'agent':
      page = (
        <AgentPlace
          slug={route.slug}
          agentId={route.agentId}
          {...(canReadAgents
            ? {
                tasks: { client: clients.agentTasks, canAsk: canAskAgents },
                agents: clients.agents,
              }
            : {})}
        />
      );
      break;
    case 'agents':
      page = canReadAgents ? (
        <div className="light-surface">
          <AgentsPage
            client={clients.agents}
            canManage={canManageAgents}
            canReadTools={canReadTools}
          />
        </div>
      ) : (
        <NotFound />
      );
      break;
    case 'gia':
      page = <GiaWorkplace />;
      break;
    case 'reports':
      page = canReadReports ? <ReportsPage client={clients.reports} /> : <NotFound />;
      break;
    case 'documents':
      page = canReadDocuments ? (
        <div className="light-surface">
          <DocumentsPage client={clients.documents} canUpload={canUploadDocuments} />
        </div>
      ) : (
        <NotFound />
      );
      break;
    case 'approvals':
      page = canReadApprovals ? (
        <div className="light-surface">
          <ApprovalsPage
            client={clients.approvals}
            canDecide={canDecidePlans}
            canReadPlans={canReadPlans}
          />
        </div>
      ) : (
        <NotFound />
      );
      break;
    case 'commandCenter':
      page =
        canReadAIUsage || canReadApprovals || canReadAgents || canReadPlans ? (
          <div className="light-surface">
            <CommandCenterPage
              aiUsage={canReadAIUsage ? clients.aiUsage : undefined}
              approvals={canReadApprovals ? clients.approvals : undefined}
              automations={canReadPlans ? clients.automations : undefined}
            />
          </div>
        ) : (
          <NotFound />
        );
      break;
    case 'platform':
      page = platformAdmin ? (
        <div className="light-surface">
          <PlatformPage client={platform} />
        </div>
      ) : (
        <NotFound />
      );
      break;
    case 'aiUsage':
      page = canReadAIUsage ? (
        <div className="light-surface">
          <AIUsagePage client={clients.aiUsage} />
        </div>
      ) : (
        <NotFound />
      );
      break;
    case 'automations':
      page =
        canReadWorkflows || canReadPlans ? (
          <div className="light-surface">
            <AutomationsPage
              client={clients.automations}
              permissions={{
                readWorkflows: canReadWorkflows,
                readPlans: canReadPlans,
                planWorkflows: canPlanWorkflows,
                decidePlans: canDecidePlans,
                manageWorkflows: canManageWorkflows,
              }}
              templates={canReadAgents ? clients.agents.templates : undefined}
            />
          </div>
        ) : (
          <NotFound />
        );
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
          <GiaChatProvider
            client={canAskGia ? clients.gia : undefined}
            {...(canManageFollowUps ? { followUps: clients.followUps } : {})}
            {...(canAskAgents ? { agentTasks: clients.agentTasks } : {})}
          >
            <div className="app">
              <Sidebar
                route={route}
                canReadConversations={canReadConversations}
                canReadConnections={canReadConnections}
                canReadMemory={canReadBusiness || canReadKnowledge}
                canReadReports={canReadReports}
                canReadDocuments={canReadDocuments}
                canReadAIUsage={canReadAIUsage}
                platformAdmin={platformAdmin}
                canReadApprovals={canReadApprovals}
                canReadAgents={canReadAgents}
                canReadAutomations={canReadWorkflows || canReadPlans}
                canReadCommandCenter={
                  canReadAIUsage || canReadApprovals || canReadAgents || canReadPlans
                }
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
            <GiaQuickAsk />
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
