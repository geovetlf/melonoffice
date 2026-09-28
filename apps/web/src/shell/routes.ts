/**
 * The signed-in app's pages (ADR-0040), on the history router of ADR-0036. One place turns a path
 * into a page and a page into a path, so no component writes a path by hand.
 *
 * Level 1 is the Home, the map of the company. Level 2 is a department's office, at
 * `/office/<slug>`, where the slug comes from the department's catalogue type. Level 3 (an agent,
 * `/office/<slug>/agent/<agentId>`) is reserved: it is recognised so links can be built, and
 * shown as not available until it exists.
 */

export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'conversations' }
  | { readonly kind: 'connections' }
  | { readonly kind: 'business_profile' }
  | { readonly kind: 'gia' }
  | { readonly kind: 'office'; readonly slug: string }
  | { readonly kind: 'agent'; readonly slug: string; readonly agentId: string }
  | { readonly kind: 'not_found' };

/** A slug or id as it may appear in a path: lowercase letters, digits and dashes. */
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseRoute(path: string): Route {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (trimmed === '/' || trimmed === '/home') return { kind: 'home' };
  if (trimmed === '/conversations') return { kind: 'conversations' };
  if (trimmed === '/settings/connections') return { kind: 'connections' };
  if (trimmed === '/settings/business') return { kind: 'business_profile' };
  if (trimmed === '/gia') return { kind: 'gia' };
  const parts = trimmed.split('/').slice(1);
  const [first, slug, third, agentId] = parts;
  if (first !== 'office' || slug === undefined || !SEGMENT.test(slug)) return { kind: 'not_found' };
  if (parts.length === 2) return { kind: 'office', slug };
  if (parts.length === 4 && third === 'agent' && agentId !== undefined && ID.test(agentId)) {
    return { kind: 'agent', slug, agentId };
  }
  return { kind: 'not_found' };
}

export const paths = {
  home: () => '/',
  conversations: () => '/conversations',
  connections: () => '/settings/connections',
  business: () => '/settings/business',
  gia: () => '/gia',
  office: (slug: string) => `/office/${encodeURIComponent(slug)}`,
  agent: (slug: string, agentId: string) =>
    `/office/${encodeURIComponent(slug)}/agent/${encodeURIComponent(agentId)}`,
} as const;
