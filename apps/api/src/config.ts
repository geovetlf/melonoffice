import { isLogLevel, type LogLevel } from '@melonoffice/observability';

export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly version: string;
  /**
   * The Google Cloud project whose Identity Platform issues tokens and whose Firestore holds
   * users. Unset: auth is off and every /v1 route answers 503 (ADR-0016, ADR-0017).
   */
  readonly identityProjectId?: string;
}

/** Google Cloud project ids: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Reads configuration from environment variables only; nothing is hard-coded per environment. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ServiceConfig {
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const level = env.LOG_LEVEL ?? 'info';
  if (!isLogLevel(level)) throw new Error(`Invalid LOG_LEVEL: ${level}`);
  const identityProjectId = env.IDENTITY_PLATFORM_PROJECT_ID;
  if (identityProjectId !== undefined && !PROJECT_ID.test(identityProjectId)) {
    throw new Error(`Invalid IDENTITY_PLATFORM_PROJECT_ID: ${identityProjectId}`);
  }
  return {
    port,
    logLevel: level,
    version: env.SERVICE_VERSION ?? 'dev',
    ...(identityProjectId === undefined ? {} : { identityProjectId }),
  };
}
