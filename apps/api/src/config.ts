import type { DeploymentEnvironment } from '@melonoffice/domain';
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
  /**
   * The project whose Secret Manager holds channel credentials (ADR-0033). Unset: channel
   * webhooks answer 503 and no channel connection can be created.
   */
  readonly channelSecretsProjectId?: string;
  /** Graph API version for WhatsApp sends, e.g. `v23.0`. Unset: nothing can be sent. */
  readonly whatsappGraphApiVersion?: string;
  /**
   * Where this server runs (`dev`, `staging`, `prod`), for the tool gate (ADR-0034): a tool runs
   * only where its version allows. Unset: a person's send is not wired at all (fails closed).
   */
  readonly deploymentEnvironment?: DeploymentEnvironment;
}

const ENVIRONMENTS: readonly string[] = ['dev', 'staging', 'prod'];

/** Google Cloud project ids: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const GRAPH_VERSION = /^v[0-9]{1,3}\.[0-9]$/;

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
  const channelSecretsProjectId = env.CHANNEL_SECRETS_PROJECT_ID;
  if (channelSecretsProjectId !== undefined && !PROJECT_ID.test(channelSecretsProjectId)) {
    throw new Error(`Invalid CHANNEL_SECRETS_PROJECT_ID: ${channelSecretsProjectId}`);
  }
  const whatsappGraphApiVersion = env.WHATSAPP_GRAPH_API_VERSION;
  if (whatsappGraphApiVersion !== undefined && !GRAPH_VERSION.test(whatsappGraphApiVersion)) {
    throw new Error(`Invalid WHATSAPP_GRAPH_API_VERSION: ${whatsappGraphApiVersion}`);
  }
  const deploymentEnvironment = env.DEPLOYMENT_ENVIRONMENT;
  if (deploymentEnvironment !== undefined && !ENVIRONMENTS.includes(deploymentEnvironment)) {
    throw new Error(`Invalid DEPLOYMENT_ENVIRONMENT: ${deploymentEnvironment}`);
  }
  return {
    port,
    logLevel: level,
    version: env.SERVICE_VERSION ?? 'dev',
    ...(identityProjectId === undefined ? {} : { identityProjectId }),
    ...(channelSecretsProjectId === undefined ? {} : { channelSecretsProjectId }),
    ...(whatsappGraphApiVersion === undefined ? {} : { whatsappGraphApiVersion }),
    ...(deploymentEnvironment === undefined
      ? {}
      : { deploymentEnvironment: deploymentEnvironment as DeploymentEnvironment }),
  };
}
