import type { DeploymentEnvironment, SecretRef } from '@melonoffice/domain';
import { isAISecretRef } from '@melonoffice/integrations';
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
  /**
   * The web app's origins, comma-separated in `WEB_ORIGINS`, allowed to call `/v1` from a browser
   * (ADR-0036). Unset: none.
   */
  readonly webOrigins?: readonly string[];
  /**
   * The MelonOffice platform administrators (ADR-0082), as exact user ids comma-separated in
   * `PLATFORM_ADMIN_USER_IDS`: only they see AI providers, models, routing and internal cost.
   * Unset or empty: nobody does.
   */
  readonly platformAdminUserIds?: readonly string[];
  /**
   * Where Vertex AI runs the approved model (D-7, ADR-0038): `VERTEX_AI_PROJECT_ID` and
   * `VERTEX_AI_LOCATION`, both or neither. Unset: no AI provider is registered and every AI call
   * is denied.
   */
  readonly vertexAI?: { readonly projectId: string; readonly location: string };
  /**
   * DeepSeek's official API (ADR-0072): `DEEPSEEK_API_KEY_SECRET`, the Secret Manager reference
   * of its key (`projects/{project}/secrets/ai-{name}/versions/latest`), never the key itself.
   * Unset: DeepSeek is not registered.
   */
  readonly deepSeek?: { readonly keySecret: SecretRef };
  /**
   * NVIDIA's official hosted API (ADR-0080): `NVIDIA_API_KEY_SECRET`, the Secret Manager
   * reference of its key (`projects/{project}/secrets/ai-{name}/versions/latest`), never the key
   * itself. Unset: NVIDIA is not registered.
   */
  readonly nvidia?: { readonly keySecret: SecretRef };
  /**
   * The Cloud Storage bucket that holds uploaded documents (ADR-0078): `DOCUMENTS_BUCKET`, from
   * Terraform. Unset: uploads and downloads answer 503 (`storage_unavailable`).
   */
  readonly documentsBucket?: string;
  /**
   * Where an agent's first job is handed to the worker (CV-6B, ADR-0043): `JOB_QUEUE`,
   * `WORKER_URL`, `JOB_INVOKER_EMAIL` and `JOB_LEASE_MS`, all or none, the worker's own values.
   * Unset: a turn is started and its job stays queued (nothing runs in the API).
   */
  readonly jobTransport?: {
    readonly queue: string;
    readonly workerUrl: string;
    readonly invokerEmail: string;
    readonly leaseMs: number;
  };
}

const JOB_TRANSPORT_KEYS = [
  'JOB_QUEUE',
  'WORKER_URL',
  'JOB_INVOKER_EMAIL',
  'JOB_LEASE_MS',
] as const;

/** All of the job transport settings or none. The dispatcher checks each value again. */
function loadJobTransport(
  env: Readonly<Record<string, string | undefined>>,
): ServiceConfig['jobTransport'] {
  const present = JOB_TRANSPORT_KEYS.filter((key) => (env[key] ?? '') !== '');
  if (present.length === 0) return undefined;
  if (present.length !== JOB_TRANSPORT_KEYS.length) {
    const missing = JOB_TRANSPORT_KEYS.filter((key) => !present.includes(key));
    throw new Error(`Incomplete job transport configuration, missing: ${missing.join(', ')}`);
  }
  const leaseMs = Number(env.JOB_LEASE_MS);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 60_000 || leaseMs > 30 * 60_000) {
    throw new Error(`Invalid JOB_LEASE_MS: ${env.JOB_LEASE_MS}`);
  }
  const workerUrl = env.WORKER_URL as string;
  if (!/^https:\/\/[a-z0-9.-]+$/.test(workerUrl))
    throw new Error(`Invalid WORKER_URL: ${workerUrl}`);
  return {
    queue: env.JOB_QUEUE as string,
    workerUrl,
    invokerEmail: env.JOB_INVOKER_EMAIL as string,
    leaseMs,
  };
}

const ENVIRONMENTS: readonly string[] = ['dev', 'staging', 'prod'];

