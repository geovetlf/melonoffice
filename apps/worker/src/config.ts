import type { DeploymentEnvironment } from '@melonoffice/domain';
import { isLogLevel, type LogLevel } from '@melonoffice/observability';

/**
 * What the worker needs to run jobs (ADR-0032). All set by Terraform where the runtime is on (dev
 * today); none of it is a secret. Absent, the worker serves health only and refuses every job.
 */
export interface RuntimeConfig {
  /** The project whose Firestore holds the jobs, reached with the service's own identity. */
  readonly firestoreProjectId: string;
  /** Where this worker runs. Tools and models check it; they fail closed without it. */
  readonly environment: DeploymentEnvironment;
  /** How long a job lease lasts, in milliseconds (provisional, ADR-0032: option A). */
  readonly leaseMs: number;
  /** The Cloud Tasks queue next jobs are handed to. */
  readonly queue: string;
  /** This worker's URL: the OIDC audience it checks and the base of the task target. */
  readonly workerUrl: string;
  /** The only service account allowed to deliver jobs (Cloud Tasks signs as it). */
  readonly invokerEmail: string;
}

/**
 * What conversation agents need on top of the runtime (CV-6B, ADR-0043). Vertex AI is where the
 * approved model runs (D-7); the channel secrets project is where connections' tokens live. None
 * of it is a secret. Absent: agents' model calls are denied and their replies fail closed.
 */
export interface AgentConfig {
  readonly vertexAI?: { readonly projectId: string; readonly location: string };
  readonly channelSecretsProjectId?: string;
  readonly whatsappGraphApiVersion?: string;
}

export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly version: string;
  readonly runtime?: RuntimeConfig;
  readonly agents: AgentConfig;
}

const RUNTIME_KEYS = [
  'FIRESTORE_PROJECT_ID',
  'DEPLOYMENT_ENVIRONMENT',
  'JOB_LEASE_MS',
  'JOB_QUEUE',
  'WORKER_URL',
  'JOB_INVOKER_EMAIL',
] as const;

const ENVIRONMENTS: readonly DeploymentEnvironment[] = ['dev', 'staging', 'prod'];

/** The lease must outlast the longest bounded call (10 min tool timeout) and fit Cloud Tasks (30 min). */
const MIN_LEASE_MS = 60_000;
const MAX_LEASE_MS = 30 * 60_000;

/** Reads configuration from environment variables only; nothing is hard-coded per environment. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ServiceConfig {
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const level = env.LOG_LEVEL ?? 'info';
  if (!isLogLevel(level)) throw new Error(`Invalid LOG_LEVEL: ${level}`);
  const runtime = loadRuntimeConfig(env);
  return {
    port,
    logLevel: level,
    version: env.SERVICE_VERSION ?? 'dev',
    ...(runtime === undefined ? {} : { runtime }),
    agents: loadAgentConfig(env),
  };
}

/** The same settings, and the same checks, as the API's (ADR-0038). */
function loadAgentConfig(env: Readonly<Record<string, string | undefined>>): AgentConfig {
  const projectId = env.VERTEX_AI_PROJECT_ID || undefined;
  const location = env.VERTEX_AI_LOCATION || undefined;
  if ((projectId === undefined) !== (location === undefined)) {
    throw new Error('VERTEX_AI_PROJECT_ID and VERTEX_AI_LOCATION are set together');
  }
  if (projectId !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error(`Invalid VERTEX_AI_PROJECT_ID: ${projectId}`);
  }
  if (location !== undefined && !/^[a-z]+-[a-z]+[0-9]{1,2}$/.test(location)) {
    throw new Error(`Invalid VERTEX_AI_LOCATION: ${location}`);
  }
  const secrets = env.CHANNEL_SECRETS_PROJECT_ID || undefined;
  if (secrets !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(secrets)) {
    throw new Error(`Invalid CHANNEL_SECRETS_PROJECT_ID: ${secrets}`);
  }
  const graph = env.WHATSAPP_GRAPH_API_VERSION || undefined;
  if (graph !== undefined && !/^v\d{1,3}\.\d$/.test(graph)) {
    throw new Error(`Invalid WHATSAPP_GRAPH_API_VERSION: ${graph}`);
  }
  return {
    ...(projectId === undefined || location === undefined
      ? {}
      : { vertexAI: { projectId, location } }),
    ...(secrets === undefined ? {} : { channelSecretsProjectId: secrets }),
    ...(graph === undefined ? {} : { whatsappGraphApiVersion: graph }),
  };
}

/** All of the runtime settings or none. Some but not all is a deployment mistake: refuse to start. */
function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeConfig | undefined {
  const present = RUNTIME_KEYS.filter((key) => (env[key] ?? '') !== '');
  if (present.length === 0) return undefined;
  if (present.length !== RUNTIME_KEYS.length) {
    const missing = RUNTIME_KEYS.filter((key) => !present.includes(key));
    throw new Error(`Incomplete runtime configuration, missing: ${missing.join(', ')}`);
  }
  const environment = env.DEPLOYMENT_ENVIRONMENT as DeploymentEnvironment;
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`Invalid DEPLOYMENT_ENVIRONMENT: ${env.DEPLOYMENT_ENVIRONMENT}`);
  }
  const leaseMs = Number(env.JOB_LEASE_MS);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new Error(`Invalid JOB_LEASE_MS: ${env.JOB_LEASE_MS}`);
  }
  const workerUrl = env.WORKER_URL as string;
  if (!/^https:\/\/[a-z0-9.-]+$/.test(workerUrl)) {
    throw new Error(`Invalid WORKER_URL: ${workerUrl}`);
  }
  return {
    firestoreProjectId: env.FIRESTORE_PROJECT_ID as string,
    environment,
    leaseMs,
    queue: env.JOB_QUEUE as string,
    workerUrl,
    invokerEmail: env.JOB_INVOKER_EMAIL as string,
  };
}
