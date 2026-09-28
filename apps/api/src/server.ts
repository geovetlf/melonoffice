import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createAuditService } from '@melonoffice/audit';
import { createIdentityPlatformVerifier } from '@melonoffice/auth';
import { createConversationIngress } from '@melonoffice/conversations';
import {
  createSecretManagerStore,
  createWebhookIngress,
  createWhatsAppAdapter,
  withAgentTurns,
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
  FirestoreConversationRepository,
  FirestoreDepartmentRepository,
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
  const secretProjectId = config.channelSecretsProjectId;
  const whatsapp = createWhatsAppAdapter(
    config.whatsappGraphApiVersion === undefined
      ? {}
      : { graphApiVersion: config.whatsappGraphApiVersion },
  );
  const environment = config.deploymentEnvironment;
  const secrets = createSecretManagerStore();
  const tenancy = new FirestoreTenancyStore(firestore);
  const executions = new FirestoreExecutionRepository(firestore);
  const approvals = new FirestoreApprovalRepository(firestore);
  const structure = {
    departments: new FirestoreDepartmentRepository(firestore),
    specialists: new FirestoreSpecialistRepository(firestore),
  };
  const audit = createAuditService(new FirestoreAuditStore(firestore));
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
    credits: new FirestoreCreditStore(firestore),
    plans: new FirestorePlanRepository(firestore),
    workflows: new FirestoreWorkflowRepository(firestore),
    audit,
    agentTurns,
    conversations: {
      repository: conversations,
      connections,
      agentOutputs: new FirestoreAgentOutputRepository(firestore),
      ...(secretProjectId === undefined ? {} : { secretProjectId }),
      // A person's replies (ADR-0034) only where channel secrets and the environment are both
      // configured: neither is set in Terraform yet, so sending stays off (fails closed).
      ...(secretProjectId === undefined || environment === undefined
        ? {}
        : {
            outbound: {
              secrets,
              adapters: { whatsapp },
              environment,
            },
          }),
    },
    // Webhooks only where channel secrets are configured (none in Terraform yet: CV-2).
    ...(secretProjectId === undefined
      ? {}
      : {
          webhooks: createWebhookIngress({
            connections,
            secrets,
            adapters: [whatsapp],
            conversations: withAgentTurns(
              createConversationIngress({ repository: conversations }),
              agentTurns.trigger,
              logger.child({ component: 'agent-turns' }),
            ),
            logger: logger.child({ component: 'webhooks' }),
          }),
        }),
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
