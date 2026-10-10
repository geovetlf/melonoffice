import {
  createAgentNotificationSubscriber,
  createAgentNotifier,
  inAppChannel,
} from '@melonoffice/agents';
import type { PlanId } from '@melonoffice/domain';
import { createAgentOutputStore } from '@melonoffice/execution';
import { createAIUsageLedger } from '@melonoffice/ai-usage';
import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import {
  AI_MODEL_CATALOGUE,
  AI_PROVIDER_CATALOGUE,
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
  dataPolicyFromEnv,
} from '@melonoffice/ai-gateway';
import {
  AGENT_TASK_POLICY,
  CONVERSATION_AGENT_POLICY,
  createVertexAIAdapter,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
} from '@melonoffice/ai-vertex';
import {
  createDeepSeekAdapter,
  DEEPSEEK_MODELS,
  DEEPSEEK_PROVIDER,
} from '@melonoffice/ai-deepseek';
import {
  createNvidiaAdapter,
  NVIDIA_MODELS,
  NVIDIA_PROVIDER,
  NVIDIA_TRIAL_DATA_POLICY,
} from '@melonoffice/ai-nvidia';
import {
  harnessConversationPolicy,
  harnessDataPolicy,
  harnessRoute,
  harnessTaskPolicy,
} from '@melonoffice/harness';
import { createAuditService } from '@melonoffice/audit';
import { createServiceIdentityVerifier } from '@melonoffice/auth';
import { createCreditService } from '@melonoffice/credits';
import {
  FirestoreAIUsageStore,
  FirestoreAgentOutputRepository,
  FirestoreAgentTaskRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreAgentHandoffRepository,
  FirestoreAgentNotificationRepository,
  FirestoreAgentMemoryRepository,
  FirestoreAgentPolicyRepository,
  FirestoreBusinessProfileRepository,
  FirestoreChannelConnectionRepository,
  FirestoreChannelTemplateRepository,
  FirestoreConnectionRateLimiter,
  FirestoreConversationRepository,
  FirestoreCreditStore,
  FirestoreDepartmentRepository,
  FirestoreEventOutbox,
  FirestoreExecutionRepository,
  FirestoreForecastRepository,
  FirestoreJobRepository,
  FirestoreKnowledgeRepository,
  FirestorePlanRepository,
  FirestoreSpecialistRepository,
  FirestoreSweepLedger,
  FirestoreTenancyStore,
  FirestoreWorkflowRepository,
  FirestoreWorkflowScheduleRepository,
} from '@melonoffice/firestore';
import {
  createIntegrationEngine,
  createIntegrationRegistry,
  aiProviderKeysFromSecrets,
  createSecretManagerStore,
  createWhatsAppAdapter,
  deliveryPolicyFromEnv,
  isAISecretRef,
} from '@melonoffice/integrations';
import { createFollowUpService } from '@melonoffice/conversations';
import { createEventBus } from '@melonoffice/events';
import {
  createForecastEngine,
  createRecordSources,
  createTimesFMProvider,
  forecastingConfigFromEnv,
  metadataIdentityTokens,
} from '@melonoffice/forecasting';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createAgentPolicySource } from '@melonoffice/specialists';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createPlanConditions } from './conditions.js';
import { randomUUID } from 'node:crypto';
import { createApp, RUN_JOB_PATH, SERVICE_NAME, type AppOptions } from './app.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { createCloudTasksDispatcher, createCloudTasksScheduler } from './dispatcher.js';
import { createEventHandler, RUN_EVENT_PATH } from './events.js';
import { createFollowUpHandler, RUN_FOLLOW_UP_PATH } from './follow-ups.js';
import { createForecastHandler } from './forecasts.js';
import { createJobHandler } from './handler.js';
import { createWorkerRuntime } from './runtime.js';
import { createPlanWakeHandler, createPlanWakeups, RUN_PLAN_WAKE_PATH } from './plan-wakeups.js';
import { createExecutionSweeper, RUN_SWEEP_PATH } from './sweeps.js';
import {
  createScheduleDelegation,
  createWorkflowScheduleRunner,
  RUN_SCHEDULE_PATH,
} from './workflow-schedules.js';

const config = loadConfig(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });
// The Forecasting Engine's settings (ADR-0059): the model's runtime and the credit cost.
const forecasting = forecastingConfigFromEnv(process.env);

/** This instance, recorded on the leases it takes. Infrastructure only, never an actor. */
const workerId = `${(process.env.K_REVISION ?? 'local').replace(/[^\w-]/g, '-').slice(0, 80)}-${randomUUID().slice(0, 8)}`;

