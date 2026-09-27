import type { ChannelConnectionId, ChannelSecretKind, SecretRef } from '@melonoffice/domain';
import { IntegrationError } from './errors.js';

/**
 * Channel credentials live in Secret Manager, never in Firestore, logs, audit, errors or API
 * answers (ADR-0033). Records keep only a `SecretRef`: the secret's resource name, which is not
 * sensitive. The name is derived by the server from the connection id, so no client can point a
 * connection at another organization's secret.
 */

export const CHANNEL_SECRET_KINDS = [
  'app_secret',
  'access_token',
  'verify_token',
] as const satisfies readonly ChannelSecretKind[];

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/channel-[0-9a-f-]{36}-(app-secret|access-token|verify-token)\/versions\/latest$/;

export const isSecretRef = (value: unknown): value is SecretRef =>
  typeof value === 'string' && REF.test(value);

/** `projects/{project}/secrets/channel-{connectionId}-{kind}/versions/latest`. */
export function secretRefFor(
  projectId: string,
  connectionId: ChannelConnectionId,
  kind: ChannelSecretKind,
): SecretRef {
  if (!PROJECT.test(projectId)) throw new IntegrationError('invalid_connection', 'secretProject');
  if (!UUID.test(connectionId)) throw new IntegrationError('invalid_connection', 'connectionId');
  if (!(CHANNEL_SECRET_KINDS as readonly string[]).includes(kind)) {
    throw new IntegrationError('invalid_connection', 'secretKind');
  }
  return `projects/${projectId}/secrets/channel-${connectionId}-${kind.replace('_', '-')}/versions/latest` as SecretRef;
}

/** The secret references of a connection, all derived from its id. */
export function secretRefsFor(
  projectId: string,
  connectionId: ChannelConnectionId,
): Readonly<Record<ChannelSecretKind, SecretRef>> {
  return Object.freeze({
    app_secret: secretRefFor(projectId, connectionId, 'app_secret'),
    access_token: secretRefFor(projectId, connectionId, 'access_token'),
    verify_token: secretRefFor(projectId, connectionId, 'verify_token'),
  });
}

/**
 * Reads a secret's value at the moment it is needed. The value is used and dropped: callers
 * never store it, log it or put it in an error.
 */
export interface SecretStore {
  /** `secret_not_found` when it does not exist; `secret_unavailable` when it cannot be read now. */
  read(ref: SecretRef): Promise<string>;
}

/** For tests and local runs only. */
export class InMemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();

  put(ref: SecretRef, value: string): void {
    this.#values.set(ref, value);
  }

  async read(ref: SecretRef): Promise<string> {
    if (!isSecretRef(ref)) throw new IntegrationError('secret_not_found');
    const value = this.#values.get(ref);
    if (value === undefined) throw new IntegrationError('secret_not_found');
    return value;
  }
}

export const SECRET_MANAGER_URL = 'https://secretmanager.googleapis.com/v1';
export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

const MAX_SECRET_BYTES = 8192;

/**
 * Secret Manager over its REST API, authenticated with the service's own identity through the
 * metadata server: no key, no SDK. Only `secretVersions.access` is used; the service account
 * needs `roles/secretmanager.secretAccessor` on the channel secrets (INFRASTRUCTURE REQUIRED,
 * not applied in CV-1).
 */
export function createSecretManagerStore(
  options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {},
): SecretStore {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  return {
    async read(ref) {
      if (!isSecretRef(ref)) throw new IntegrationError('secret_not_found');
      let token: string;
      try {
        const answer = await call(METADATA_TOKEN_URL, {
          headers: { 'metadata-flavor': 'Google' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!answer.ok) throw new Error('token');
        const body = (await answer.json()) as { access_token?: unknown };
        if (typeof body.access_token !== 'string') throw new Error('token');
        token = body.access_token;
      } catch {
        throw new IntegrationError('secret_unavailable');
      }
      let answer: Response;
      try {
        answer = await call(`${SECRET_MANAGER_URL}/${ref}:access`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new IntegrationError('secret_unavailable');
      }
      if (answer.status === 404) throw new IntegrationError('secret_not_found');
      if (!answer.ok) throw new IntegrationError('secret_unavailable');
      try {
        const body = (await answer.json()) as { payload?: { data?: unknown } };
        const data = body.payload?.data;
        if (typeof data !== 'string') throw new Error('payload');
        const value = Buffer.from(data, 'base64').toString('utf8');
        if (value.length === 0 || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
          throw new Error('payload');
        }
        return value;
      } catch {
        throw new IntegrationError('secret_unavailable');
      }
    },
  };
}
