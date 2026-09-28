import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createAuditService } from '@melonoffice/audit';
import { createIdentityPlatformVerifier } from '@melonoffice/auth';
import { createConversationIngress } from '@melonoffice/conversations';
import {
  createIntegrationEngine,
  createIntegrationRegistry,
  createSecretManagerStore,
  createWhatsAppAdapter,
  deliveryPolicyFromEnv,
  withAgentTurns,
  type ConversationIngressPort,
} from '@melonoffice/integrations';
import { createCloudTasksDispatcher } from '@melonoffice/runtime';
import { defaultToolRegistry } from '@melonoffice/tools';
import { createAgentTurns } from './agent-turns.js';
import { createLogger } from '@melonoffice/observability';
import { aiConfigurationOf } from './ai.js';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import {
  FirestoreAgentOutputRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreBillingStore,
  FirestoreChannelConnectionRepository,
  FirestoreChannelTemplateRepository,
  FirestoreConnectionRateLimiter,
  FirestoreConversationRepository,
  FirestoreBusinessProfileRepository,
  FirestoreKnowledgeRepository,
  FirestoreDepartmentRepository,
  FirestoreEntitlementOverrideStore,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreCreditStore,
  FirestorePlanRepository,
  FirestoreTenancyStore,
  FirestoreUserDirectory,
  FirestoreWorkflowRepository,
} from '@melonoffice/firestore';

const config = loadConfig(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });

// Auth is on only where Terraform sets the project (dev today). Firestore credentials come from
// the service's runtime identity, never from a key.
const projectId = config.identityProjectId;
function services(projectId: string) {
  const firestore = new Firestore({ projectId });
  const conversations = new FirestoreConversationRepository(firestore);
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
    billing: new FirestoreBillingStore(firestore),
    executions,
    approvals,
    structure,
    businessProfiles: new FirestoreBusinessProfileRepository(firestore),
    knowledge: new FirestoreKnowledgeRepository(firestore),
    activity: new FirestoreAuditStore(firestore),
    credits: new FirestoreCreditStore(firestore),
    plans: new FirestorePlanRepository(firestore),
    workflows: new FirestoreWorkflowRepository(firestore),
    audit,
    agentTurns,
    entitlementOverrides: new FirestoreEntitlementOverrideStore(firestore),
    conversations: {
      repository: conversations,
      connections,
      agentOutputs: new FirestoreAgentOutputRepository(firestore),
      ...(secretProjectId === undefined ? {} : { secretProjectId }),
      ...(engine === undefined ? {} : { engine }),
      // A person's replies (ADR-0034) only where the engine and the environment are both
      // configured (DEV, from Terraform); anywhere else sending stays off (fails closed).
      ...(engine === undefined || environment === undefined ? {} : { outbound: { environment } }),
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

// The AI Gateway (ADR-0027, ADR-0038): Vertex AI with Gemini 2.5 Flash-Lite (D-7) and the credit
// rate (D-12), only where Terraform sets the environment and the Vertex AI project (DEV today).
// Anywhere else nothing is registered and every AI call is denied before reaching a provider.
const ai = aiConfigurationOf(config);
logger.info('ai', { enabled: ai.registry !== undefined, environment: ai.environment ?? null });

const app = createApp({
  logger,
  version: config.version,
  webOrigins: config.webOrigins ?? [],
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
