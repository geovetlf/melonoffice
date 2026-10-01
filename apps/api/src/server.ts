import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createAuditService } from '@melonoffice/audit';
import { createIdentityPlatformVerifier } from '@melonoffice/auth';
import { createConversationIngress } from '@melonoffice/conversations';
import { createGcsFileStore, createTextExtractor } from '@melonoffice/documents';
import {
  createIntegrationEngine,
  createIntegrationRegistry,
  createSecretManagerStore,
  createWhatsAppAdapter,
  deliveryPolicyFromEnv,
  withAgentTurns,
  type ConversationIngressPort,
} from '@melonoffice/integrations';
import {
  createTimesFMProvider,
  forecastingConfigFromEnv,
  metadataIdentityTokens,
} from '@melonoffice/forecasting';
import { createCloudTasksDispatcher, createCloudTasksScheduler } from '@melonoffice/runtime';
import { defaultToolRegistry } from '@melonoffice/tools';
import { createAgentTurns } from './agent-turns.js';
import { createLogger } from '@melonoffice/observability';
import { aiConfigurationOf } from './ai.js';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import {
  FirestoreAgentOutputRepository,
  FirestoreAgentTaskRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreBillingStore,
  FirestoreChannelConnectionRepository,
  FirestoreChannelTemplateRepository,
  FirestoreConnectionRateLimiter,
  FirestoreRequestRateLimiter,
  FirestoreConversationRepository,
  FirestoreAgentPolicyRepository,
  FirestoreBusinessProfileRepository,
  FirestoreKnowledgeRepository,
  FirestoreDepartmentRepository,
  FirestoreDocumentRepository,
  FirestoreEntitlementOverrideStore,
  FirestoreExecutionRepository,
  FirestoreForecastRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreAIUsageStore,
  FirestoreCreditStore,
  FirestorePlanRepository,
  FirestoreTenancyStore,
  FirestoreBrandStore,
  FirestoreCommercialStore,
  FirestoreUserDirectory,
  FirestoreWorkflowRepository,
} from '@melonoffice/firestore';

const config = loadConfig(process.env);
// The Forecasting Engine (ADR-0059): the model's runtime, its credit cost and limits, from
// Terraform. Each missing part refuses runs; nothing is pretended.
const forecastingConfig = forecastingConfigFromEnv(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });

