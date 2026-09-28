import { REFRESH_URL, SIGN_IN_URL } from './identityPlatform.js';
import type { KeyValueStore } from './session.js';

/**
 * A fake Identity Platform and MelonOffice API for tests: one user, `ana@example.com` with
 * password `correct-horse`, a member of one organization. Every call is recorded.
 */

export const API = 'https://api.example.test';
export const KEY = 'test-browser-key-not-a-real-one';

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | undefined;
}

export interface FakeBackend {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
  /** Mutable: how the fake answers. */
  readonly options: {
    /** ID tokens the API accepts. */
    validTokens: Set<string>;
    /** Refresh tokens Identity Platform still honours. */
    validRefresh: Set<string>;
    /** The API's answer to every `/v1/...` call, if forced. */
    apiStatus?: number;
    registered: boolean;
    organizations: { id: string; name: string; role: string }[];
    permissions: string[];
    idTokenSeconds: number;
    /** Each organization's agents (specialist records), by department type. */
    specialists: Record<
      string,
      { id: string; name: string; type: string; status: string; purpose?: string }[]
    >;
    /** Each organization's credit balance, if it has a wallet. */
    credits: Record<string, number>;
    /** Each organization's conversations: only its members can read them. */
    conversations: Record<string, { id: string; name: string; priority: string }[]>;
    organizationLimitReached?: boolean;
  };
  apiCalls(): Call[];
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeBackend(): FakeBackend {
  let issued = 0;
  const calls: Call[] = [];
  const options: FakeBackend['options'] = {
    validTokens: new Set(),
    validRefresh: new Set(),
    registered: true,
    organizations: [{ id: 'org_1', name: 'Acme', role: 'owner' }],
    permissions: [
      'billing.read',
      'contact.read',
      'credits.read',
      'department.read',
      'specialist.read',
      'conversation.manage',
      'conversation.read',
      'conversation.send',
      'organization.read',
    ],
    idTokenSeconds: 3600,
    specialists: { org_1: [] },
    credits: { org_1: 498 },
    conversations: {
      org_1: [{ id: 'c1', name: 'Juan Pérez', priority: 'normal' }],
      org_other: [{ id: 'c9', name: 'Another company’s customer', priority: 'normal' }],
    },
  };

  function issue() {
    issued += 1;
    const idToken = `id-${issued}`;
    const refreshToken = `refresh-${issued}`;
    options.validTokens.add(idToken);
    options.validRefresh.add(refreshToken);
    return { idToken, refreshToken };
  }

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    const method = init.method ?? 'GET';
    calls.push({ url, method, authorization: headers.get('authorization'), body });

    if (url === `${SIGN_IN_URL}?key=${KEY}`) {
      const { email, password } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (email !== 'ana@example.com' || password !== 'correct-horse') {
        return json(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } });
      }
      const { idToken, refreshToken } = issue();
      return json(200, { idToken, refreshToken, expiresIn: String(options.idTokenSeconds) });
    }
    if (url === `${REFRESH_URL}?key=${KEY}`) {
      const held = new URLSearchParams(body).get('refresh_token') ?? '';
      if (!options.validRefresh.has(held)) {
        return json(400, { error: { code: 400, message: 'TOKEN_EXPIRED' } });
      }
      const { idToken, refreshToken } = issue();
      return json(200, {
        id_token: idToken,
        refresh_token: refreshToken,
        expires_in: String(options.idTokenSeconds),
      });
    }
    if (!url.startsWith(`${API}/v1/`)) return json(404, { error: 'not_found' });

    const token = headers.get('authorization')?.replace(/^Bearer /, '');
    if (token === undefined || !options.validTokens.has(token)) {
      return json(401, { error: token === undefined ? 'missing_token' : 'invalid_token' });
    }
    if (options.apiStatus !== undefined) {
      return json(options.apiStatus, {
        error: options.apiStatus === 403 ? 'forbidden' : 'internal',
      });
    }
    const path = url.slice(API.length);
    const me = { userId: 'user_ana', email: 'ana@example.com', emailVerified: true };
    if (path === '/v1/me') {
      if (method === 'POST') options.registered = true;
      if (!options.registered) return json(403, { error: 'user_not_registered' });
      return json(200, me);
    }
    if (path === '/v1/me/organizations') {
      return json(200, {
        organizations: options.organizations.map(({ id, name, role }) => ({
          organization: { id, name, status: 'active' },
          membership: { id: `m_${id}`, role, status: 'active' },
        })),
      });
    }
    if (path === '/v1/organizations' && method === 'POST') {
      const name = ((JSON.parse(body ?? '{}') as { name?: unknown }).name ?? '') as string;
      if (options.organizationLimitReached === true) {
        return json(409, { error: 'organization_limit_reached' });
      }
      if (typeof name !== 'string' || name.trim() === '') {
        return json(400, { error: 'invalid_organization_name' });
      }
      const created = { id: 'org_new', name: name.trim(), role: 'owner' };
      options.organizations.push(created);
      return json(201, { organization: { id: created.id, name: created.name } });
    }
    const inbox = /^\/v1\/organizations\/([^/]+)\/(.+)$/.exec(path);
    if (inbox !== null) return inboxAnswer(inbox[1] ?? '', inbox[2] ?? '', method, body);
    const match = /^\/v1\/organizations\/([^/]+)$/.exec(path);
    const organization = options.organizations.find((o) => o.id === match?.[1]);
    if (organization !== undefined) {
      return json(200, { organization, permissions: options.permissions });
    }
    return json(404, { error: 'organization_not_found' });
  };

  /** The D-11 catalogue, as the departments route answers it for a new organization. */
  const DEPARTMENT_TYPES = [
    'leadership',
    'operations',
    'sales',
    'marketing',
    'design_video',
    'research',
    'finance',
  ];
  const department = (organizationId: string, type: string) => ({
    id: `${organizationId}_${type}`,
    origin: 'catalog',
    typeId: type,
    nameKey: `department.${type}.name`,
    shortNameKey: `department.${type}.short`,
    name: null,
    status: 'active',
    purpose: null,
    description: null,
  });

  /** The inbox routes, as the API answers them: membership first, then the role's permission. */
  function inboxAnswer(organizationId: string, rest: string, method: string, body?: string) {
    if (!options.organizations.some((o) => o.id === organizationId)) {
      return json(403, { error: 'organization_forbidden' });
    }
    const needs = (permission: string) =>
      options.permissions.includes(permission)
        ? undefined
        : json(403, { error: 'permission_denied' });
    const conversations = options.conversations[organizationId] ?? [];
    const view = (c: { id: string; name: string; priority: string }) => ({
      id: c.id,
      contactId: `contact-${c.id}`,
      channel: 'whatsapp',
      status: 'open',
      assigneeId: null,
      departmentId: null,
      priority: c.priority,
      tags: [],
      lastMessage: { direction: 'inbound', preview: 'Hola', at: '2026-09-27T12:00:00Z' },
      lastMessageAt: '2026-09-27T12:00:00Z',
      createdAt: '2026-09-27T11:00:00Z',
      contact: { id: `contact-${c.id}`, displayName: c.name, phone: null },
    });
    const [route, query = ''] = rest.split('?');
    if (route === 'departments') {
      return (
        needs('department.read') ??
        json(200, { departments: DEPARTMENT_TYPES.map((type) => department(organizationId, type)) })
      );
    }
    if (route === 'specialists') {
      return (
        needs('specialist.read') ??
        json(200, {
          specialists: (options.specialists[organizationId] ?? []).map((s) => ({
            id: s.id,
            departmentId: `${organizationId}_${s.type}`,
            displayName: s.name,
            status: s.status,
            purpose: s.purpose ?? null,
            updatedAt: '2026-09-27T12:00:00Z',
          })),
        })
      );
    }
    if (route === 'credits') {
      const balance = options.credits[organizationId];
      return (
        needs('credits.read') ??
        json(
          200,
          balance === undefined
            ? { organizationId, status: 'absent', reason: 'no_wallet' }
            : { organizationId, status: 'present', balance, updatedAt: '2026-09-27T12:00:00Z' },
        )
      );
    }
    if (route === 'billing') {
      return (
        needs('billing.read') ??
        json(200, {
          organizationId,
          status: 'present',
          subscription: { id: 's1', plan: { id: 'entrepreneur', version: 1 }, status: 'active' },
          planInForce: true,
        })
      );
    }
    if (route === 'conversations' && method === 'GET') {
      const q = new URLSearchParams(query).get('q')?.toLowerCase();
      return (
        needs('conversation.read') ??
        json(200, {
          conversations: conversations
            .filter((c) => q === undefined || c.name.toLowerCase().includes(q))
            .map(view),
        })
      );
    }
    const one = /^conversations\/([^/]+)\/(detail|priority|messages)$/.exec(route ?? '');
    const conversation = conversations.find((c) => c.id === one?.[1]);
    if (one === null || conversation === undefined) {
      return json(404, { error: 'conversation_not_found' });
    }
    if (one[2] === 'detail') {
      return (
        needs('conversation.read') ??
        json(200, {
          conversation: view(conversation),
          contact: {
            id: `contact-${conversation.id}`,
            displayName: conversation.name,
            phone: null,
            email: null,
            createdAt: '2026-09-27T11:00:00Z',
          },
          identity: { channel: 'whatsapp', externalId: '5215500000000', displayName: null },
          messages: [],
        })
      );
    }
    if (one[2] === 'priority') {
      const denied = needs('conversation.manage');
      if (denied !== undefined) return denied;
      conversation.priority = (JSON.parse(body ?? '{}') as { priority: string }).priority;
      return json(200, view(conversation));
    }
    return needs('conversation.send') ?? json(200, { message: { id: 'm1', status: 'sent' } });
  }

  return {
    fetch: fetcher,
    calls,
    options,
    apiCalls: () => calls.filter((call) => call.url.startsWith(API)),
  };
}

export function memoryStore(): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}
