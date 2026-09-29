import { MAX_DOCUMENT_BYTES } from './content.js';
import { DocumentError } from './errors.js';

/**
 * Where documents' bytes live (ADR-0078): Cloud Storage in the API, memory in tests. Objects are
 * created once and never replaced or deleted here; the key is always built by the server.
 */
export interface FileStore {
  /**
   * Creates the object. An object already under that key is success: the key comes from the
   * content's digest, so it holds the same bytes.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or undefined when there is none. */
  get(key: string): Promise<Uint8Array | undefined>;
}

// Server-built keys only: `organizations/{uuid}/documents/{uuid}`, or anything as plain.
const KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

const checkKey = (key: string): string => {
  if (key.length > 512 || !KEY.test(key)) throw new DocumentError('storage_unavailable', 'key');
  return key;
};

/** For tests and local runs only. */
export class InMemoryFileStore implements FileStore {
  readonly #objects = new Map<string, { readonly bytes: Uint8Array; readonly type: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (this.#objects.has(checkKey(key))) return;
    this.#objects.set(key, Object.freeze({ bytes: new Uint8Array(bytes), type: contentType }));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const found = this.#objects.get(checkKey(key));
    return found === undefined ? undefined : new Uint8Array(found.bytes);
  }

  /** Every key stored, for tests. */
  keys(): readonly string[] {
    return [...this.#objects.keys()];
  }
}

export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export interface GcsFileStoreOptions {
  /** The documents bucket, from configuration (Terraform), never from a request. */
  readonly bucket: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** How long one call may take. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

// Bucket names without dots: 3 to 63 lowercase letters, digits, `-` and `_`.
const BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;
/** A token is renewed this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000;

/**
 * Cloud Storage through its JSON API, with the service's own identity: a token from the metadata
 * server, like the Vertex AI adapter (ADR-0038). No SDK and no key; the token never leaves this
 * function. Every failure is `storage_unavailable`, without the provider's message, so nothing
 * Google says reaches a log, an audit event or a person.
 */
export function createGcsFileStore(options: GcsFileStoreOptions): FileStore {
  const { bucket } = options;
  if (!BUCKET.test(bucket) || bucket.startsWith('goog')) throw new Error('documents.bucket');
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  let token: { readonly value: string; readonly until: number } | undefined;

  const unavailable = (detail?: string) => new DocumentError('storage_unavailable', detail);

  async function accessToken(signal: AbortSignal): Promise<string> {
    if (token !== undefined && now().getTime() < token.until) return token.value;
    try {
      const answer = await call(METADATA_TOKEN_URL, {
        headers: { 'metadata-flavor': 'Google' },
        signal,
      });
      if (!answer.ok) throw unavailable('token');
      const body = (await answer.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
        throw unavailable('token');
      }
      const seconds = typeof body.expires_in === 'number' ? body.expires_in : 0;
      token = {
        value: body.access_token,
        until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS,
      };
      return token.value;
    } catch {
      throw unavailable('token');
    }
  }

  /** Sends one call with a fresh or cached token. A refused token is dropped for the next. */
  async function send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const bearer = await accessToken(signal);
    let answer: Response;
    try {
      answer = await call(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${bearer}` },
        signal,
      });
    } catch {
      throw unavailable(signal.aborted ? 'timeout' : 'network');
    }
    if (answer.status === 401) token = undefined;
    return answer;
  }

  const base = `https://storage.googleapis.com`;
  const bucketPath = encodeURIComponent(bucket);

  return Object.freeze({
    async put(key, bytes, contentType) {
      const name = encodeURIComponent(checkKey(key));
      const signal = AbortSignal.timeout(timeoutMs);
      // `ifGenerationMatch=0`: created only if no object has that name, never replaced.
      const answer = await send(
        `${base}/upload/storage/v1/b/${bucketPath}/o?uploadType=media&name=${name}&ifGenerationMatch=0`,
        {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: bytes,
        },
        signal,
      );
      await answer.body?.cancel().catch(() => undefined);
      // 412: the object exists already, with the same bytes (the key is the content's digest).
      if (answer.ok || answer.status === 412) return;
      throw unavailable(String(answer.status));
    },

    async get(key) {
      const name = encodeURIComponent(checkKey(key));
      const signal = AbortSignal.timeout(timeoutMs);
      const answer = await send(
        `${base}/storage/v1/b/${bucketPath}/o/${name}?alt=media`,
        { method: 'GET' },
        signal,
      );
      if (answer.status === 404) {
        await answer.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!answer.ok) {
        await answer.body?.cancel().catch(() => undefined);
        throw unavailable(String(answer.status));
      }
      const declared = Number(answer.headers.get('content-length') ?? '0');
      if (declared > MAX_DOCUMENT_BYTES) {
        await answer.body?.cancel().catch(() => undefined);
        throw unavailable('size');
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await answer.arrayBuffer());
      } catch {
        throw unavailable(signal.aborted ? 'timeout' : 'network');
      }
      // Nothing larger was ever stored: a larger object is not one of ours.
      if (bytes.length > MAX_DOCUMENT_BYTES) throw unavailable('size');
      return bytes;
    },
  } satisfies FileStore);
}
