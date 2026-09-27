import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createAuditService } from '@melonoffice/audit';
import { createIdentityPlatformVerifier } from '@melonoffice/auth';
import { createLogger } from '@melonoffice/observability';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { FirestoreAuditStore } from './audit-firestore.js';
import { FirestoreBillingStore } from './billing-firestore.js';
import { FirestoreExecutionRepository } from './executions-firestore.js';
import { FirestoreTenancyStore } from './tenancy-firestore.js';
import { FirestoreUserDirectory } from './users-firestore.js';

const config = loadConfig(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });

// Auth is on only where Terraform sets the project (dev today). Firestore credentials come from
// the service's runtime identity, never from a key.
const projectId = config.identityProjectId;
function services(projectId: string) {
  const firestore = new Firestore({ projectId });
  return {
    auth: {
      verifier: createIdentityPlatformVerifier({ projectId }),
      users: new FirestoreUserDirectory(firestore),
    },
    tenancy: new FirestoreTenancyStore(firestore),
    billing: new FirestoreBillingStore(firestore),
    executions: new FirestoreExecutionRepository(firestore),
    audit: createAuditService(new FirestoreAuditStore(firestore)),
  };
}
const configured = projectId === undefined ? {} : services(projectId);
logger.info('auth', { enabled: projectId !== undefined });

const app = createApp({ logger, version: config.version, ...configured });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, version: config.version });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
