import { createAIUsageLedger, type AIUsageStore } from '@melonoffice/ai-usage';
import { createActivityService } from '@melonoffice/activity';
import {
  createAgentTaskService,
  type AgentTaskRepository,
  type TaskKickoff,
} from '@melonoffice/agents';
import {
  createCompanyBrain,
  createGatewayKnowledgeExtractor,
  knowledgeItemId,
  organizationKnowledge,
  type KnowledgeRepository,
} from '@melonoffice/brain';
import {
  createAIGateway,
  createModelPolicyCatalogue,
  defaultProviderRegistry,
  createProviderHealthTracker,
  type AICreditsPort,
  type CreditRate,
  type ModelPolicyCatalogue,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import { createApprovalService, type ApprovalRepository } from '@melonoffice/approvals';
import type { AuditHistoryReader, AuditReader, AuditService } from '@melonoffice/audit';
import type { AuthDependencies } from '@melonoffice/auth';
import {
  createBusinessProfileService,
  type BusinessProfileRepository,
} from '@melonoffice/business';
import { createBillingService, type BillingStore } from '@melonoffice/billing';
import { createDepartmentService, type DepartmentRepository } from '@melonoffice/departments';
import {
  createDocumentService,
  type DocumentRepository,
  type FileStore,
  type TextExtractor,
} from '@melonoffice/documents';
import {
  createConversationAssistant,
  createOpportunityService,
  readPipelineSummary,
  createConversationService,
  createCustomerService,
  createCommercialInsights,
  createFollowUpService,
  ConversationError,
  type FollowUpScheduler,
  type FollowUpService,
  type ConversationRepository,
} from '@melonoffice/conversations';
import { createCreditService, type CreditStore } from '@melonoffice/credits';
import {
  createEntitlementService,
  type EntitlementService,
  type OverrideSource,
} from '@melonoffice/entitlements';
import {
  createAgentOutputStore,
  createExecutionService,
  type AgentOutputRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import {
  createForecastEngine,
  createMetricHistory,
  createRecordSources,
  type ForecastContextPort,
  type ForecastLimits,
  type ForecastModelProvider,
  type ForecastRepository,
  type ForecastScheduler,
} from '@melonoffice/forecasting';
import { createDecisionEngine, DECIDERS } from '@melonoffice/decisions';
import { createGia } from '@melonoffice/gia';
import type { DeploymentEnvironment, OrganizationId } from '@melonoffice/domain';
import { createToolGate } from '@melonoffice/guardrails';
import {
  createChannelConnectionService,
  createChannelMessageExecutor,
  createConversationAgentCheck,
  createHandoffSummaries,
  createIntegrationRegistry,
  createChannelTemplateService,
  createFollowUpScheduleExecutor,
  createGatedFollowUpCreate,
  createMessageSendService,
  type ChannelConnectionRepository,
  type ChannelTemplateRepository,
  type IntegrationEngine,
  type WebhookIngress,
} from '@melonoffice/integrations';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  createSpecialistService,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import {
  createDelegation,
  createPlanCancellationCascade,
  createPlanConductor,
  createPlanService,
  createPlanValidator,
  type PlanRepository,
} from '@melonoffice/planning';
import { resolveTenant, type TenancyStore } from '@melonoffice/tenancy';
import { defaultToolRegistry, type ToolRegistry } from '@melonoffice/tools';
import { createWorkflowService, type WorkflowRepository } from '@melonoffice/workflows';
import { Hono, type Context } from 'hono';
import type { AgentTurns } from './agent-turns.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerAuthRoutes, type AuthEnv } from './auth.js';
import { registerCors } from './cors.js';
import { registerBillingRoutes } from './billing.js';
import { DEFAULT_ACTIVITY_TIME_ZONE, registerActivityRoutes } from './activity.js';
import { registerBrainRoutes } from './brain.js';
import { registerBusinessRoutes } from './business.js';
import { registerCustomerRoutes } from './customers.js';
import { registerFollowUpRoutes } from './follow-ups.js';
import { registerForecastRoutes } from './forecasts.js';
import { registerMetricRoutes } from './metrics.js';
import { registerOpportunityRoutes } from './opportunities.js';
import { registerGiaRoutes } from './gia.js';
import { registerDepartmentRoutes } from './departments.js';
import { registerDocumentRoutes } from './documents.js';
import { registerConnectionRoutes } from './connections.js';
import { registerConversationRoutes } from './conversations.js';
import { registerCreditRoutes } from './credits.js';
import { registerAIUsageRoutes } from './ai-usage.js';
import { registerPlatformRoutes } from './platform.js';
import { registerEntitlementRoutes } from './entitlements.js';
import { registerExecutionRoutes } from './executions.js';
import { registerHealth } from './health.js';
import { registerPlanRoutes } from './plans.js';
import { registerSpecialistRoutes, toolLookupOf } from './specialists.js';
import { giaAgentsOf, registerAgentTaskRoutes } from './agent-tasks.js';
import { registerDecisionRoutes } from './decisions.js';
import { registerTenancyRoutes } from './tenancy.js';
import { registerToolRoutes } from './tools.js';
import { registerWebhookRoutes } from './webhooks.js';
import { registerWorkflowRoutes } from './workflows.js';

export const SERVICE_NAME = 'api';

export interface AppOptions {
  readonly logger: Logger;
  readonly version: string;
  /** Token verification and users. Absent: /v1 answers 503 (fails closed). */
  readonly auth?: AuthDependencies;
  /** Organizations and memberships. Absent: organization routes answer 503 (fails closed). */
  readonly tenancy?: TenancyStore;
  /** Where audit events go (ADR-0020). Absent: /v1 answers 503 (fails closed). */
  readonly audit?: AuditService;
  /** Role permissions (ADR-0019). Defaults to the built-in roles; tests may narrow them. */
  readonly authorization?: AuthorizationService;
  /**
   * Billing accounts and subscriptions (ADR-0022), the source of each organization's plan.
   * Absent: billing and entitlement routes answer 503 (fails closed).
   */
  readonly billing?: BillingStore;
  /**
   * What organizations' plans allow (ADR-0021). Defaults to the plan catalogue in code, with the
   * plan from billing; tests may pass another catalogue.
   */
  readonly entitlements?: EntitlementService;
  /**
   * Audited per-organization overrides (ADR-0044), applied after the plan by the default
   * entitlement service. Absent: none.
   */
  readonly entitlementOverrides?: OverrideSource;
  /** Executions (ADR-0024). Absent: the execution route answers 503 (fails closed). */
  readonly executions?: ExecutionRepository;
  /**
   * Departments and specialists (ADR-0025). Absent: their routes answer 503 (fails closed), and
   * an execution that names a specialist is refused.
   */
  readonly structure?: {
    readonly departments: DepartmentRepository;
    readonly specialists: SpecialistRepository;
  };
  /** The audit trail's read side (ADR-0049). Absent: the activity route answers 503. */
  readonly activity?: AuditReader & AuditHistoryReader;
  /** Business profiles (ADR-0048). Absent: the profile route answers 503 (fails closed). */
  readonly businessProfiles?: BusinessProfileRepository;
  /** Company Brain (ADR-0051). Absent: the brain routes answer 503 (fails closed). */
  readonly knowledge?: KnowledgeRepository;
  /**
   * Uploaded documents (ADR-0078). Absent: the document routes answer 503 (fails closed). Their
   * text also goes to Company Brain when it is configured (`knowledge`).
   */
  readonly documents?: {
    readonly repository: DocumentRepository;
    /** Where their bytes live (Cloud Storage). Absent: uploads and downloads answer 503. */
    readonly files?: FileStore;
    /**
     * Reads PDF and DOCX text (ADR-0079); a scanned PDF is then read through the AI Gateway.
     * Absent: those files are only stored.
     */
    readonly extractor?: TextExtractor;
  };
  /** The tool catalogue (ADR-0026). Defaults to the one in code, which is empty until tools exist. */
  readonly tools?: ToolRegistry;
  /** Tool approvals (ADR-0026). Absent: the approval routes answer 503 (fails closed). */
  readonly approvals?: ApprovalRepository;
  /** Credit wallets and their ledger (ADR-0023). Absent: the credits route answers 503. */
  readonly credits?: CreditStore;
  /**
   * The AI Usage Ledger (ADR-0074): the AI Gateway records every completed call's usage and cost
   * in it, and the usage routes read it. Absent: nothing is recorded and those routes answer 503.
   */
  readonly aiUsage?: AIUsageStore;
  /** Plans (ADR-0028). Absent: the plan routes answer 503 (fails closed). */
  readonly plans?: PlanRepository;
  /**
   * Queues a plan step's first node for the worker (WF-1, ADR-0070): with it, approving a plan
   * starts it. Absent: an approval is recorded and nothing runs.
   */
  readonly planRuntime?: TaskKickoff;
  /** Workflows (ADR-0028). Absent: the workflow routes answer 503 (fails closed). */
  readonly workflows?: WorkflowRepository;
  /**
   * Conversations, contacts and channel connections (ADR-0033). Absent: the inbox routes answer
   * 503 (fails closed). They also need departments (`structure`) to assign to one.
   */
  readonly conversations?: {
    readonly repository: ConversationRepository;
    readonly connections: ChannelConnectionRepository;
    /**
     * The organizations' provider-approved templates (ADR-0046). Absent: the template routes
     * answer 503 and every template message is refused.
     */
    readonly templates?: ChannelTemplateRepository;
    /** Where channel secrets live. Unset: no connection can be created. */
    readonly secretProjectId?: string;
    /**
     * Where follow-ups' tasks are queued for their time (C5, ADR-0058): the job transport's queue
     * and worker. Absent: follow-ups can be read, but creating or rescheduling one answers 503
     * (`follow_up_scheduler_unavailable`); nothing pretends to be scheduled.
     */
    readonly followUpScheduler?: FollowUpScheduler;
    /**
     * Agents' kept answers (CV-6B, ADR-0043), read only for the note an agent left when it handed
     * a conversation to a person. Absent: the detail shows no note.
     */
    readonly agentOutputs?: AgentOutputRepository;
    /**
     * The Integration Engine (ADR-0044): its provider registry, connection checks and sends.
     * Absent: no provider is registered, so no connection can be created, checked or used.
     */
    readonly engine?: IntegrationEngine;
    /**
     * A person's replies (CV-2, ADR-0034), through the tool gate and the engine. Absent (or no
     * engine): the send route answers 503 (fails closed). It also needs executions,
     * departments, specialists and approvals, which the gate is built from.
     */
    readonly outbound?: {
      /** Where this server runs, set explicitly: the tool runs only where its version allows. */
      readonly environment: DeploymentEnvironment;
    };
    /**
     * Where this server runs, for a person's business tools (TL-1, ADR-0068): a new follow-up
     * goes through the tool gate's `follow_up_schedule`. Absent: creating a follow-up answers 503
     * (`follow_up_tool_unavailable`); there is no path around the gate.
     */
    readonly toolEnvironment?: DeploymentEnvironment;
  };
  /**
   * The AI Gateway's configuration (ADR-0027), used today by assisted AI on conversations
   * (ADR-0037, ADR-0038; built by `aiConfigurationOf`). Every part fails closed: no environment,
   * no registered provider, no policy or no credit rate and every call is denied before any
   * provider is reached. Credits default to the credits engine (`credits`).
   */
  readonly ai?: {
    readonly environment?: DeploymentEnvironment;
    readonly registry?: ProviderRegistry;
    readonly policies?: ModelPolicyCatalogue;
    readonly creditRate?: CreditRate;
    readonly credits?: AICreditsPort;
  };
  /**
   * The Forecasting Engine (ADR-0059). Its series come from the conversations' records (C1, C2,
   * the inbox), so it also needs `conversations`, `credits` and `tenancy`. Absent: the forecast
   * routes answer 503 and GIA says forecasts are not available.
   */
  readonly forecasting?: {
    readonly repository: ForecastRepository;
    /** The model's runtime (TimesFM 2.5). Absent: every run is refused, never pretended. */
    readonly provider?: ForecastModelProvider;
    /** The existing job queue, to the worker. Absent: every run is refused. */
    readonly scheduler?: ForecastScheduler;
    /** Whole credits per model run. Absent: every run is refused (`forecast_price_not_set`). */
    readonly creditsPerRun?: number;
    readonly limits?: ForecastLimits;
    /** The clock periods are read from. Tests only. */
    readonly now?: () => Date;
  };
  /** Channel webhooks (ADR-0033). Absent: `/webhooks/*` answers 503. */
  readonly webhooks?: WebhookIngress;
  /**
   * Conversation agents (CV-6B, ADR-0043; built by `createAgentTurns`): hands a turn waiting on an
   * approval back to the worker once a person decides it. Absent: the decision is stored only.
   */
  readonly agentTurns?: Pick<AgentTurns, 'afterDecision'>;
  /**
   * Agent tasks (ADR-0063): what people ask the organization's agents. They also need executions
   * and `structure`. Absent: the task routes answer 503 (fails closed).
   */
  readonly agentTasks?: {
    readonly repository: AgentTaskRepository;
    /** Where the worker keeps agents' answers. Absent: tasks show no answer. */
    readonly outputs?: AgentOutputRepository;
    /**
     * Queues a started task's first job for the worker (`createAgentTurns`). Absent: a task is
     * created and started, and its job is never queued (nothing runs here).
     */
    readonly runtime?: TaskKickoff;
  };
  /**
   * The web app's exact origins, allowed to call `/v1` from a browser (ADR-0036). Empty or
   * absent: no CORS header is ever sent.
   */
  readonly webOrigins?: readonly string[];
  /**
   * The MelonOffice platform administrators' user ids (ADR-0082): only they read the platform AI
   * view (`/v1/platform/*`). Empty or absent: nobody.
   */
  readonly platformAdmins?: readonly string[];
}

type Env = AuthEnv;

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

export function createApp({
  logger,
  version,
  auth,
  tenancy,
  audit,
  authorization = createAuthorizationService(),
  billing,
  entitlements,
  entitlementOverrides,
  executions,
  structure,
  businessProfiles,
  knowledge,
  documents,
  activity,
  tools = defaultToolRegistry(),
  approvals,
  credits,
  aiUsage,
  plans,
  planRuntime,
  workflows,
  conversations,
  ai = {},
  forecasting,
  webhooks,
  agentTurns,
  agentTasks,
  webOrigins = [],
  platformAdmins = [],
}: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  /**
   * A text fact Company Brain holds about the organization (its kind of business, its currency),
   * or the business profile's while Company Brain has not been fed it (C2, ADR-0054).
   */
  async function companyFact(
    organizationId: OrganizationId,
    domain: 'identity' | 'finance',
    key: 'business_type' | 'currency',
  ): Promise<string | undefined> {
    const item = await knowledge?.findItem(
      organizationId,
      knowledgeItemId(organizationId, domain, key),
    );
    if (item?.status === 'active' && item.value.type === 'text') return item.value.text;
    const profile = await businessProfiles?.find(organizationId);
    return key === 'business_type' ? profile?.businessType : profile?.currency;
  }

  // Correlate every request with an id (reuse a well-formed incoming one) and log it.
  app.use('*', async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    const requestLogger = logger.child({ requestId });
    c.set('logger', requestLogger);
    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    const started = performance.now();
    await next();
    requestLogger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  registerHealth(app, { service: SERVICE_NAME, version });
  // Before authentication, so a browser's preflight (which has no token) is answered.
  registerCors(app, webOrigins);
  // Outside /v1: providers sign deliveries, they have no user token.
  registerWebhookRoutes(app, webhooks);
  registerAuthRoutes(app, auth, audit);
  if (auth !== undefined && audit !== undefined) {
    // A new organization's Company Brain starts with its name (ADR-0051).
    registerTenancyRoutes(app, tenancy, authorization, audit, async (auth, organization) => {
      if (brain === undefined || tenancy === undefined) return;
      const tenant = await resolveTenant(auth, organization.id, tenancy);
      const { source, facts } = organizationKnowledge(organization);
      await brain.ingest(tenant, source, facts);
    });
    if (tenancy !== undefined && billing !== undefined) {
      const billingService = createBillingService({ billing, organizations: tenancy });
      const dependencies = { store: tenancy, authorization, audit };
      registerBillingRoutes(app, { ...dependencies, billing: billingService });
      registerEntitlementRoutes(app, {
        ...dependencies,
        entitlements:
          entitlements ??
          createEntitlementService({
            organizations: tenancy,
            plans: billingService,
            ...(entitlementOverrides === undefined ? {} : { overrides: entitlementOverrides }),
          }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'billing_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/billing', unavailable);
      app.all('/v1/organizations/:organizationId/entitlements', unavailable);
    }
    const specialists =
      tenancy !== undefined && structure !== undefined
        ? createSpecialistService({
            repository: structure.specialists,
            departments: structure.departments,
            organizations: tenancy,
            authorization,
          })
        : undefined;
    // The one AI Gateway (ADR-0027), shared by assisted AI on conversations (ADR-0037) and
    // Company Brain's extraction (ADR-0051). The execution and specialist stores are there
    // because the gateway is built whole; an assisted call reads neither. The credits engine
    // accounts for every call; with no rate it denies all.
    const usageLedger = aiUsage === undefined ? undefined : createAIUsageLedger(aiUsage);
    const aiCredits =
      ai.credits ??
      (credits === undefined || tenancy === undefined
        ? undefined
        : createCreditService({ store: credits, organizations: tenancy }));
    // The gateway's health tracker, also read by the platform AI view (ADR-0082).
    const aiHealth = createProviderHealthTracker();
    const aiRegistry = ai.registry ?? defaultProviderRegistry();
    const aiPolicies = ai.policies ?? createModelPolicyCatalogue([]);
    const aiGateway =
      tenancy !== undefined && executions !== undefined && specialists !== undefined
        ? createAIGateway({
            executions,
            organizations: tenancy,
            specialists,
            authorization,
            registry: aiRegistry,
            policies: aiPolicies,
            health: aiHealth,
            environment: ai.environment,
            ...(aiCredits === undefined
              ? {}
              : { credits: { port: aiCredits, rate: ai.creditRate } }),
            audit,
            logger: logger.child({ component: 'ai-gateway' }),
            ...(usageLedger === undefined ? {} : { usage: usageLedger }),
          })
        : undefined;
    const brain =
      tenancy !== undefined && knowledge !== undefined
        ? createCompanyBrain({
            repository: knowledge,
            organizations: tenancy,
            authorization,
            ...(aiGateway === undefined
              ? {}
              : { extractor: createGatewayKnowledgeExtractor(aiGateway) }),
            logger: logger.child({ component: 'company-brain' }),
          })
        : undefined;
    if (tenancy !== undefined && businessProfiles !== undefined) {
      registerBusinessRoutes(app, {
        ...(brain === undefined ? {} : { brain }),
        store: tenancy,
        authorization,
        audit,
        profiles: createBusinessProfileService({
          repository: businessProfiles,
          organizations: tenancy,
          authorization,
        }),
      });
    } else if (tenancy !== undefined) {
      app.all('/v1/organizations/:organizationId/business-profile', (c) =>
        c.json({ error: 'business_not_configured' }, 503),
      );
    }
    const activityService =
      tenancy !== undefined && activity !== undefined
        ? createActivityService({ reader: activity, organizations: tenancy, authorization })
        : undefined;
    if (tenancy !== undefined && activityService !== undefined) {
      registerActivityRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        activity: activityService,
        ...(businessProfiles === undefined ? {} : { businessProfiles }),
      });
    } else if (tenancy !== undefined) {
      app.all('/v1/organizations/:organizationId/activity', (c) =>
        c.json({ error: 'activity_not_configured' }, 503),
      );
    }
    if (tenancy !== undefined && brain !== undefined) {
      registerBrainRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        brain,
        sources: {
          organizations: tenancy,
          ...(businessProfiles === undefined ? {} : { businessProfiles }),
          ...(structure === undefined
            ? {}
            : { departments: structure.departments, specialists: structure.specialists }),
          ...(conversations === undefined
            ? {}
            : {
                connections: conversations.connections,
                // Counted and summed where the records are stored (ADR-0061), never all read.
                contacts: {
                  counts: (organizationId) =>
                    conversations.repository.countContactStages(organizationId),
                },
                opportunities: {
                  summary: async (organizationId) =>
                    readPipelineSummary(
                      conversations.repository,
                      organizationId,
                      await companyFact(organizationId, 'finance', 'currency'),
                    ),
                },
              }),
        },
      });
    } else if (tenancy !== undefined) {
      app.all('/v1/organizations/:organizationId/brain', (c) =>
        c.json({ error: 'brain_not_configured' }, 503),
      );
      app.all('/v1/organizations/:organizationId/brain/*', (c) =>
        c.json({ error: 'brain_not_configured' }, 503),
      );
    }
    // Uploaded documents (ADR-0078): their text goes to Company Brain, as the person; PDF and DOCX
    // text is read by a library, or by the model for a scan (ADR-0079).
    if (tenancy !== undefined && documents !== undefined) {
      registerDocumentRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        documentsFor: (requestId) =>
          createDocumentService({
            repository: documents.repository,
            ...(documents.files === undefined ? {} : { files: documents.files }),
            authorization,
            ...(brain === undefined ? {} : { knowledge: brain }),
            // A PDF with no text layer is read by Gemini through the one AI Gateway (ADR-0079).
            ...(documents.extractor === undefined ? {} : { extractor: documents.extractor }),
            ...(aiGateway === undefined ? {} : { gateway: aiGateway }),
            logger: logger.child({ component: 'documents' }),
            ...(requestId === undefined ? {} : { requestId }),
          }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'documents_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/documents', unavailable);
      app.all('/v1/organizations/:organizationId/documents/*', unavailable);
    }
    // The commercial services, built once: Comercial's routes use them, and GIA reads through
    // them (C4) as the person asking. Opportunities and pipeline (C2, ADR-0054) have stages
    // proposed for the kind of business Company Brain knows; customers and leads (C1, ADR-0053)
    // are the same contacts, with a commercial stage.
    const zoneOf = async (organizationId: OrganizationId) =>
      (await businessProfiles?.find(organizationId))?.timeZone ?? DEFAULT_ACTIVITY_TIME_ZONE;
    const commercialOf = (store: TenancyStore, repository: ConversationRepository) => {
      const opportunities = createOpportunityService({
        repository,
        organizations: store,
        authorization,
        businessType: (organizationId) => companyFact(organizationId, 'identity', 'business_type'),
        currency: (organizationId) => companyFact(organizationId, 'finance', 'currency'),
      });
      const customers = createCustomerService({
        repository,
        organizations: store,
        authorization,
      });
      // Follow-ups (C5, ADR-0058): scheduled on the job transport, read in the business's zone.
      const followUps = createFollowUpService({
        repository,
        organizations: store,
        authorization,
        timeZone: zoneOf,
        ...(conversations?.followUpScheduler === undefined
          ? {}
          : { scheduler: conversations.followUpScheduler }),
      });
      const insights = createCommercialInsights({
        customers,
        opportunities,
        conversations: repository,
        followUps,
        authorization,
        timeZone: zoneOf,
        currency: (organizationId) => companyFact(organizationId, 'finance', 'currency'),
      });
      return { opportunities, customers, insights, followUps };
    };
    const commercial =
      tenancy !== undefined && conversations !== undefined
        ? commercialOf(tenancy, conversations.repository)
        : undefined;
    // The Forecasting Engine (ADR-0059): one capability for every department, GIA and reports.
    // Its series are the organization's own records, read through the existing repositories;
    // Company Brain gives only context (the currency, with the profile's time zone). A run goes
    // to the worker on the existing job queue and is charged by the existing credits engine.
    const businessContext: ForecastContextPort = {
      async of(organizationId) {
        const profile = await businessProfiles?.find(organizationId);
        if (profile === undefined) return undefined;
        const currency = await companyFact(organizationId, 'finance', 'currency');
        return {
          timeZone: profile.timeZone,
          ...(currency === undefined ? {} : { currency }),
        };
      },
    };
    const recordSources =
      conversations === undefined ? undefined : createRecordSources(conversations.repository);
    const forecastEngine =
      tenancy !== undefined &&
      conversations !== undefined &&
      credits !== undefined &&
      forecasting !== undefined
        ? createForecastEngine({
            repository: forecasting.repository,
            sources: recordSources ?? createRecordSources(conversations.repository),
            ...(forecasting.provider === undefined ? {} : { provider: forecasting.provider }),
            ...(forecasting.scheduler === undefined ? {} : { scheduler: forecasting.scheduler }),
            ...(forecasting.creditsPerRun === undefined
              ? {}
              : { creditsPerRun: forecasting.creditsPerRun }),
            ...(forecasting.limits === undefined ? {} : { limits: forecasting.limits }),
            ...(forecasting.now === undefined ? {} : { now: forecasting.now }),
            credits: createCreditService({ store: credits, organizations: tenancy }),
            context: businessContext,
            tenancy,
            authorization,
            audit,
            logger: logger.child({ component: 'forecasting' }),
          })
        : undefined;
    if (tenancy !== undefined) {
      registerForecastRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        ...(forecastEngine === undefined ? {} : { engine: forecastEngine }),
      });
    }
    // Reports (ADR-0060): the same metrics, sources and business context as the engine, read
    // without the model. They need no forecasting configuration: nothing is run or charged.
    if (tenancy !== undefined) {
      registerMetricRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        ...(recordSources === undefined
          ? {}
          : {
              metrics: createMetricHistory({
                sources: recordSources,
                context: businessContext,
                tenancy,
                authorization,
                ...(forecasting?.limits === undefined ? {} : { limits: forecasting.limits }),
                ...(forecasting?.now === undefined ? {} : { now: forecasting.now }),
              }),
            }),
      });
    }
    // The Decision Engine (DE-1, ADR-0065): what GIA may prepare for a person, one answer for the
    // chat and the screens, and the decisions MelonMotor makes (what to attend to first, company
    // policy, forecasts, which agent). An action is set up only where GIA and the engine that
    // carries it out both are. It decides and explains; it runs nothing.
    const giaConfigured = aiGateway !== undefined && structure !== undefined;
    const agentTasksConfigured =
      agentTasks !== undefined && executions !== undefined && specialists !== undefined;
    const decisions = createDecisionEngine({
      authorization,
      configured: (action) =>
        giaConfigured &&
        (action === 'knowledge.propose_fact'
          ? brain !== undefined
          : action === 'follow_up.schedule'
            ? commercial !== undefined
            : action === 'agent_task.assign'
              ? agentTasksConfigured
              : false),
      // Each decision type reads through the services that already exist, as the person asking.
      deciders: DECIDERS,
      ports: {
        ...(commercial === undefined ? {} : { commercial: commercial.insights }),
        ...(brain === undefined ? {} : { brain }),
        ...(forecastEngine === undefined ? {} : { forecasts: forecastEngine }),
        ...(structure === undefined ? {} : { agents: giaAgentsOf(structure) }),
        ...(aiGateway === undefined ? {} : { gateway: aiGateway }),
      },
      audit,
    });
    if (tenancy !== undefined) {
      registerDecisionRoutes(app, { store: tenancy, authorization, audit, decisions });
    }
    // GIA's chat (ADR-0052): the same gateway, Company Brain and activity, read as the person;
    // and, with C4, the commercial insights.
    if (tenancy !== undefined) {
      registerGiaRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        ...(aiGateway === undefined || structure === undefined
          ? {}
          : {
              gia: createGia({
                gateway: aiGateway,
                ...(brain === undefined ? {} : { brain }),
                ...(activityService === undefined
                  ? {}
                  : {
                      activity: {
                        async today(tenant) {
                          const profile = await businessProfiles?.find(tenant.organizationId);
                          const page = await activityService.list(tenant, {
                            period: 'today',
                            timeZone: profile?.timeZone ?? DEFAULT_ACTIVITY_TIME_ZONE,
                          });
                          return page.items;
                        },
                      },
                    }),
                ...(commercial === undefined ? {} : { commercial: commercial.insights }),
                ...(forecastEngine === undefined ? {} : { forecasting: forecastEngine }),
                // AE-3: GIA prepares tasks for the agents only where they can be assigned.
                ...(agentTasksConfigured ? { agents: giaAgentsOf(structure) } : {}),
                // What she may prepare for the person: the same answer the screens read.
                decisions,
                departments: structure.departments,
                authorization,
                audit,
                logger: logger.child({ component: 'gia' }),
              }),
            }),
      });
    }
    if (tenancy !== undefined && structure !== undefined && specialists !== undefined) {
      const dependencies = { store: tenancy, authorization, audit };
      registerDepartmentRoutes(app, {
        ...dependencies,
        departments: createDepartmentService({
          repository: structure.departments,
          organizations: tenancy,
        }),
      });
      const skills = createSkillCatalogue();
      registerSpecialistRoutes(app, {
        ...dependencies,
        specialists,
        skills,
        tools,
        // Agent management (ADR-0062): owner only, a person directly, audited with each change.
        management: createSpecialistManagement({
          repository: structure.specialists,
          departments: structure.departments,
          organizations: tenancy,
          authorization,
          skills,
          tools: toolLookupOf(tools),
        }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'structure_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/departments', unavailable);
      app.all('/v1/organizations/:organizationId/departments/*', unavailable);
      app.all('/v1/organizations/:organizationId/specialists', unavailable);
      app.all('/v1/organizations/:organizationId/specialists/*', unavailable);
    }
    const executionService =
      tenancy !== undefined && executions !== undefined
        ? createExecutionService({
            repository: executions,
            organizations: tenancy,
            ...(specialists === undefined ? {} : { assignments: specialists.assignments }),
            authorization,
            audit,
            // A cancelled planning execution reaches the children its plan delegated.
            ...(plans === undefined
              ? {}
              : { cascade: createPlanCancellationCascade({ repository: plans }) }),
          })
        : undefined;
    if (tenancy !== undefined && executionService !== undefined) {
      registerExecutionRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        executions: executionService,
      });
    } else if (tenancy !== undefined) {
      app.all('/v1/organizations/:organizationId/executions/*', (c) =>
        c.json({ error: 'executions_not_configured' }, 503),
      );
    }
    if (
      tenancy !== undefined &&
      executions !== undefined &&
      structure !== undefined &&
      specialists !== undefined &&
      agentTasks !== undefined
    ) {
      const taskExecutions = executions;
      registerAgentTaskRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        tasksFor: (requestId) =>
          createAgentTaskService({
            tasks: agentTasks.repository,
            specialists: structure.specialists,
            executions: createExecutionService({
              repository: taskExecutions,
              organizations: tenancy,
              assignments: specialists.assignments,
              authorization,
              audit,
              ...(requestId === undefined ? {} : { requestId }),
            }),
            authorization,
            ...(agentTasks.runtime === undefined ? {} : { runtime: agentTasks.runtime }),
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ...(agentTasks.outputs === undefined
          ? {}
          : { outputs: createAgentOutputStore(agentTasks.outputs) }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'agent_tasks_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/specialists/:specialistId/tasks', unavailable);
      app.all('/v1/organizations/:organizationId/agent-tasks/*', unavailable);
    }
    // Tools are listed, never run, over HTTP: only the tool gate runs them, on the server.
    if (tenancy !== undefined) {
      registerToolRoutes(app, { store: tenancy, authorization, audit, tools });
    }
    if (tenancy !== undefined && approvals !== undefined) {
      registerApprovalRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        approvals: createApprovalService({
          repository: approvals,
          organizations: tenancy,
          authorization,
          audit,
        }),
        ...(agentTurns === undefined ? {} : { afterDecision: agentTurns.afterDecision }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'approvals_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/approvals', unavailable);
      app.all('/v1/organizations/:organizationId/approvals/*', unavailable);
    }
    // Plans are read and decided over HTTP, never made there: only the server-side planner and
    // workflows propose them, so this validator is never reached from a route and fails closed
    // on every tool (no environment). Approving one runs it (ADR-0070).
    if (
      tenancy !== undefined &&
      executionService !== undefined &&
      specialists !== undefined &&
      structure !== undefined &&
      plans !== undefined
    ) {
      const dependencies = { store: tenancy, authorization, audit };
      const planService = createPlanService({
        repository: plans,
        executions: executionService,
        validator: createPlanValidator({
          specialists,
          departments: structure.departments,
          tools,
          authorization,
          environment: undefined,
        }),
        organizations: tenancy,
        authorization,
        audit,
      });
      // An approved plan runs (ADR-0070): the person who approved delegates it and starts its
      // first steps, each queued for the worker; the worker's conductor starts the rest.
      const conductor =
        planRuntime === undefined
          ? undefined
          : createPlanConductor({
              plans,
              delegation: createDelegation({
                plans,
                executions: executionService,
                specialists,
                organizations: tenancy,
                authorization,
              }),
              executions: executionService,
              starter: {
                async start(tenant, executionId) {
                  await executionService.start(tenant, executionId);
                  await planRuntime.kickoff(tenant, executionId);
                },
              },
            });
      registerPlanRoutes(app, {
        ...dependencies,
        plans: planService,
        ...(conductor === undefined ? {} : { conductor }),
        steps: {
          executions: executionService,
          ...(agentTasks?.outputs === undefined
            ? {}
            : { outputs: createAgentOutputStore(agentTasks.outputs) }),
        },
      });
      if (workflows !== undefined) {
        registerWorkflowRoutes(app, {
          ...dependencies,
          workflows: createWorkflowService({
            repository: workflows,
            plans: planService,
            executions: executionService,
            specialists,
            departments: structure.departments,
            organizations: tenancy,
            authorization,
          }),
        });
      }
    }
    if (tenancy !== undefined) {
      const unavailable = (what: string) => (c: Context<Env>) =>
        c.json({ error: `${what}_not_configured` }, 503);
      const plansReady =
        executionService !== undefined && specialists !== undefined && plans !== undefined;
      if (!plansReady) {
        app.all('/v1/organizations/:organizationId/plans', unavailable('plans'));
        app.all('/v1/organizations/:organizationId/plans/*', unavailable('plans'));
      }
      if (!plansReady || workflows === undefined) {
        app.all('/v1/organizations/:organizationId/workflows', unavailable('workflows'));
        app.all('/v1/organizations/:organizationId/workflows/*', unavailable('workflows'));
      }
    }
    if (tenancy !== undefined && structure !== undefined && conversations !== undefined) {
      const billingPlans =
        billing === undefined
          ? undefined
          : createBillingService({ billing, organizations: tenancy });
      const planEntitlements =
        entitlements ??
        (billingPlans === undefined
          ? undefined
          : createEntitlementService({
              organizations: tenancy,
              plans: billingPlans,
              ...(entitlementOverrides === undefined ? {} : { overrides: entitlementOverrides }),
            }));
      const { outbound, engine } = conversations;
      // The same tool gate as the runtime's (ADR-0026, ADR-0034), with the one executor a person
      // may reach through it. No specialist, approval or runtime is involved in a person's send,
      // but the gate is built whole: there is no second, lighter gate.
      const sender =
        outbound !== undefined &&
        engine !== undefined &&
        executions !== undefined &&
        executionService !== undefined &&
        specialists !== undefined &&
        approvals !== undefined
          ? createMessageSendService({
              conversations: conversations.repository,
              organizations: tenancy,
              authorization,
              executions: executionService,
              gate: createToolGate({
                executions,
                organizations: tenancy,
                specialists,
                departments: structure.departments,
                registry: tools,
                approvals: createApprovalService({
                  repository: approvals,
                  organizations: tenancy,
                  authorization,
                  audit,
                }),
                executors: {
                  channel: createChannelMessageExecutor({
                    conversations: conversations.repository,
                    engine,
                  }),
                },
                authorization,
                audit,
                environment: outbound.environment,
                logger: logger.child({ component: 'tool-gate' }),
              }),
              channels: engine,
              audit,
              ...(conversations.templates === undefined
                ? {}
                : { templates: conversations.templates }),
              logger: logger.child({ component: 'outbound' }),
            })
          : undefined;
      const conversationService = createConversationService({
        repository: conversations.repository,
        // The organization's agent is one of its own active specialists with a conversation
        // profile (CV-6B, ADR-0043).
        agents: createConversationAgentCheck(structure.specialists),
        organizations: tenancy,
        departments: structure.departments,
        authorization,
      });
      // Assisted AI (CV-4, ADR-0037): the one AI Gateway, in its assisted mode.
      const assistant =
        aiGateway !== undefined
          ? createConversationAssistant({
              conversations: conversationService,
              departments: structure.departments,
              gateway: aiGateway,
              authorization,
              audit,
              logger: logger.child({ component: 'conversation-assist' }),
            })
          : undefined;
      registerConversationRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        ...(sender === undefined ? {} : { sender }),
        ...(assistant === undefined ? {} : { assistant }),
        ...(conversations.agentOutputs === undefined
          ? {}
          : {
              handoffSummaries: createHandoffSummaries({
                outputs: createAgentOutputStore(conversations.agentOutputs),
              }),
            }),
        conversations: conversationService,
      });
      // Customers and leads (C1): each card also shows the contact's conversations,
      // opportunities and history (C3, ADR-0055).
      const { opportunities, customers, followUps } =
        commercial ?? commercialOf(tenancy, conversations.repository);
      // A new follow-up is a tool call (TL-1, ADR-0068): the same gate as a person's send, with
      // the follow-up executor. Without the gate's parts or an environment, it fails closed.
      const toolEnvironment = conversations.toolEnvironment;
      const scheduleFollowUp: Pick<FollowUpService, 'create'> =
        toolEnvironment !== undefined &&
        executions !== undefined &&
        executionService !== undefined &&
        specialists !== undefined &&
        approvals !== undefined
          ? createGatedFollowUpCreate({
              followUps,
              authorization,
              executions: executionService,
              gate: createToolGate({
                executions,
                organizations: tenancy,
                specialists,
                departments: structure.departments,
                registry: tools,
                approvals: createApprovalService({
                  repository: approvals,
                  organizations: tenancy,
                  authorization,
                  audit,
                }),
                executors: {
                  follow_up: createFollowUpScheduleExecutor({
                    followUps,
                    organizations: tenancy,
                  }),
                },
                authorization,
                audit,
                environment: toolEnvironment,
                logger: logger.child({ component: 'tool-gate' }),
              }),
              logger: logger.child({ component: 'follow-up-tool' }),
            })
          : {
              create: async () => {
                throw new ConversationError('follow_up_tool_unavailable');
              },
            };
      registerFollowUpRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        followUps: { ...followUps, create: scheduleFollowUp.create },
        contacts: conversations.repository,
        ...(brain === undefined ? {} : { brain }),
      });
      registerCustomerRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        customers,
        context: {
          authorization,
          opportunities,
          conversations: conversations.repository,
          ...(activity === undefined ? {} : { history: activity }),
        },
        ...(brain === undefined ? {} : { brain }),
      });
      registerOpportunityRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        opportunities,
        conversations: conversations.repository,
        ...(activity === undefined ? {} : { history: activity }),
        ...(brain === undefined ? {} : { brain }),
      });
      // Connections (ADR-0044): the engine's registry names the providers; without an engine
      // there is none, so nothing can be created or checked.
      const registry = engine?.registry ?? createIntegrationRegistry([]);
      registerConnectionRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        registry,
        connections: createChannelConnectionService({
          repository: conversations.connections,
          registry,
          organizations: tenancy,
          authorization,
          // Without billing, the plan cannot be read: creating fails closed.
          entitlements: planEntitlements ?? {
            entitlementsOf: async () => ({ status: 'unavailable', reason: 'plan_missing' }),
          },
          ...(engine === undefined ? {} : { checker: engine }),
          ...(conversations.secretProjectId === undefined
            ? {}
            : { secretProjectId: conversations.secretProjectId }),
        }),
        ...(conversations.templates === undefined
          ? {}
          : {
              templates: createChannelTemplateService({
                repository: conversations.templates,
                connections: conversations.connections,
                organizations: tenancy,
                authorization,
                ...(engine === undefined ? {} : { checker: engine }),
              }),
            }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) =>
        c.json({ error: 'conversations_not_configured' }, 503);
      for (const path of [
        'conversations',
        'contacts',
        'channel-connections',
        'integrations',
        'follow-ups',
      ]) {
        app.all(`/v1/organizations/:organizationId/${path}`, unavailable);
        app.all(`/v1/organizations/:organizationId/${path}/*`, unavailable);
      }
    }
    if (tenancy !== undefined && credits !== undefined) {
      registerCreditRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        credits: createCreditService({ store: credits, organizations: tenancy }),
      });
    } else if (tenancy !== undefined) {
      app.all('/v1/organizations/:organizationId/credits', (c) =>
        c.json({ error: 'credits_not_configured' }, 503),
      );
    }
    registerPlatformRoutes(app, {
      admins: new Set(platformAdmins),
      audit,
      environment: ai.environment,
      registry: aiRegistry,
      policies: aiPolicies,
      health: aiHealth,
      ledger: usageLedger,
      organizations: tenancy,
    });
    if (tenancy !== undefined && usageLedger !== undefined) {
      registerAIUsageRoutes(app, { store: tenancy, authorization, audit, ledger: usageLedger });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'ai_usage_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/ai-usage', unavailable);
      app.all('/v1/organizations/:organizationId/ai-usage/*', unavailable);
    }
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    c.get('logger').error('unhandled error', { error });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
