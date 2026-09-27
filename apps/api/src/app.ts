import {
  createAIGateway,
  createModelPolicyCatalogue,
  defaultProviderRegistry,
  type AICreditsPort,
  type CreditRate,
  type ModelPolicyCatalogue,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import { createApprovalService, type ApprovalRepository } from '@melonoffice/approvals';
import type { AuditService } from '@melonoffice/audit';
import type { AuthDependencies } from '@melonoffice/auth';
import { createBillingService, type BillingStore } from '@melonoffice/billing';
import { createDepartmentService, type DepartmentRepository } from '@melonoffice/departments';
import {
  createConversationAssistant,
  createConversationService,
  type ConversationRepository,
} from '@melonoffice/conversations';
import { createCreditService, type CreditStore } from '@melonoffice/credits';
import { createEntitlementService, type EntitlementService } from '@melonoffice/entitlements';
import { createExecutionService, type ExecutionRepository } from '@melonoffice/execution';
import type { DeploymentEnvironment } from '@melonoffice/domain';
import { createToolGate } from '@melonoffice/guardrails';
import {
  createChannelConnectionService,
  createChannelMessageExecutor,
  createMessageSendService,
  type ChannelAdapters,
  type ChannelConnectionRepository,
  type SecretStore,
  type WebhookIngress,
} from '@melonoffice/integrations';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import { createSpecialistService, type SpecialistRepository } from '@melonoffice/specialists';
import {
  createPlanCancellationCascade,
  createPlanService,
  createPlanValidator,
  type PlanRepository,
} from '@melonoffice/planning';
import type { TenancyStore } from '@melonoffice/tenancy';
import { defaultToolRegistry, type ToolRegistry } from '@melonoffice/tools';
import { createWorkflowService, type WorkflowRepository } from '@melonoffice/workflows';
import { Hono, type Context } from 'hono';
import { registerApprovalRoutes } from './approvals.js';
import { registerAuthRoutes, type AuthEnv } from './auth.js';
import { registerCors } from './cors.js';
import { registerBillingRoutes } from './billing.js';
import { registerDepartmentRoutes } from './departments.js';
import { registerConversationRoutes } from './conversations.js';
import { registerCreditRoutes } from './credits.js';
import { registerEntitlementRoutes } from './entitlements.js';
import { registerExecutionRoutes } from './executions.js';
import { registerHealth } from './health.js';
import { registerPlanRoutes } from './plans.js';
import { registerSpecialistRoutes } from './specialists.js';
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
  /** The tool catalogue (ADR-0026). Defaults to the one in code, which is empty until tools exist. */
  readonly tools?: ToolRegistry;
  /** Tool approvals (ADR-0026). Absent: the approval routes answer 503 (fails closed). */
  readonly approvals?: ApprovalRepository;
  /** Credit wallets and their ledger (ADR-0023). Absent: the credits route answers 503. */
  readonly credits?: CreditStore;
  /** Plans (ADR-0028). Absent: the plan routes answer 503 (fails closed). */
  readonly plans?: PlanRepository;
  /** Workflows (ADR-0028). Absent: the workflow routes answer 503 (fails closed). */
  readonly workflows?: WorkflowRepository;
  /**
   * Conversations, contacts and channel connections (ADR-0033). Absent: the inbox routes answer
   * 503 (fails closed). They also need departments (`structure`) to assign to one.
   */
  readonly conversations?: {
    readonly repository: ConversationRepository;
    readonly connections: ChannelConnectionRepository;
    /** Where channel secrets live. Unset: no connection can be created. */
    readonly secretProjectId?: string;
    /**
     * A person's replies (CV-2, ADR-0034), through the tool gate. Absent: the send route answers
     * 503 (fails closed). It also needs executions, departments, specialists and approvals, which
     * the gate is built from.
     */
    readonly outbound?: {
      readonly secrets: SecretStore;
      readonly adapters: ChannelAdapters;
      /** Where this server runs, set explicitly: the tool runs only where its version allows. */
      readonly environment: DeploymentEnvironment;
    };
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
  /** Channel webhooks (ADR-0033). Absent: `/webhooks/*` answers 503. */
  readonly webhooks?: WebhookIngress;
  /**
   * The web app's exact origins, allowed to call `/v1` from a browser (ADR-0036). Empty or
   * absent: no CORS header is ever sent.
   */
  readonly webOrigins?: readonly string[];
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
  executions,
  structure,
  tools = defaultToolRegistry(),
  approvals,
  credits,
  plans,
  workflows,
  conversations,
  ai = {},
  webhooks,
  webOrigins = [],
}: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

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
    registerTenancyRoutes(app, tenancy, authorization, audit);
    if (tenancy !== undefined && billing !== undefined) {
      const billingService = createBillingService({ billing, organizations: tenancy });
      const dependencies = { store: tenancy, authorization, audit };
      registerBillingRoutes(app, { ...dependencies, billing: billingService });
      registerEntitlementRoutes(app, {
        ...dependencies,
        entitlements:
          entitlements ??
          createEntitlementService({ organizations: tenancy, plans: billingService }),
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
    if (tenancy !== undefined && structure !== undefined && specialists !== undefined) {
      const dependencies = { store: tenancy, authorization, audit };
      registerDepartmentRoutes(app, {
        ...dependencies,
        departments: createDepartmentService({
          repository: structure.departments,
          organizations: tenancy,
        }),
      });
      registerSpecialistRoutes(app, { ...dependencies, specialists });
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
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'approvals_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/approvals', unavailable);
      app.all('/v1/organizations/:organizationId/approvals/*', unavailable);
    }
    // Plans are read and decided over HTTP, never made, run or delegated: only the server-side
    // planner and workflows propose them, so this validator is never reached from a route and
    // fails closed on every tool (no environment).
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
      registerPlanRoutes(app, { ...dependencies, plans: planService });
      if (workflows !== undefined) {
        registerWorkflowRoutes(app, {
          ...dependencies,
          workflows: createWorkflowService({
            repository: workflows,
            plans: planService,
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
          : createEntitlementService({ organizations: tenancy, plans: billingPlans }));
      const { outbound } = conversations;
      // The same tool gate as the runtime's (ADR-0026, ADR-0034), with the one executor a person
      // may reach through it. No specialist, approval or runtime is involved in a person's send,
      // but the gate is built whole: there is no second, lighter gate.
      const sender =
        outbound !== undefined &&
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
                    connections: conversations.connections,
                    secrets: outbound.secrets,
                    adapters: outbound.adapters,
                  }),
                },
                authorization,
                audit,
                environment: outbound.environment,
                logger: logger.child({ component: 'tool-gate' }),
              }),
              adapters: outbound.adapters,
              audit,
              logger: logger.child({ component: 'outbound' }),
            })
          : undefined;
      const conversationService = createConversationService({
        repository: conversations.repository,
        organizations: tenancy,
        departments: structure.departments,
        authorization,
      });
      // Assisted AI (CV-4, ADR-0037): the one AI Gateway, in its assisted mode. The execution and
      // specialist stores are there because the gateway is built whole; an assisted call reads
      // neither. The credits engine accounts for every call; with no rate it denies all.
      const aiCredits =
        ai.credits ??
        (credits === undefined
          ? undefined
          : createCreditService({ store: credits, organizations: tenancy }));
      const assistant =
        executions !== undefined && specialists !== undefined
          ? createConversationAssistant({
              conversations: conversationService,
              departments: structure.departments,
              gateway: createAIGateway({
                executions,
                organizations: tenancy,
                specialists,
                authorization,
                registry: ai.registry ?? defaultProviderRegistry(),
                policies: ai.policies ?? createModelPolicyCatalogue([]),
                environment: ai.environment,
                ...(aiCredits === undefined
                  ? {}
                  : { credits: { port: aiCredits, rate: ai.creditRate } }),
                audit,
                logger: logger.child({ component: 'ai-gateway' }),
              }),
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
        conversations: conversationService,
        connections: createChannelConnectionService({
          repository: conversations.connections,
          organizations: tenancy,
          authorization,
          // Only `create` reads a limit, and no route creates: without billing it fails closed.
          entitlements: planEntitlements ?? {
            getLimit: async () => ({ available: false, reason: 'unknown_limit' }),
          },
          ...(conversations.secretProjectId === undefined
            ? {}
            : { secretProjectId: conversations.secretProjectId }),
        }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) =>
        c.json({ error: 'conversations_not_configured' }, 503);
      for (const path of ['conversations', 'contacts', 'channel-connections']) {
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
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    c.get('logger').error('unhandled error', { error });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
