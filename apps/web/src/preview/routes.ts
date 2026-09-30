import { API, type FakeBackend } from '../identity/testing.js';

/**
 * API answers the preview adds to the tests' fake backend (`identity/testing.ts`), for the pages
 * whose routes it does not serve (Connections, partners, brand, the partner console, the platform
 * console's accounts and domains, invitation links), or serves too plainly for a screenshot
 * (conversations with their messages). Keyed by `METHOD /v1/path`, without the query; each answer
 * is the body of a 200. Like the fake, it answers only a signed-in caller.
 */
export type PreviewRoutes = Map<string, (body: unknown) => unknown>;

export const previewRoutes = (): PreviewRoutes => new Map();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The fake's `fetch`, answering the preview's own routes first. */
export function previewFetch(backend: FakeBackend, routes: PreviewRoutes): typeof fetch {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(`${API}/v1/`)) {
      const path = url.slice(API.length).split('?')[0] ?? '';
      const answer = routes.get(`${init.method ?? 'GET'} ${path}`);
      if (answer !== undefined) {
        const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
        if (token === undefined || !backend.options.validTokens.has(token)) {
          return json(401, { error: 'invalid_token' });
        }
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        return json(200, answer(body));
      }
    }
    return backend.fetch(input, init);
  };
}
