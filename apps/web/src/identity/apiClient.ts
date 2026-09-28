import type { Session } from './session.js';

/**
 * The one way the web app calls the MelonOffice API (ADR-0036). It adds the session's ID token to
 * every request; on a 401 it refreshes the token once and retries, and if that is still refused
 * the session is over (the app goes back to sign-in). Every other answer is returned as it is:
 * the API, not the web app, decides what the user may do.
 */

export type ApiErrorKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'server';

/** A refused call: its kind for the app, and the API's stable code. Never a stack or a token. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
  get kind(): ApiErrorKind {
    if (this.status === 401) return 'unauthorized';
    if (this.status === 403) return 'forbidden';
    if (this.status === 404) return 'not_found';
    if (this.status === 409) return 'conflict';
    if (this.status >= 400 && this.status < 500) return 'invalid';
    return 'server';
  }
}

export interface ApiClient {
  /** The API's address, e.g. to show a webhook URL. Not a secret. */
  readonly baseUrl: string;
  /** A raw request, authenticated. Same shape as `fetch`, for clients such as the inbox's. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** A JSON request: the parsed body, or an `ApiError`. */
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

export function createApiClient(
  apiUrl: string,
  session: Session,
  fetcher: typeof fetch = fetch,
): ApiClient {
  async function send(path: string, init: RequestInit, token: string | undefined) {
    const headers = new Headers(init.headers);
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    return fetcher(`${apiUrl}${path}`, { ...init, headers, credentials: 'omit' });
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/v1/')) throw new ApiError(400, 'invalid_path');
    const response = await send(path, init, await session.token());
    if (response.status !== 401) return response;
    // The token may have just expired or been revoked: one fresh token, one more try.
    const fresh = await session.token({ force: true });
    if (fresh === undefined) return response;
    const retried = await send(path, init, fresh);
    if (retried.status === 401) session.expire();
    return retried;
  }

  return {
    baseUrl: apiUrl,
    request,
    async json<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await request(path, init);
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (!response.ok) {
        throw new ApiError(
          response.status,
          typeof body.error === 'string' ? body.error : 'generic',
        );
      }
      return body as T;
    },
  };
}
