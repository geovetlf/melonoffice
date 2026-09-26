import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createIdentityPlatformVerifier, noMemberships } from '@melonoffice/auth';
import { createLogger } from '@melonoffice/observability';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { FirestoreUserDirectory } from './users-firestore.js';

const config = loadConfig(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });

// Auth is on only where Terraform sets the project (dev today). Firestore credentials come from
// the service's runtime identity, never from a key.
const projectId = config.identityProjectId;
const auth =
  projectId === undefined
    ? undefined
    : {
        verifier: createIdentityPlatformVerifier({ projectId }),
        users: new FirestoreUserDirectory(new Firestore({ projectId })),
        memberships: noMemberships,
      };
logger.info('auth', { enabled: auth !== undefined });

const app = createApp({ logger, version: config.version, ...(auth ? { auth } : {}) });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, version: config.version });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
