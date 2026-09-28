import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import {
  AI_MODEL_CATALOGUE,
  AI_PROVIDER_CATALOGUE,
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
} from '@melonoffice/ai-gateway';
import {
  CONVERSATION_AGENT_POLICY,
  createVertexAIAdapter,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
} from '@melonoffice/ai-vertex';
import { createAuditService } from '@melonoffice/audit';
import { createServiceIdentityVerifier } from '@melonoffice/auth';
import { createCreditService } from '@melonoffice/credits';
import {
  FirestoreAgentOutputRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreBusinessProfileRepository,
  FirestoreChannelConnectionRepository,
  FirestoreChannelTemplateRepository,
  FirestoreConnectionRateLimiter,
  FirestoreConversationRepository,
  FirestoreCreditStore,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
} from '@melonoffice/firestore';
import {
  createIntegrationEngine,
  createIntegrationRegistry,
  createSecretManagerStore,
  createWhatsAppAdapter,
  deliveryPolicyFromEnv,
} from '@melonoffice/integrations';
import { createFollowUpService } from '@melonoffice/conversations';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { createConversationAgentParts } from './agents.js';
import { randomUUID } from 'node:crypto';
import { createApp, RUN_JOB_PATH, SERVICE_NAME, type AppOptions } from './app.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { createCloudTasksDispatcher, createCloudTasksScheduler } from './dispatcher.js';
import { createFollowUpHandler, RUN_FOLLOW_UP_PATH } from './follow-ups.js';
import { createJobHandler } from './handler.js';
import { createWorkerRuntime } from './runtime.js';

const config = loadConfig(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });

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
    executions: new FirestoreExecutionRepository(firestore),
    approvals: new FirestoreApprovalRepository(firestore),
    jobs: new FirestoreJobRepository(firestore),
    audit: new FirestoreAuditStore(firestore),
  };
  const { vertexAI, channelSecretsProjectId, whatsappGraphApiVersion } = config.agents;
  // Conversation agents (CV-6B, ADR-0043): their tools' executors, work source, verifier, answer
  // store and stop hook. The reply's executor exists only where channel secrets are configured;
  // without it a reply fails at the gate and the conversation goes to a person.
  const agents = createConversationAgentParts({
    stores: {
      ...stores,
      conversations: new FirestoreConversationRepository(firestore),
      outputs: new FirestoreAgentOutputRepository(firestore),
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
  const { jobs: jobService, runtime: engine } = createWorkerRuntime({
    stores,
    environment: runtime.environment,
    leaseMs: runtime.leaseMs,
    // The real tool catalogue (ADR-0026) with the conversation agent's executors. The model is
    // Vertex AI's Gemini 2.5 Flash-Lite (D-7) with the credit rate (D-12), only where Terraform
    // sets the Vertex AI project; anywhere else no provider is registered and every model call
    // is denied before reaching one.
    tools: { registry: createToolRegistry(TOOL_CATALOGUE), executors: agents.executors },
    ai:
      vertexAI === undefined
        ? createProviderRegistry({
            providers: AI_PROVIDER_CATALOGUE,
            models: AI_MODEL_CATALOGUE,
            adapters: [],
          })
        : createProviderRegistry({
            providers: [VERTEX_AI_PROVIDER],
            models: VERTEX_AI_MODELS,
            adapters: [
              createVertexAIAdapter({
                projectId: vertexAI.projectId,
                location: vertexAI.location,
              }),
            ],
          }),
    ...(vertexAI === undefined
      ? {}
      : {
          credits: {
            port: createCreditService({
              store: new FirestoreCreditStore(firestore),
              organizations: tenancy,
            }),
            rate: CREDIT_RATE,
          },
          policies: createModelPolicyCatalogue([CONVERSATION_AGENT_POLICY]),
        }),
    work: agents.work,
    verifier: agents.verifier,
    outputs: agents.outputs,
    onStopped: agents.onStopped,
    dispatcher: createCloudTasksDispatcher({
      queue: runtime.queue,
      targetUrl: `${runtime.workerUrl}${RUN_JOB_PATH}`,
      audience: runtime.workerUrl,
      invokerEmail: runtime.invokerEmail,
      dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
    }),
    logger,
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
  return {
    handler: createJobHandler({ jobs: jobService, runtime: engine, workerId, logger }),
    followUps: createFollowUpHandler({
      followUps,
      logger: logger.child({ component: 'follow-ups' }),
    }),
    invoker: createServiceIdentityVerifier({
      audience: runtime.workerUrl,
      allowedEmails: [runtime.invokerEmail],
    }),
  };
}

logger.info('runtime', { enabled: config.runtime !== undefined, workerId });
logger.info('conversation agents', {
  ai: config.agents.vertexAI !== undefined,
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