// Auth is on only where Terraform sets the project (dev today). Firestore credentials come from
// the service's runtime identity, never from a key.
const projectId = config.identityProjectId;
function services(projectId: string) {
  const firestore = new Firestore({ projectId });
  // A Comercial page read the old way while its Firestore index is missing is logged (ADR-0061).
  const conversations = new FirestoreConversationRepository(firestore, {
    onIndexMissing: (query) => logger.warn('firestore.index_missing', { query }),
  });
  const connections = new FirestoreChannelConnectionRepository(firestore);
  const templates = new FirestoreChannelTemplateRepository(firestore);
  const secretProjectId = config.channelSecretsProjectId;
  const environment = config.deploymentEnvironment;
  const tenancy = new FirestoreTenancyStore(firestore);
  const executions = new FirestoreExecutionRepository(firestore);
  const approvals = new FirestoreApprovalRepository(firestore);
  const structure = {
    departments: new FirestoreDepartmentRepository(firestore),
    specialists: new FirestoreSpecialistRepository(firestore),
  };
  const audit = createAuditService(new FirestoreAuditStore(firestore));
  // The Integration Engine (ADR-0044), only where channel secrets are configured: its registry
  // holds the official providers this server speaks to (WhatsApp Cloud API today). Inbound
  // messages go to the conversations, then to the agents' turns (below).
  const inbound: { current?: ConversationIngressPort } = {};
  const engine =
    secretProjectId === undefined
      ? undefined
      : createIntegrationEngine({
          registry: createIntegrationRegistry([
            createWhatsAppAdapter(
              config.whatsappGraphApiVersion === undefined
                ? {}
                : { graphApiVersion: config.whatsappGraphApiVersion },
            ),
          ]),
          connections,
          secrets: createSecretManagerStore(),
          inbound: {
            receive: (message) => (inbound.current as ConversationIngressPort).receive(message),
            applyStatus: (update) =>
              (inbound.current as ConversationIngressPort).applyStatus(update),
          },
          audit,
          logger: logger.child({ component: 'integrations' }),
          // Limits and retries (ADR-0045): one send limit per connection, shared with the worker.
          delivery: deliveryPolicyFromEnv(process.env),
          rateLimiter: new FirestoreConnectionRateLimiter(firestore),
          // The organizations' approved templates (ADR-0046).
          templates,
        });
  // Conversation agents (CV-6B, ADR-0043): the API starts an agent's turn after a message is
  // stored and hands jobs to the worker, only where the job transport is configured; without it,
  // started turns wait in the queue. The worker runs them.
  const transport = config.jobTransport;
  const agentTurns = createAgentTurns({
    tenancy,
    ...structure,
    executions,
    approvals,
    jobs: new FirestoreJobRepository(firestore),
    conversations,
    tools: defaultToolRegistry(),
    ...(engine === undefined ? {} : { channels: engine }),
    audit,
    ...(transport === undefined
      ? {}
      : {
          dispatcher: createCloudTasksDispatcher({
            queue: transport.queue,
            targetUrl: `${transport.workerUrl}/internal/jobs/run`,
            audience: transport.workerUrl,
            invokerEmail: transport.invokerEmail,
            dispatchDeadlineSeconds: Math.ceil(transport.leaseMs / 1000),
          }),
        }),
    logger: logger.child({ component: 'agent-turns' }),
  });
  inbound.current = withAgentTurns(
    createConversationIngress({ repository: conversations }),
    agentTurns.trigger,
    logger.child({ component: 'agent-turns' }),
  );
  return {
    auth: {
      verifier: createIdentityPlatformVerifier({ projectId }),
      users: new FirestoreUserDirectory(firestore),
    },
    tenancy,
    // Partner and agency accounts (ADR-0086): three collections, equality queries only.
    commercialAccounts: new FirestoreCommercialStore(firestore),
    // Brands and domains (ADR-0087): two collections, read by id.
    brands: new FirestoreBrandStore(firestore),
    // One limit per person on sensitive requests, shared by every instance (ADR-0092).
    requestLimiter: new FirestoreRequestRateLimiter(firestore),
    billing: new FirestoreBillingStore(firestore),
    executions,
    approvals,
    structure,
    businessProfiles: new FirestoreBusinessProfileRepository(firestore),
    // Organizations' rules for their agents (AE-4.4): one document per organization, by id.
    agentPolicies: new FirestoreAgentPolicyRepository(firestore),
    knowledge: new FirestoreKnowledgeRepository(firestore),
    // Uploaded documents (ADR-0078): records in Firestore, bytes in the documents bucket, reached
    // with the service's own identity. Without the bucket, uploads and downloads are refused.
    documents: {
      repository: new FirestoreDocumentRepository(firestore, {
        onIndexMissing: (query) => logger.warn('firestore.index_missing', { query }),
      }),
      ...(config.documentsBucket === undefined
        ? {}
        : { files: createGcsFileStore({ bucket: config.documentsBucket }) }),
      // PDF and DOCX text, read locally (ADR-0079); PDFs in a bounded worker thread.
      extractor: createTextExtractor(),
    },
    activity: new FirestoreAuditStore(firestore),
    credits: new FirestoreCreditStore(firestore),
    // Every AI call's usage and cost (ADR-0074). Until its index exists, the event list is read
    // without it and the gap logged.
    aiUsage: new FirestoreAIUsageStore(firestore, {
      onIndexMissing: (query) => logger.warn('firestore.index_missing', { query }),
    }),
    plans: new FirestorePlanRepository(firestore),
    // Approving a plan starts it (ADR-0070): its steps are queued through the same runtime.
    planRuntime: agentTurns,
    workflows: new FirestoreWorkflowRepository(firestore),
    audit,
    agentTurns,
    // Agent tasks (ADR-0063): queued for the worker through the same runtime as agents' turns.
    agentTasks: {
      repository: new FirestoreAgentTaskRepository(firestore, {
        onIndexMissing: (query) => logger.warn('firestore.index_missing', { query }),
      }),
      outputs: new FirestoreAgentOutputRepository(firestore),
      runtime: agentTurns,
    },
    entitlementOverrides: new FirestoreEntitlementOverrideStore(firestore),
    conversations: {
      repository: conversations,
      connections,
      agentOutputs: new FirestoreAgentOutputRepository(firestore),
      ...(secretProjectId === undefined ? {} : { secretProjectId }),
      ...(engine === undefined ? {} : { engine }),
      // Follow-ups' tasks (C5, ADR-0058) go to the worker through the same queue and invoker,
      // held by Cloud Tasks until their time. Without the transport none can be scheduled.
      ...(transport === undefined
        ? {}
        : {
            followUpScheduler: createCloudTasksScheduler({
              queue: transport.queue,
              targetUrl: `${transport.workerUrl}/internal/follow-ups/run`,
              audience: transport.workerUrl,
              invokerEmail: transport.invokerEmail,
              dispatchDeadlineSeconds: Math.ceil(transport.leaseMs / 1000),
            }),
          }),
      // A person's replies (ADR-0034) only where the engine and the environment are both
      // configured (DEV, from Terraform); anywhere else sending stays off (fails closed).
      ...(engine === undefined || environment === undefined ? {} : { outbound: { environment } }),
      // A person's business tools (TL-1, ADR-0068) run where this server's environment is set.
      ...(environment === undefined ? {} : { toolEnvironment: environment }),
    },
    // Forecasts (ADR-0059): stored in Firestore; a run goes to the worker on the same queue and
    // invoker as jobs. The API never calls the model: it only needs to know it is deployed.
    forecasting: {
      repository: new FirestoreForecastRepository(firestore),
      ...(forecastingConfig.forecasterUrl === undefined
        ? {}
        : {
            provider: createTimesFMProvider({
              url: forecastingConfig.forecasterUrl,
              token: metadataIdentityTokens({ audience: forecastingConfig.forecasterUrl }),
            }),
          }),
      ...(transport === undefined
        ? {}
        : {
            scheduler: (() => {
              const scheduler = createCloudTasksScheduler({
                queue: transport.queue,
                targetUrl: `${transport.workerUrl}/internal/forecasts/run`,
                audience: transport.workerUrl,
                invokerEmail: transport.invokerEmail,
                dispatchDeadlineSeconds: Math.ceil(transport.leaseMs / 1000),
              });
              return { enqueue: (task: object) => scheduler.schedule(task, new Date()) };
            })(),
          }),
      ...(forecastingConfig.creditsPerRun === undefined
        ? {}
        : { creditsPerRun: forecastingConfig.creditsPerRun }),
      limits: forecastingConfig.limits,
    },
    // Webhooks: the engine's inbound side, only where it exists.
    ...(engine === undefined ? {} : { webhooks: engine }),
  };
}
const configured = projectId === undefined ? {} : services(projectId);
logger.info('auth', { enabled: projectId !== undefined });
logger.info('channels', {
  enabled: 'webhooks' in configured,
  sending:
    projectId !== undefined &&
    config.channelSecretsProjectId !== undefined &&
    config.deploymentEnvironment !== undefined,
});

logger.info('web origins', { count: config.webOrigins?.length ?? 0 });
logger.info('platform admins', { count: config.platformAdminUserIds?.length ?? 0 });
logger.info('documents', {
  storage: projectId !== undefined && config.documentsBucket !== undefined,
});
logger.info('forecasting', {
  model: forecastingConfig.forecasterUrl !== undefined,
  priced: forecastingConfig.creditsPerRun !== undefined,
});

// The AI Gateway (ADR-0027, ADR-0038): Vertex AI with Gemini 2.5 Flash-Lite (D-7) and the credit
// rate (D-12), only where Terraform sets the environment and the Vertex AI project (DEV today).
// Anywhere else nothing is registered and every AI call is denied before reaching a provider.
const ai = aiConfigurationOf({ ...config, env: process.env });
logger.info('ai', { enabled: ai.registry !== undefined, environment: ai.environment ?? null });

const app = createApp({
  logger,
  version: config.version,
  webOrigins: config.webOrigins ?? [],
  platformAdmins: config.platformAdminUserIds ?? [],
  ai,
  ...configured,
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