/** Google Cloud project ids: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A Google Cloud region, e.g. `us-central1`. */
const LOCATION = /^[a-z]+-[a-z]+[0-9]{1,2}$/;

const GRAPH_VERSION = /^v[0-9]{1,3}\.[0-9]$/;

/** A bucket name without dots, as Terraform names it (`{project}-documents`). */
const BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;

/** An exact origin: https, or http only for a local development host. No path, no wildcard. */
const ORIGIN =
  /^(https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|http:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$/;

/** A user id as MelonOffice creates them (a UUID). */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  const webOrigins = (env.WEB_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  for (const origin of webOrigins) {
    if (!ORIGIN.test(origin)) throw new Error(`Invalid WEB_ORIGINS entry: ${origin}`);
  }
  const platformAdminUserIds = (env.PLATFORM_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  for (const id of platformAdminUserIds) {
    if (!USER_ID.test(id)) throw new Error('Invalid PLATFORM_ADMIN_USER_IDS entry');
  }
  const jobTransport = loadJobTransport(env);
  const vertexProjectId = env.VERTEX_AI_PROJECT_ID;
  const vertexLocation = env.VERTEX_AI_LOCATION;
  if ((vertexProjectId === undefined) !== (vertexLocation === undefined)) {
    throw new Error('VERTEX_AI_PROJECT_ID and VERTEX_AI_LOCATION are set together');
  }
  if (vertexProjectId !== undefined && !PROJECT_ID.test(vertexProjectId)) {
    throw new Error(`Invalid VERTEX_AI_PROJECT_ID: ${vertexProjectId}`);
  }
  if (vertexLocation !== undefined && !LOCATION.test(vertexLocation)) {
    throw new Error(`Invalid VERTEX_AI_LOCATION: ${vertexLocation}`);
  }
  const documentsBucket = env.DOCUMENTS_BUCKET || undefined;
  if (documentsBucket !== undefined && !BUCKET.test(documentsBucket)) {
    throw new Error(`Invalid DOCUMENTS_BUCKET: ${documentsBucket}`);
  }
  const deepSeekKeySecret = env.DEEPSEEK_API_KEY_SECRET || undefined;
  if (deepSeekKeySecret !== undefined && !isAISecretRef(deepSeekKeySecret)) {
    // The reference, not the value, is shown: a key pasted here by mistake is not echoed.
    throw new Error('Invalid DEEPSEEK_API_KEY_SECRET: expected a Secret Manager ai-* reference');
  }
  const nvidiaKeySecret = env.NVIDIA_API_KEY_SECRET || undefined;
  if (nvidiaKeySecret !== undefined && !isAISecretRef(nvidiaKeySecret)) {
    throw new Error('Invalid NVIDIA_API_KEY_SECRET: expected a Secret Manager ai-* reference');
  }
  return {
    port,
    logLevel: level,
    version: env.SERVICE_VERSION ?? 'dev',
    ...(deepSeekKeySecret === undefined ? {} : { deepSeek: { keySecret: deepSeekKeySecret } }),
    ...(nvidiaKeySecret === undefined ? {} : { nvidia: { keySecret: nvidiaKeySecret } }),
    ...(identityProjectId === undefined ? {} : { identityProjectId }),
    ...(channelSecretsProjectId === undefined ? {} : { channelSecretsProjectId }),
    ...(whatsappGraphApiVersion === undefined ? {} : { whatsappGraphApiVersion }),
    ...(deploymentEnvironment === undefined
      ? {}
      : { deploymentEnvironment: deploymentEnvironment as DeploymentEnvironment }),
    ...(webOrigins.length === 0 ? {} : { webOrigins }),
    ...(platformAdminUserIds.length === 0 ? {} : { platformAdminUserIds }),
    ...(vertexProjectId === undefined || vertexLocation === undefined
      ? {}
      : { vertexAI: { projectId: vertexProjectId, location: vertexLocation } }),
    ...(jobTransport === undefined ? {} : { jobTransport }),
    ...(documentsBucket === undefined ? {} : { documentsBucket }),
  };
}
