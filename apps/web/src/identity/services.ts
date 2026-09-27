import { createApiClient, type ApiClient } from './apiClient.js';
import type { WebConfig } from './config.js';
import { createIdentityClient } from './identityPlatform.js';
import { createSession, type KeyValueStore, type Session } from './session.js';

/** What the signed-in part of the app runs on: one session and the API client that uses it. */
export interface IdentityServices {
  readonly session: Session;
  readonly api: ApiClient;
}

export function createServices(
  config: WebConfig,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  store?: KeyValueStore,
): IdentityServices {
  const session = createSession(createIdentityClient(config.identityApiKey, fetcher), store);
  return { session, api: createApiClient(config.apiUrl, session, fetcher) };
}
