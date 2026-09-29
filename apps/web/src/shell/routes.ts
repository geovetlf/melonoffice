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
  | { readonly kind: 'memory' }
  | { readonly kind: 'gia' }
  | { readonly kind: 'reports' }
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
  // The company's memory (ADR-0056). Its first section is the business profile, which lived at
  // Settings → Business (ADR-0048): that address still opens it.
  if (trimmed === '/memory' || trimmed === '/settings/business') return { kind: 'memory' };
  if (trimmed === '/gia') return { kind: 'gia' };
  // Reports (ADR-0060): what was recorded for each metric.
  if (trimmed === '/reports') return { kind: 'reports' };
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
  /** One conversation open in the Conversations Center (C3). */
  conversation: (id: string) => `/conversations?c=${encodeURIComponent(id)}`,
  /** A contact's card in the Comercial office (C3). */
  customer: (contactId: string) => `/office/sales?contact=${encodeURIComponent(contactId)}`,
  /** An opportunity's card in the Comercial office (C4). */
  opportunity: (id: string) => `/office/sales?opportunity=${encodeURIComponent(id)}`,
  /** The Comercial office's leads or customers tab (C4). */
  contacts: (stage: 'lead' | 'customer') => `/office/sales?stage=${stage}`,
  /** The Comercial office's pipeline (C4). */
  pipeline: () => '/office/sales?view=pipeline',
  /** The Comercial office's pending follow-ups (C5). */
  followUps: () => '/office/sales?view=follow-ups',
  /** One follow-up, marked among Comercial's pending ones (C5). */
  followUp: (id: string) => `/office/sales?view=follow-ups&followUp=${encodeURIComponent(id)}`,
  connections: () => '/settings/connections',
  memory: () => '/memory',
  gia: () => '/gia',
  reports: () => '/reports',
  office: (slug: string) => `/office/${encodeURIComponent(slug)}`,
  agent: (slug: string, agentId: string) =>
    `/office/${encodeURIComponent(slug)}/agent/${encodeURIComponent(agentId)}`,
} as const;

/**
 * An id a page was opened with (`?c=`, `?contact=` (C3); `?opportunity=`, `?stage=`, `?view=`
 * (C4); `?followUp=` (C5)), when it looks like one.
 */
export function openedWith(
  name: 'c' | 'contact' | 'opportunity' | 'stage' | 'view' | 'followUp',
): string | undefined {
  const value = new URLSearchParams(globalThis.location.search).get(name);
  return value !== null && ID.test(value) ? value : undefined;
}
