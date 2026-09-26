import { serve } from '@hono/node-server';
import { createLogger } from '@melonoffice/observability';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const logger = createLogger({ service: SERVICE_NAME, level: config.logLevel });
const app = createApp({ logger, version: config.version });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, version: config.version });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