// The runtime is on only where Terraform sets its configuration (dev today). Firestore and Cloud
// Tasks are reached with the service's own runtime identity, never with a key.
function jobs(runtime: RuntimeConfig): NonNullable<AppOptions['jobs']> {
  const firestore = new Firestore({ projectId: runtime.firestoreProjectId });
  const tenancy = new FirestoreTenancyStore(firestore);
  const stores = {
    tenancy,
    departments: new FirestoreDepartmentRepository(firestore),
    specialists: new FirestoreSpecialistRepository(firestore),
    executions: new FirestoreExecutionRepository(firestore, {
      // The sweep's query runs without its index until Terraform adds it (ADR-0121).
      onIndexMissing: (query) => logger.warn('firestore.index_missing', { query }),
    }),
    approvals: new FirestoreApprovalRepository(firestore),
    jobs: new FirestoreJobRepository(firestore),
    audit: new FirestoreAuditStore(firestore),
  };
  const { vertexAI, deepSeek, nvidia, channelSecretsProjectId, whatsappGraphApiVersion } =
    config.agents;
  const agentOutputs = new FirestoreAgentOutputRepository(firestore);
  // Conversation agents (CV-6B, ADR-0043): their tools' executors, work source, verifier, answer
  // store and stop hook. The reply's executor exists only where channel secrets are configured;
  // without it a reply fails at the gate and the conversation goes to a person.
  const agents = createConversationAgentParts({
    stores: {
      ...stores,
      conversations: new FirestoreConversationRepository(firestore),
      outputs: agentOutputs,
    },
    ...(channelSecretsProjectId === undefined
      ? {}
      : {
          // The Integration Engine (ADR-0044): the same one the API uses, for sends only. It
          // stores no inbound message here, so it gets no ingress.
          channels: createIntegrationEngine({
            registry: createIntegrationRegistry([
              createWhatsAppAdapter(
                whatsappGraphApiVersion === undefined
                  ? {}
                  : { graphApiVersion: whatsappGraphApiVersion },
              ),
            ]),
            connections: new FirestoreChannelConnectionRepository(firestore),
            secrets: createSecretManagerStore(),
            // Every provider call, retry and limit of a send is audited (ADR-0045).
            audit: createAuditService(stores.audit),
            logger: logger.child({ component: 'integrations' }),
            // The same limits and retries as the API, and the same shared send limit.
            delivery: deliveryPolicyFromEnv(process.env),
            rateLimiter: new FirestoreConnectionRateLimiter(firestore),
            templates: new FirestoreChannelTemplateRepository(firestore),
          }),
        }),
    logger: logger.child({ component: 'conversation-agents' }),
  });
  // Follow-ups (C5, ADR-0058): their tasks come through the same queue and invoker. The hop to
  // a time beyond the queue's horizon is queued the same way.
  const businessProfiles = new FirestoreBusinessProfileRepository(firestore);
  const followUps = createFollowUpService({
    repository: new FirestoreConversationRepository(firestore),
    organizations: tenancy,
    authorization: createAuthorizationService(),
    timeZone: async (organizationId) =>
      (await businessProfiles.find(organizationId))?.timeZone ?? 'America/Lima',
    scheduler: createCloudTasksScheduler({
      queue: runtime.queue,
      targetUrl: `${runtime.workerUrl}${RUN_FOLLOW_UP_PATH}`,
      audience: runtime.workerUrl,
      invokerEmail: runtime.invokerEmail,
      dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
    }),
  });
  // Domain events (EV-2, ADR-0067): stored in the outbox, queued on the same queue, delivered by
  // this worker behind the same invoker. The one reaction registered (ADR-0117, AE-D5): agents'
  // facts become in-app notices for the person who asked for the task; nothing else is started.
  const agentTaskRepository = new FirestoreAgentTaskRepository(firestore);
  const agentHandoffRepository = new FirestoreAgentHandoffRepository(firestore);
  const plans = new FirestorePlanRepository(firestore);
  const notifications = createAgentNotificationSubscriber({
    tasks: agentTaskRepository,
    handoffs: agentHandoffRepository,
    // A plan's end (ADR-0119): its result is ready, for the person who made it.
    plans: { find: (organizationId, id) => plans.find(organizationId, id as PlanId) },
    notifier: createAgentNotifier({
      channels: [inAppChannel(new FirestoreAgentNotificationRepository(firestore))],
      onError: (channel, kind) =>
        logger.warn('agent notification not delivered', { channel, kind }),
    }),
  });
  const events = createEventBus({
    outbox: new FirestoreEventOutbox(firestore),
    queue: {
      enqueue: (() => {
        const scheduler = createCloudTasksScheduler({
          queue: runtime.queue,
          targetUrl: `${runtime.workerUrl}${RUN_EVENT_PATH}`,
          audience: runtime.workerUrl,
          invokerEmail: runtime.invokerEmail,
          dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
        });
        return (ref) => scheduler.schedule(ref, new Date());
      })(),
    },
    subscribers: [notifications],
    leaseMs: runtime.leaseMs,
    audit: createAuditService(stores.audit),
    logger: logger.child({ component: 'events' }),
  });
  // Agent tasks (ADR-0063): the same runtime runs them, with Company Brain as their context. What
  // an agent proposes from a task (ADR-0084): a follow-up, scheduled with the same follow-up
  // service once a person approves it, and facts for Company Brain.
  const taskParts = createAgentTaskParts({
    stores: {
      tenancy,
      specialists: stores.specialists,
      tasks: agentTaskRepository,
      knowledge: new FirestoreKnowledgeRepository(firestore),
      outputs: agentOutputs,
      plans,
      memories: new FirestoreAgentMemoryRepository(firestore),
      handoffs: {
        repository: agentHandoffRepository,
        departments: stores.departments,
      },
    },
    proposals: {
      conversations: new FirestoreConversationRepository(firestore),
      followUps,
      timeZone: async (organizationId) =>
        (await businessProfiles.find(organizationId))?.timeZone ?? 'America/Lima',
    },
    // An agent task's end, and whether it now needs a person, on the event bus (ADR-0102).
    events,
    // Tools mid-task (ADR-0103): only ones that say a model may ask for them, with an executor
    // here. Today two: `follow_up_schedule@3` (ADR-0104), for commercial agents a person moved to
    // customer_follow_up@3, approved by a person on every call; and `knowledge_search@1`
    // (ADR-0130), a read for agents a person moved to company_knowledge@3.
    tools: {
      registry: createToolRegistry(TOOL_CATALOGUE),
      executors: Object.keys(agents.executors),
      // The organization's rules for its agents (AE-4.4): what else it counts as sensitive.
      policies: createAgentPolicySource(new FirestoreAgentPolicyRepository(firestore)),
    },
    logger: logger.child({ component: 'agent-tasks' }),
  });
  const routed = routeAgentWork(agents, taskParts);
  // The model providers (ADR-0038, ADR-0072), each only where its own settings are set: Vertex AI
  // with its project and location, DeepSeek and NVIDIA with the Secret Manager reference of their
  // keys. A
  // provider being registered allows nothing by itself: the agents' policies still pin Gemini.
  const aiProviders = [];
  const aiModels = [];
  const aiAdapters = [];
  if (vertexAI !== undefined) {
    aiProviders.push(VERTEX_AI_PROVIDER);
    aiModels.push(...VERTEX_AI_MODELS);
    aiAdapters.push(
      createVertexAIAdapter({ projectId: vertexAI.projectId, location: vertexAI.location }),
    );
  }
  if (deepSeek !== undefined) {
    aiProviders.push(DEEPSEEK_PROVIDER);
    aiModels.push(...DEEPSEEK_MODELS);
    aiAdapters.push(
      createDeepSeekAdapter({
        credentials: aiProviderKeysFromSecrets(
          createSecretManagerStore({ accepts: isAISecretRef }),
          { [DEEPSEEK_PROVIDER.credential.provider]: deepSeek.keySecret },
        ),
      }),
    );
  }
  if (nvidia !== undefined) {
    aiProviders.push(NVIDIA_PROVIDER);
    aiModels.push(...NVIDIA_MODELS);
    aiAdapters.push(
      createNvidiaAdapter({
        credentials: aiProviderKeysFromSecrets(
          createSecretManagerStore({ accepts: isAISecretRef }),
          { [NVIDIA_PROVIDER.credential.provider]: nvidia.keySecret },
        ),
      }),
    );
  }
  const aiRegistered = aiProviders.length > 0;
  /** How every agent's calls are routed (ADR-0100): configuration, never a branch in code. */
  const HARNESS_ROUTE = harnessRoute([NVIDIA_PROVIDER.id]);
  const aiRegistry = aiRegistered
    ? createProviderRegistry({ providers: aiProviders, models: aiModels, adapters: aiAdapters })
    : createProviderRegistry({
        providers: AI_PROVIDER_CATALOGUE,
        models: AI_MODEL_CATALOGUE,
        adapters: [],
      });
  const {
    jobs: jobService,
    runtime: engine,
    advancePlan,
    conductor: planConductor,
  } = createWorkerRuntime({
    stores,
    environment: runtime.environment,
    leaseMs: runtime.leaseMs,
    // A schedule's plan is delegated as its person's runtime (ADR-0185).
    scheduleDelegation: createScheduleDelegation,
    // The real tool catalogue (ADR-0026) with the conversation agent's executors. The model is
    // Vertex AI's Gemini 2.5 Flash-Lite (D-7) with the credit rate (D-12), only where Terraform
    // sets the Vertex AI project; anywhere else no provider is registered and every model call
    // is denied before reaching one.
    tools: {
      registry: createToolRegistry(TOOL_CATALOGUE),
      executors: { ...agents.executors, ...taskParts.executors },
    },
    ai: aiRegistry,
    // The data policy before routing (ADR-0100): NVIDIA gets public, synthetic and test data only
    // while it is on trial terms; `AI_DATA_POLICY` changes it for this environment.
    ...(runtime.environment === undefined
      ? {}
      : {
          dataPolicy: dataPolicyFromEnv(
            process.env,
            runtime.environment,
            harnessDataPolicy(NVIDIA_TRIAL_DATA_POLICY),
          ),
        }),
    ...(aiRegistered
      ? {
          credits: {
            port: createCreditService({
              store: new FirestoreCreditStore(firestore),
              organizations: tenancy,
            }),
            rate: CREDIT_RATE,
          },
          policies: createModelPolicyCatalogue([
            // Version 1 stays registered for executions that started under it; the agent policy
            // migration (ADR-0100) moves every agent to version 2.
            CONVERSATION_AGENT_POLICY,
            AGENT_TASK_POLICY,
            // Every agent through the Harness (ADR-0100): no model pinned; NVIDIA evaluated first
            // (Geovet, 2026-09-30) wherever the data policy and its terms let it take the call,
            // then the task's strategy, with automatic fallback. At most one credit per call, as
            // before, and the task's limit of provider calls.
            harnessTaskPolicy(HARNESS_ROUTE),
            harnessConversationPolicy(HARNESS_ROUTE),
          ]),
          // Every agent's model call is recorded in the AI Usage Ledger (ADR-0074).
          usage: createAIUsageLedger(new FirestoreAIUsageStore(firestore)),
        }
      : {}),
    work: routed.work,
    verifier: routed.verifier,
    outputs: agents.outputs,
    // What a plan's runs used, against the budget a person approved (ADR-0163).
    planOutputs: createAgentOutputStore(agentOutputs),
    onStopped: routed.onStopped,
    toolLoop: routed.toolLoop,
    ...(taskParts.onEnded === undefined ? {} : { onEnded: taskParts.onEnded }),
    plans,
    // A plan's end on the event bus, for the person's bell (ADR-0119).
    events,
    // Plans' condition steps (WF-4, ADR-0075): decided by the Decision Engine, rules only.
    conditions: createPlanConditions({
      stores: {
        tenancy,
        knowledge: new FirestoreKnowledgeRepository(firestore),
        audit: stores.audit,
      },
      logger: logger.child({ component: 'plan-conditions' }),
    }),
    // Plans' wait steps (ADR-0152): a task on the same queue wakes the plan when a wait ends.
    wakeups: createPlanWakeups(
      createCloudTasksScheduler({
        queue: runtime.queue,
        targetUrl: `${runtime.workerUrl}${RUN_PLAN_WAKE_PATH}`,
        audience: runtime.workerUrl,
        invokerEmail: runtime.invokerEmail,
        dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
      }),
    ),
    dispatcher: createCloudTasksDispatcher({
      queue: runtime.queue,
      targetUrl: `${runtime.workerUrl}${RUN_JOB_PATH}`,
      audience: runtime.workerUrl,
      invokerEmail: runtime.invokerEmail,
      dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
    }),
    logger,
  });
  // Forecasts (ADR-0059): the worker is the only place the model is called, with its own identity
  // on the private forecaster service. The engine re-reads each forecast and charges it once.
  const forecastEngine = createForecastEngine({
    repository: new FirestoreForecastRepository(firestore),
    sources: createRecordSources(new FirestoreConversationRepository(firestore)),
    ...(forecasting.forecasterUrl === undefined
      ? {}
      : {
          provider: createTimesFMProvider({
            url: forecasting.forecasterUrl,
            token: metadataIdentityTokens({ audience: forecasting.forecasterUrl }),
          }),
        }),
    fallback: forecasting.fallback,
    credits: createCreditService({
      store: new FirestoreCreditStore(firestore),
      organizations: tenancy,
    }),
    ...(forecasting.creditsPerRun === undefined
      ? {}
      : { creditsPerRun: forecasting.creditsPerRun }),
    context: {
      of: async (organizationId) => {
        const profile = await businessProfiles.find(organizationId);
        return profile === undefined
          ? undefined
          : { timeZone: profile.timeZone, currency: profile.currency };
      },
    },
    tenancy,
    authorization: createAuthorizationService(),
    audit: createAuditService(stores.audit),
    logger: logger.child({ component: 'forecasting' }),
    limits: forecasting.limits,
  });
  // Workflow schedules (ADR-0185): one task per occurrence on the same queue and invoker, run as
  // the runtime of the person who switched the schedule on; the sweep recovers a lost one.
  const schedules =
    planConductor === undefined
      ? undefined
      : createWorkflowScheduleRunner({
          stores,
          plans,
          workflows: new FirestoreWorkflowRepository(firestore),
          schedules: new FirestoreWorkflowScheduleRepository(firestore),
          tools: createToolRegistry(TOOL_CATALOGUE),
          environment: runtime.environment,
          conductor: planConductor,
          scheduler: createCloudTasksScheduler({
            queue: runtime.queue,
            targetUrl: `${runtime.workerUrl}${RUN_SCHEDULE_PATH}`,
            audience: runtime.workerUrl,
            invokerEmail: runtime.invokerEmail,
            dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
          }),
          logger: logger.child({ component: 'workflow-schedules' }),
        });
  // The automatic sweep of abandoned agent work (ADR-0121): a task every 3 hours on the same
  // queue, behind the same invoker. Each run queues the next; every start queues it if missing.
  const sweeper = createExecutionSweeper({
    executions: stores.executions,
    jobs: stores.jobs,
    approvals: stores.approvals,
    tenancy,
    runtime: engine,
    ledger: new FirestoreSweepLedger(firestore),
    // A plan step waiting for a person is advanced, never abandoned (ADR-0146).
    ...(advancePlan === undefined
      ? {}
      : {
          plans: {
            find: (organizationId, id) => plans.find(organizationId, id),
            advance: advancePlan,
          },
        }),
    scheduler: createCloudTasksScheduler({
      queue: runtime.queue,
      targetUrl: `${runtime.workerUrl}${RUN_SWEEP_PATH}`,
      audience: runtime.workerUrl,
      invokerEmail: runtime.invokerEmail,
      dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
    }),
    ...(schedules === undefined ? {} : { schedules }),
    logger: logger.child({ component: 'sweeps' }),
  });
  void sweeper.ensureNext();
  return {
    sweeps: sweeper,
    ...(schedules === undefined ? {} : { schedules }),
    handler: createJobHandler({
      jobs: jobService,
      runtime: engine,
      workerId,
      ...(taskParts.waitingApproval === undefined
        ? {}
        : { onWaitingApproval: taskParts.waitingApproval }),
      logger,
    }),
    forecasts: createForecastHandler({
      engine: forecastEngine,
      logger: logger.child({ component: 'forecasts' }),
    }),
    followUps: createFollowUpHandler({
      followUps,
      events,
      logger: logger.child({ component: 'follow-ups' }),
    }),
    events: createEventHandler({ events, logger: logger.child({ component: 'events' }) }),
    ...(advancePlan === undefined
      ? {}
      : {
          planWakes: createPlanWakeHandler({
            plans,
            executions: stores.executions,
            tenancy,
            advance: advancePlan,
            logger: logger.child({ component: 'plans' }),
          }),
        }),
    invoker: createServiceIdentityVerifier({
      audience: runtime.workerUrl,
      allowedEmails: [runtime.invokerEmail],
    }),
  };
}

logger.info('runtime', { enabled: config.runtime !== undefined, workerId });
logger.info('forecasting', {
  model: forecasting.forecasterUrl !== undefined,
  priced: forecasting.creditsPerRun !== undefined,
});
logger.info('conversation agents', {
  ai:
    config.agents.vertexAI !== undefined ||
    config.agents.deepSeek !== undefined ||
    config.agents.nvidia !== undefined,
  sending: config.agents.channelSecretsProjectId !== undefined,
});
const app = createApp({
  logger,
  version: config.version,
  ...(config.runtime === undefined ? {} : { jobs: jobs(config.runtime) }),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, version: config.version });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
