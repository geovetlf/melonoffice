/**
 * What the web app needs to know about its environment, read at start-up from `/config.json`
 * (ADR-0036). The server that serves the app writes it from its own configuration, so one build
 * runs in every environment. Neither value is a secret: the API is public, and an Identity
 * Platform browser key only identifies the project (it is restricted to the identity APIs and
 * this site). Anything missing or malformed means sign-in is not configured here.
 */
export interface WebConfig {
  /** The API's origin, e.g. `https://api-….run.app`, with no trailing slash. */
  readonly apiUrl: string;
  /** The Identity Platform browser key, for the sign-in and token refresh endpoints. */
  readonly identityApiKey: string;
}

const API_URL = /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$/;
const API_KEY = /^[A-Za-z0-9_-]{20,100}$/;

export function parseConfig(value: unknown): WebConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { apiUrl, identityApiKey } = value as Record<string, unknown>;
  if (typeof apiUrl !== 'string' || !API_URL.test(apiUrl)) return undefined;
  if (typeof identityApiKey !== 'string' || !API_KEY.test(identityApiKey)) return undefined;
  return Object.freeze({ apiUrl, identityApiKey });
}

export async function loadConfig(fetcher: typeof fetch = fetch): Promise<WebConfig | undefined> {
  try {
    const response = await fetcher('/config.json', { cache: 'no-store' });
    if (!response.ok) return undefined;
    return parseConfig(await response.json());
  } catch {
    return undefined;
  }
}
