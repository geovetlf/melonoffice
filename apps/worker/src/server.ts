import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import {
  AI_MODEL_CATALOGUE,
  AI_PROVIDER_CATALOGUE,
  createProviderRegistry,
} from '@melonoffice/ai-gateway';
import { createServiceIdentityVerifier } from '@melonoffice/auth';
import {
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
} from '@melonoffice/firestore';
import { createLogger } from '@melonoffice/observability';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { randomUUID } from 'node:crypto';
import { createApp, RUN_JOB_PATH, SERVICE_NAME, type AppOptions } from './app.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { createCloudTasksDispatcher } from './dispatcher.js';
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
  const { jobs: jobService, runtime: engine } = createWorkerRuntime({
    stores: {
      tenancy: new FirestoreTenancyStore(firestore),
      departments: new FirestoreDepartmentRepository(firestore),
      specialists: new FirestoreSpecialistRepository(firestore),
      executions: new FirestoreExecutionRepository(firestore),
      approvals: new FirestoreApprovalRepository(firestore),
      jobs: new FirestoreJobRepository(firestore),
      audit: new FirestoreAuditStore(firestore),
    },
    environment: runtime.environment,
    leaseMs: runtime.leaseMs,
    // The real catalogues: empty until tools and providers are approved (ADR-0026, D-7). No
    // credit rate (D-12): every model call is denied. No work source or verifier yet: nodes fail
    // with `input_unavailable` and nothing is completed without evidence.
    tools: { registry: createToolRegistry(TOOL_CATALOGUE), executors: {} },
    ai: createProviderRegistry({
      providers: AI_PROVIDER_CATALOGUE,
      models: AI_MODEL_CATALOGUE,
      adapters: [],
    }),
    dispatcher: createCloudTasksDispatcher({
      queue: runtime.queue,
      targetUrl: `${runtime.workerUrl}${RUN_JOB_PATH}`,
      audience: runtime.workerUrl,
      invokerEmail: runtime.invokerEmail,
      dispatchDeadlineSeconds: Math.ceil(runtime.leaseMs / 1000),
    }),
    logger,
  });
  return {
    handler: createJobHandler({ jobs: jobService, runtime: engine, workerId, logger }),
    invoker: createServiceIdentityVerifier({
      audience: runtime.workerUrl,
      allowedEmails: [runtime.invokerEmail],
    }),
  };
}

logger.info('runtime', { enabled: config.runtime !== undefined, workerId });
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
