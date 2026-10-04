import {
  CREATE_AUTH_URI_URL,
  REFRESH_URL,
  SEND_CODE_URL,
  SIGN_IN_URL,
  SIGN_IN_WITH_IDP_URL,
  SIGN_UP_URL,
} from './identityPlatform.js';

/** Google's page the fake sends a Google sign-in to (ADR-0105). */
export const GOOGLE_AUTH_URI = 'https://accounts.google.com/o/oauth2/auth?client_id=fake';
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
    /**
     * Google sign-in (ADR-0105): `off` answers as Identity Platform does with the provider
     * disabled; `linked` as it does for an email that signs in with a password already.
     */
    google?: 'on' | 'off' | 'linked';
    /** Addresses Identity Platform sent a password reset email to (ADR-0105). */
    passwordResets?: string[];
    /** The API's answer to every `/v1/...` call, if forced. */
    apiStatus?: number;
    registered: boolean;
    organizations: { id: string; name: string; role: string }[];
    permissions: string[];
    idTokenSeconds: number;
    /** Each organization's agents (specialist records), by department type. */
    specialists: Record<
      string,
      {
        id: string;
        name: string;
        type: string;
        status: string;
        purpose?: string;
        autonomy?: string;
      }[]
    >;
    /** What the API names as missing when activating an agent (AE-4.2), by agent id. */
    activationProblems?: Record<string, Record<string, string>[]>;
    /** Each organization's credit balance, if it has a wallet. */
    credits: Record<string, number>;
    /** Each organization's plan period (ADR-0127). Absent: not renewed yet. */
    creditPeriods?: Record<
      string,
      { startsAt: string; renewsAt: string; included: number; consumed: number }
    >;
    /** Each organization's conversations: only its members can read them. */
    conversations: Record<string, { id: string; name: string; priority: string }[]>;
    organizationLimitReached?: boolean;
    /** Each organization's business profile (ADR-0048); absent means not described yet. */
    businessProfiles: Record<string, Record<string, unknown>>;
    /** Each organization's activity items (ADR-0049), as the API returns them, for any period. */
    activity: Record<string, Record<string, unknown>[]>;
    /** The activity read fails (for example, before the index exists). */
    activityFails?: boolean;
    /** Each organization's audit trail items (ADR-0147), newest first, as the API returns them. */
    auditTrail: Record<string, Record<string, unknown>[]>;
    /** Items per audit trail page (25 in the API). */
    auditTrailPageSize?: number;
    /** The audit trail read fails with this status and code. */
    auditTrailFails?: { readonly status: number; readonly error: string };
    /** What GIA's chat answers (ADR-0052): the API's body, or an error code with its status. */
    gia:
      | Record<string, unknown>
      | { readonly error: string; readonly status: number; readonly estimatedCredits?: number };
    /** Each organization's customers and leads (C1), as the API's views, newest first. */
    customers: Record<string, Record<string, unknown>[]>;
    /** Notes of each contact, by contact id. */
    customerNotes: Record<string, Record<string, unknown>[]>;
    /** Each organization's stored pipeline (C2); absent: the general proposal is served. */
    pipelines: Record<
      string,
      { revision: number; stored: boolean; stages: Record<string, unknown>[] }
    >;
    /** Each organization's opportunities (C2), as the API's views. */
    opportunities: Record<string, Record<string, unknown>[]>;
    /** A contact card's commercial context (C3): conversations, opportunities and history. */
    contactContext: Record<string, Record<string, unknown>>;
    /** Each organization's Company Brain items (ADR-0051), as the API's views. */
    knowledge: Record<string, Record<string, unknown>[]>;
    /** What `POST brain/capture` answers: GIA's extraction status (default `extracted`). */
    captureExtraction?: 'extracted' | 'unavailable' | 'failed';
    /** How many facts `POST brain/sync` changed. */
    syncChanged?: number;
    /** Each organization's open Company Brain conflicts. */
    knowledgeConflicts: Record<string, Record<string, unknown>[]>;
    /** Company Brain's onboarding questions still unanswered. */
    knowledgeQuestions: Record<string, Record<string, unknown>[]>;
    /** Each organization's follow-ups (C5), as the API's views. */
    followUps: Record<string, Record<string, unknown>[]>;
    /** Each agent's tasks (ADR-0063), newest first, as the API's views. */
    agentTasks: Record<string, Record<string, unknown>[]>;
    /**
     * Each organization's workflows (WF-3), as the API lists them. A `steps` field is the current
     * version's steps for `GET workflows/:id`; writes keep what was sent there.
     */
    workflows: Record<string, Record<string, unknown>[]>;
    /**
     * Each organization's plans (WF-3), as the API shows one (with `current`), and each plan's
     * steps as `GET plans/:id/steps` reads them.
     */
    plans: Record<string, Record<string, unknown>[]>;
    planSteps: Record<string, Record<string, unknown>[]>;
    /** Planning a workflow is refused with this reason (422), instead of making a plan. */
    planRefusal?: string;
    /** Records per page of Comercial's lists (ADR-0061), unless the request asks a `limit`. */
    pageSize: number;
    /** Every page after the first fails (ADR-0061). */
    nextPagesFail?: boolean;
    /** Scheduling a follow-up fails with this code and status (C5). */
    followUpFails?: { readonly error: string; readonly status: number };
    /**
     * Reports (ADR-0060): each organization's metrics as the API lists them, and each read by
     * `metric:frequency`, as the API's body or an error with its status.
     */
    /** Approvals (ADR-0026): each organization's, as the API lists them. */
    approvals: Record<string, Record<string, unknown>[]>;
    /** Deciding an approval fails with this code and status. */
    approvalDecisionFails?: { readonly error: string; readonly status: number };
    /** AI usage (ADR-0074): each organization's summary and events, as the API gives them. */
    aiUsage: Record<
      string,
      { summary: Record<string, unknown>; events: Record<string, unknown>[] } | { status: number }
    >;
    /** Documents (DOC-3): each organization's files as the API lists them. */
    documents: Record<string, Record<string, unknown>[]>;
    /**
     * The platform AI view (ADR-0082) as the API gives it to a platform administrator. Absent:
     * the person is not one, and every platform route but access answers 403.
     */
    platform?: {
      ai: Record<string, unknown>;
      usage: Record<string, unknown>;
      /** The AI view answers 500. */
      aiFails?: boolean;
    };
    /** Uploading a document fails with this code and status. */
    documentUploadFails?: { readonly error: string; readonly status: number };
    /** The partner or agency accounts the person belongs to (ADR-0090), as the API lists them. */
    commercialAccounts: Record<string, unknown>[];
    /**
     * "Project this" (ADR-0139): the Forecasting Engine's answer to a projection, by
     * `metric:frequency`, as the API's body or an error with its status. Absent: 404.
     */
    forecasts?: Record<
      string,
      Record<string, unknown> | { readonly error: string; readonly status: number }
    >;
    metrics: Record<
      string,
      {
        list: Record<string, unknown>[];
        histories: Record<
          string,
          | Record<string, unknown>
          | { readonly error: string; readonly field?: string; readonly status: number }
        >;
      }
    >;
  };
  apiCalls(): Call[];
  /** Files uploaded to Documents (DOC-3), with the type and name they were sent with. */
  readonly uploads: { readonly contentType: string | null; readonly name: string | null }[];
  /** Executions (plans, agent tasks) a person asked to stop, by id. */
  readonly cancelled: string[];
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
      'activity.read',
      'billing.read',
      'contact.read',
      'credits.read',
      'department.read',
      'gia.ask',
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
    businessProfiles: {},
    activity: {},
    auditTrail: {},
    gia: {
      answer: 'Hoy no hubo actividad en tu oficina.',
      department: null,
      screen: null,
      proposedAction: null,
      proposedFacts: 0,
      context: { facts: 1, activity: true, missing: [] },
      replayed: false,
      generatedBy: 'ai',
    },
    customers: {},
    customerNotes: {},
    pipelines: {},
    opportunities: {},
    contactContext: {},
    knowledge: {},
    knowledgeConflicts: {},
    knowledgeQuestions: {},
    followUps: {},
    agentTasks: {},
    workflows: {},
    plans: {},
    planSteps: {},
    pageSize: 50,
    approvals: {},
    aiUsage: {},
    documents: {},
    metrics: {},
    commercialAccounts: [],
  };
  const uploads: FakeBackend['uploads'] = [];
  const cancelled: string[] = [];

  function issue() {
    issued += 1;
    const idToken = `id-${issued}`;
    const refreshToken = `refresh-${issued}`;
    options.validTokens.add(idToken);
    options.validRefresh.add(refreshToken);
    return { idToken, refreshToken };
  }

  let currentContentType: string | null = null;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    const method = init.method ?? 'GET';
    currentContentType = headers.get('content-type');
    calls.push({ url, method, authorization: headers.get('authorization'), body });

    if (url === `${SIGN_IN_URL}?key=${KEY}`) {
      const { email, password } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (email !== 'ana@example.com' || password !== 'correct-horse') {
        return json(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } });
      }
      const { idToken, refreshToken } = issue();
      return json(200, { idToken, refreshToken, expiresIn: String(options.idTokenSeconds) });
    }
    if (url === `${SIGN_UP_URL}?key=${KEY}`) {
      const { email, password } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (email === 'ana@example.com') {
        return json(400, { error: { code: 400, message: 'EMAIL_EXISTS' } });
      }
      if ((password ?? '').length < 6) {
        return json(400, { error: { code: 400, message: 'WEAK_PASSWORD : too short' } });
      }
      const { idToken, refreshToken } = issue();
      return json(200, { idToken, refreshToken, expiresIn: String(options.idTokenSeconds) });
    }
    if (url === `${SEND_CODE_URL}?key=${KEY}`) {
      const { requestType, email } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (requestType === 'PASSWORD_RESET') {
        // Like Identity Platform with email enumeration protection: every address is accepted.
        (options.passwordResets ??= []).push(email ?? '');
      }
      return json(200, { email });
    }
    if (url === `${CREATE_AUTH_URI_URL}?key=${KEY}`) {
      const { providerId } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (options.google === 'off' || providerId !== 'google.com') {
        return json(400, { error: { code: 400, message: 'OPERATION_NOT_ALLOWED' } });
      }
      return json(200, { authUri: GOOGLE_AUTH_URI, sessionId: 'google-session' });
    }
    if (url === `${SIGN_IN_WITH_IDP_URL}?key=${KEY}`) {
      const { sessionId, requestUri } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (sessionId !== 'google-session' || !/[?#&](code|id_token)=/.test(requestUri ?? '')) {
        return json(400, { error: { code: 400, message: 'INVALID_IDP_RESPONSE' } });
      }
      if (options.google === 'linked') return json(200, { needConfirmation: true });
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
    if (path === '/v1/commercial/accounts') {
      return json(200, { accounts: options.commercialAccounts });
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
    const platformPath = path.split('?')[0];
    if (platformPath === '/v1/platform/access') {
      return json(200, { platformAdmin: options.platform !== undefined });
    }
    if (platformPath === '/v1/platform/ai' || platformPath === '/v1/platform/ai-usage') {
      if (options.platform === undefined) return json(403, { error: 'platform_forbidden' });
      if (platformPath === '/v1/platform/ai') {
        return options.platform.aiFails === true
          ? json(500, { error: 'internal' })
          : json(200, options.platform.ai);
      }
      const params = new URLSearchParams(path.split('?')[1] ?? '');
      return json(200, {
        ...options.platform.usage,
        from: params.get('from'),
        to: params.get('to'),
      });
    }
    if (path === '/v1/business-types') {
      return json(200, {
        businessTypes: ['restaurant', 'store', 'ecommerce', 'other'].map((id) => ({
          id,
          nameKey: `business.type.${id}`,
        })),
      });
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

  /** The catalogue (ADR-0047), as the departments route answers it for a new organization. */
  const DEPARTMENT_TYPES = [
    'leadership',
    'operations',
    'sales',
    'marketing',
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

  /**
   * One page of a list as the API cuts it (ADR-0061): `?cursor=` is where the previous page
   * stopped (here, a plain offset), `?limit=` its size.
   */
  function pageOf<T>(items: readonly T[], query: string) {
    const q = new URLSearchParams(query);
    const start = Number(q.get('cursor')?.replace('page:', '') ?? 0);
    const size = Number(q.get('limit') ?? options.pageSize);
    const hasMore = items.length > start + size;
    return {
      items: items.slice(start, start + size),
      hasMore,
      nextCursor: hasMore ? `page:${start + size}` : null,
    };
  }

  /** The customers routes (C1), as the API answers them: duplicates, revisions and notes. */
  function customersAnswer(
    organizationId: string,
    route: string,
    query: string,
    method: string,
    body: string | undefined,
    needs: (permission: string) => Response | undefined,
  ) {
    const all = (options.customers[organizationId] ??= []);
    const counts = { lead: 0, customer: 0, inactive: 0 } as Record<string, number>;
    const stageOf = (c: Record<string, unknown>) =>
      (c.commercial as { stage: string } | null)?.stage;
    for (const c of all) {
      const stage = stageOf(c);
      if (stage !== undefined) counts[stage] = (counts[stage] ?? 0) + 1;
    }
    const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
    const [, id, notes] = route.split('/');
    if (id === undefined) {
      if (method === 'POST') {
        const denied = needs('contact.manage');
        if (denied !== undefined) return denied;
        const phone = typeof input.phone === 'string' ? input.phone.replace(/[\s-]/g, '') : null;
        const existing = all.find((c) => phone !== null && c.phone === phone);
        if (existing !== undefined) {
          return json(409, { error: 'duplicate_contact', contactId: existing.id });
        }
        const created = {
          id: `contact_${all.length + 1}`,
          displayName: input.displayName,
          phone,
          email: input.email ?? null,
          origin: 'user',
          revision: 1,
          commercial: {
            stage: 'lead',
            owner: null,
            source: 'manual',
            consent: 'unknown',
            consentAt: null,
            nextAction: null,
            stageChangedAt: '2026-09-28T12:00:00Z',
          },
          createdAt: '2026-09-28T12:00:00Z',
          updatedAt: '2026-09-28T12:00:00Z',
        };
        all.unshift(created);
        return json(200, created);
      }
      const stage = new URLSearchParams(query).get('stage');
      return (
        needs('contact.read') ??
        json(200, {
          ...pageOf(
            all.filter((c) => stage === null || stageOf(c) === stage),
            query,
          ),
          counts,
        })
      );
    }
    const contact = all.find((c) => c.id === id);
    if (contact === undefined) return json(404, { error: 'contact_not_found' });
    const kept = (options.customerNotes[id] ??= []);
    if (notes === 'notes' && method === 'POST') {
      const denied = needs('contact.manage');
      if (denied !== undefined) return denied;
      const note = {
        id: `note_${kept.length + 1}`,
        text: input.text,
        author: 'you',
        createdAt: '2026-09-28T12:00:00Z',
      };
      kept.unshift(note);
      return json(200, note);
    }
    if (method === 'PATCH') {
      const denied = needs('contact.manage');
      if (denied !== undefined) return denied;
      if (input.revision !== contact.revision) {
        return json(409, { error: 'contact_concurrency_conflict' });
      }
      const commercial = { ...(contact.commercial as Record<string, unknown>) };
      if (typeof input.stage === 'string') commercial.stage = input.stage;
      if ('ownerId' in input) commercial.owner = input.ownerId === null ? null : 'you';
      if ('nextAction' in input) commercial.nextAction = input.nextAction;
      if (typeof input.consent === 'object' && input.consent !== null) {
        commercial.consent = (input.consent as { messaging: string }).messaging;
      }
      Object.assign(contact, { commercial, revision: (contact.revision as number) + 1 });
      return json(200, contact);
    }
    return (
      needs('contact.read') ??
      json(200, { ...contact, notes: kept, ...(options.contactContext[id] ?? {}) })
    );
  }

  /** Company Brain's routes (ADR-0051), as the company memory (ADR-0056) calls them. */
  function brainAnswer(
    organizationId: string,
    route: string,
    query: string,
    method: string,
    body: string | undefined,
    needs: (permission: string) => Response | undefined,
  ) {
    const all = (options.knowledge[organizationId] ??= []);
    const conflicts = (options.knowledgeConflicts[organizationId] ??= []);
    const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
    const active = all.filter((i) => i.status === 'active');
    if (route === 'brain') {
      const byDomain: Record<string, number> = {};
      for (const i of active)
        byDomain[i.domain as string] = (byDomain[i.domain as string] ?? 0) + 1;
      return (
        needs('knowledge.read') ??
        json(200, {
          initialized: active.length > 0,
          items: active.length,
          byDomain,
          gaps: {
            questions: options.knowledgeQuestions[organizationId] ?? [],
            toConfirm: active.filter((i) => i.needsConfirmation === true),
            openConflicts: conflicts.length,
          },
        })
      );
    }
    if (route === 'brain/conflicts') return needs('knowledge.read') ?? json(200, { conflicts });
    const resolve = /^brain\/conflicts\/([^/]+)\/resolve$/.exec(route);
    if (resolve !== null) {
      const denied = needs('knowledge.manage');
      if (denied !== undefined) return denied;
      options.knowledgeConflicts[organizationId] = conflicts.filter((c) => c.id !== resolve[1]);
      return json(200, { outcome: 'conflict_resolved', itemId: 'x' });
    }
    if (route === 'brain/capture' && method === 'POST') {
      const denied = needs('knowledge.capture') ?? needs('knowledge.propose');
      if (denied !== undefined) return denied;
      const extraction = options.captureExtraction ?? 'extracted';
      if (extraction !== 'extracted') return json(200, { outcomes: [], rejected: 0, extraction });
      const id = `${organizationId}_operations_opening_hours`;
      all.push({
        id,
        domain: 'operations',
        key: 'opening_hours',
        subject: null,
        label: null,
        value: { type: 'text', text: String(input.text) },
        verification: 'proposed',
        status: 'active',
        sensitivity: 'internal',
        critical: false,
        needsConfirmation: true,
        source: {
          type: 'gia',
          id: 'capture',
          reference: null,
          recordedBy: 'gia',
          confidence: null,
        },
        effectiveFrom: '2026-09-28T12:00:00Z',
        effectiveUntil: null,
        revision: 1,
        updatedAt: '2026-09-28T12:00:00Z',
        openConflictId: null,
      });
      return json(200, {
        outcomes: [{ outcome: 'created', itemId: id, revision: 1 }],
        rejected: 0,
        extraction,
      });
    }
    if (route === 'brain/sync' && method === 'POST') {
      return needs('knowledge.propose') ?? json(200, { changed: options.syncChanged ?? 0 });
    }
    if (route === 'brain/documents') {
      return (
        needs('knowledge.propose') ??
        json(200, { document: { id: 'd1' }, extraction: 'extracted', outcomes: [], rejected: 0 })
      );
    }
    if (route === 'brain/knowledge' && method === 'GET') {
      const q = new URLSearchParams(query);
      const domain = q.get('domain');
      const items = (q.get('inactive') === '1' ? all : active).filter(
        (i) => domain === null || i.domain === domain,
      );
      return needs('knowledge.read') ?? json(200, { items });
    }
    if (route === 'brain/knowledge' && method === 'POST') {
      const denied = needs('knowledge.propose');
      if (denied !== undefined) return denied;
      const id = `${organizationId}_${String(input.domain)}_${String(input.key)}`;
      const existing = all.find((i) => i.id === id);
      const item = {
        id,
        domain: input.domain,
        key: input.key,
        subject: null,
        label: input.label ?? existing?.label ?? null,
        value: input.value,
        verification: 'confirmed',
        status: 'active',
        sensitivity: 'internal',
        critical: false,
        needsConfirmation: false,
        source: { type: 'user', id: null, reference: null, recordedBy: 'you', confidence: null },
        effectiveFrom: '2026-09-28T12:00:00Z',
        effectiveUntil: null,
        revision: ((existing?.revision as number | undefined) ?? 0) + 1,
        updatedAt: '2026-09-28T12:00:00Z',
        openConflictId: null,
      };
      if (existing === undefined) all.push(item);
      else Object.assign(existing, item);
      return json(200, {
        outcome: existing === undefined ? 'created' : 'updated',
        itemId: id,
        revision: item.revision,
      });
    }
    const one = /^brain\/knowledge\/([^/]+)(?:\/(confirm|invalidate|archive))?$/.exec(route);
    const item = all.find((i) => i.id === one?.[1]);
    if (one === null || item === undefined) return json(404, { error: 'not_found' });
    if (one[2] === undefined) {
      return (
        needs('knowledge.read') ??
        json(200, {
          item,
          versions: [
            {
              revision: item.revision,
              operation: 'created',
              value: item.value,
              verification: item.verification,
              status: item.status,
              source: 'user',
              changedAt: '2026-09-28T12:00:00Z',
              changedBy: 'you',
              reason: null,
            },
          ],
        })
      );
    }
    const denied = needs('knowledge.manage');
    if (denied !== undefined) return denied;
    if (input.revision !== item.revision) return json(409, { error: 'stale_revision' });
    Object.assign(item, {
      revision: (item.revision as number) + 1,
      ...(one[2] === 'confirm'
        ? { verification: 'confirmed', needsConfirmation: false }
        : { status: one[2] === 'archive' ? 'archived' : 'outdated' }),
    });
    return json(200, { outcome: one[2], itemId: item.id, revision: item.revision });
  }

  /** The opportunity and pipeline routes (C2), as the API answers them. */
  function opportunitiesAnswer(
    organizationId: string,
    route: string,
    query: string,
    method: string,
    body: string | undefined,
    needs: (permission: string) => Response | undefined,
  ) {
    const stage = (id: string, probability: number, kind = 'open') => ({
      id,
      kind,
      name: null,
      nameKey: `pipeline.stage.${id}`,
      probability,
    });
    const pipeline = (options.pipelines[organizationId] ??= {
      revision: 0,
      stored: false,
      stages: [
        stage('new', 10),
        stage('contacted', 25),
        stage('proposal', 50),
        stage('negotiation', 75),
        stage('won', 100, 'won'),
        stage('lost', 0, 'lost'),
      ],
    });
    const view = () => ({ id: `${organizationId}_default`, template: 'general', ...pipeline });
    const all = (options.opportunities[organizationId] ??= []);
    const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
    if (route === 'pipeline') {
      if (method === 'PUT') {
        const denied = needs('pipeline.manage');
        if (denied !== undefined) return denied;
        if (input.revision !== pipeline.revision) {
          return json(409, { error: 'pipeline_concurrency_conflict' });
        }
        const known = new Map(pipeline.stages.map((s) => [s.id as string, s]));
        let fresh = 0;
        pipeline.stages = (input.stages as Record<string, unknown>[]).map((s) => {
          const old = s.id === undefined ? undefined : known.get(s.id as string);
          return {
            ...(old ?? {
              id: `stage_${'abcdefgh'.slice(0, ++fresh)}`,
              kind: 'open',
              nameKey: null,
            }),
            ...(s.name === undefined ? {} : { name: s.name, nameKey: null }),
            ...(s.probability === undefined ? {} : { probability: s.probability }),
          };
        });
        pipeline.revision += 1;
        pipeline.stored = true;
        return json(200, view());
      }
      return needs('opportunity.read') ?? json(200, view());
    }
    const summary = () => {
      const stages: Record<string, { count: number; valueMinor: number }> = {};
      const open = { count: 0, valueMinor: 0 };
      let won = 0;
      let lost = 0;
      for (const o of all) {
        const amount = (o.value as { amountMinor: number } | null)?.amountMinor ?? 0;
        const at = (stages[o.stageId as string] ??= { count: 0, valueMinor: 0 });
        at.count += 1;
        at.valueMinor += amount;
        if (o.status === 'open') {
          open.count += 1;
          open.valueMinor += amount;
        } else if (o.status === 'won') won += 1;
        else lost += 1;
      }
      return { currency: 'PEN', stages, open, won, lost };
    };
    const [, id] = route.split('/');
    if (id === undefined) {
      if (method === 'POST') {
        const denied = needs('opportunity.manage');
        if (denied !== undefined) return denied;
        const at =
          pipeline.stages.find((s) => s.id === (input.stageId ?? 'new')) ?? pipeline.stages[0];
        const created = {
          id: `opp_${all.length + 1}`,
          contactId: input.contactId,
          contactName: 'Rosa',
          stageId: at?.id,
          status: 'open',
          title: input.title,
          value: input.value === undefined ? null : { ...(input.value as object), currency: 'PEN' },
          probability: at?.probability,
          owner: null,
          expectedCloseOn: input.expectedCloseOn ?? null,
          nextAction: null,
          lostReason: null,
          closedAt: null,
          revision: 1,
          updatedAt: '2026-09-28T12:00:00Z',
        };
        all.unshift(created);
        pipeline.stored = true;
        pipeline.revision = Math.max(pipeline.revision, 1);
        return json(200, created);
      }
      const status = new URLSearchParams(query).get('status');
      return (
        needs('opportunity.read') ??
        json(200, {
          ...pageOf(
            all.filter((o) => status === null || o.status === status),
            query,
          ),
          summary: summary(),
        })
      );
    }
    const found = all.find((o) => o.id === id);
    if (found === undefined) return json(404, { error: 'opportunity_not_found' });
    if (method === 'PATCH') {
      const denied = needs('opportunity.manage');
      if (denied !== undefined) return denied;
      if (input.revision !== found.revision) {
        return json(409, { error: 'opportunity_concurrency_conflict' });
      }
      if (typeof input.stageId === 'string') {
        const to = pipeline.stages.find((s) => s.id === input.stageId);
        if (to?.kind === 'lost' && input.lostReason === undefined) {
          return json(400, { error: 'invalid_request', field: 'lostReason' });
        }
        Object.assign(found, {
          stageId: input.stageId,
          status: to?.kind === 'open' ? 'open' : to?.kind,
          probability: to?.probability,
          lostReason: input.lostReason ?? null,
        });
      }
      if ('ownerId' in input) found.owner = input.ownerId === null ? null : 'you';
      if (input.value !== undefined) {
        found.value = input.value === null ? null : { ...(input.value as object), currency: 'PEN' };
      }
      if (typeof input.probability === 'number') found.probability = input.probability;
      if ('nextAction' in input) found.nextAction = input.nextAction;
      if ('expectedCloseOn' in input) found.expectedCloseOn = input.expectedCloseOn;
      found.revision = (found.revision as number) + 1;
      return json(200, found);
    }
    return (
      needs('opportunity.read') ??
      json(200, {
        ...found,
        contact: { id: found.contactId, displayName: found.contactName, stage: 'lead' },
        conversations: options.permissions.includes('conversation.read') ? [] : null,
        history: [
          {
            id: 'h1',
            at: '2026-09-28T12:00:00Z',
            action: 'opportunity.created',
            transition: { from: 'none', to: 'new' },
            reason: null,
            actor: 'you',
          },
        ],
      })
    );
  }

  /** Follow-ups (C5): list, schedule, complete, cancel and reschedule, as the API answers. */
  function followUpsAnswer(
    organizationId: string,
    route: string,
    query: string,
    method: string,
    body: string | undefined,
    needs: (permission: string) => Response | undefined,
  ) {
    const all = (options.followUps[organizationId] ??= []);
    const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
    if (route === 'follow-ups' && method === 'GET') {
      const q = new URLSearchParams(query);
      const items = all.filter(
        (f) =>
          (q.get('open') !== 'true' ||
            ['scheduled', 'due', 'failed'].includes(f.status as string)) &&
          (q.get('contact') === null || f.contactId === q.get('contact')) &&
          (q.get('opportunity') === null || f.opportunityId === q.get('opportunity')) &&
          (q.get('assignee') !== 'me' || f.assignee === 'you'),
      );
      const count = (when: string) => items.filter((f) => f.when === when).length;
      return (
        needs('follow_up.read') ??
        json(200, {
          timeZone: 'America/Lima',
          today: '2026-09-28',
          counts: {
            overdue: count('overdue'),
            today: count('today'),
            upcoming: count('upcoming'),
            open: items.length,
          },
          ...pageOf(items, query),
        })
      );
    }
    const denied = needs('follow_up.manage');
    if (denied !== undefined) return denied;
    if (route === 'follow-ups' && method === 'POST') {
      if (options.followUpFails !== undefined) {
        return json(options.followUpFails.status, { error: options.followUpFails.error });
      }
      const created = {
        id: `fu_${all.length + 1}`,
        contactId: input.contactId,
        contactName: null,
        opportunityId: input.opportunityId ?? null,
        assignee: 'you',
        type: input.type,
        title: input.title,
        description: null,
        scheduledAt: `${input.date as string}T15:00:00.000Z`,
        timeZone: 'America/Lima',
        date: input.date,
        time: input.time,
        when: 'upcoming',
        days: 1,
        status: 'scheduled',
        source: input.source ?? 'manual',
        cancelReason: null,
        failure: null,
        revision: 1,
      };
      all.push(created);
      return json(201, { ...created, created: true });
    }
    const [, id, action] = route.split('/');
    const found = all.find((f) => f.id === id);
    if (found === undefined) return json(404, { error: 'follow_up_not_found' });
    if (action === 'complete') found.status = 'completed';
    if (action === 'cancel') found.status = 'cancelled';
    if (action === 'reschedule') {
      found.date = input.date;
      found.time = input.time;
      found.status = 'scheduled';
    }
    found.revision = (found.revision as number) + 1;
    return json(200, found);
  }

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
    if (options.nextPagesFail === true && new URLSearchParams(query).has('cursor')) {
      return json(500, { error: 'internal' });
    }
    if (route === 'departments') {
      return (
        needs('department.read') ??
        json(200, { departments: DEPARTMENT_TYPES.map((type) => department(organizationId, type)) })
      );
    }
    const agentTask = route?.match(/^specialists\/([^/]+)\/tasks$/);
    if (agentTask?.[1] !== undefined) {
      const tasks = (options.agentTasks[agentTask[1]] ??= []);
      if (method === 'POST') {
        const denied = needs('specialist.task');
        if (denied !== undefined) return denied;
        const input = JSON.parse(body ?? '{}') as { request?: string; idempotencyKey?: string };
        const existing = tasks.find((t) => t.key === input.idempotencyKey);
        if (existing !== undefined) return json(202, existing);
        const task = {
          id: `task-${tasks.length + 1}`,
          key: input.idempotencyKey,
          specialistId: agentTask[1],
          request: input.request,
          createdAt: '2026-09-29T12:00:00Z',
          status: 'running',
          failure: null,
          completedAt: null,
          answer: null,
        };
        tasks.unshift(task);
        return json(202, task);
      }
      return needs('specialist.read') ?? json(200, { tasks, nextCursor: null });
    }
    // Stopping a plan or an agent task (ADR-0029): both are executions, by the same id.
    const cancel = route?.match(/^executions\/([^/]+)\/cancel$/);
    if (cancel?.[1] !== undefined && method === 'POST') {
      const denied = needs('execution.cancel');
      if (denied !== undefined) return denied;
      const { reason } = JSON.parse(body ?? '{}') as { reason?: string };
      if (reason !== 'director_request') return json(400, { error: 'invalid_request' });
      cancelled.push(cancel[1]);
      const target = [
        ...(options.plans[organizationId] ?? []),
        ...Object.values(options.agentTasks).flat(),
      ].find((x) => x.id === cancel[1]);
      if (target === undefined) return json(404, { error: 'execution_not_found' });
      if (['completed', 'failed', 'cancelled', 'rejected'].includes(target.status as string)) {
        return json(409, { error: 'execution_already_terminal' });
      }
      target.status = 'cancelled';
      return json(200, { id: cancel[1], status: 'cancelled' });
    }
    const oneTask = route?.match(/^agent-tasks\/([^/]+)$/);
    if (oneTask?.[1] !== undefined) {
      const found = Object.values(options.agentTasks)
        .flat()
        .find((t) => t.id === oneTask[1]);
      return (
        needs('specialist.read') ??
        (found === undefined ? json(404, { error: 'task_not_found' }) : json(200, found))
      );
    }
    if (route === 'decisions/actions') {
      return (
        needs('gia.ask') ??
        json(200, {
          actions: ['follow_up.schedule', 'opportunity.offer_discount'].map((action) => ({
            action,
            outcome: 'available',
          })),
        })
      );
    }
    if (route === 'workflows' && method === 'POST') {
      const denied = needs('workflow.manage');
      if (denied !== undefined) return denied;
      const input = JSON.parse(body ?? '{}') as { name?: string; steps?: unknown[] };
      if (typeof input.name !== 'string' || input.name.trim() === '') {
        return json(400, { error: 'invalid_workflow', detail: 'name' });
      }
      const list = (options.workflows[organizationId] ??= []);
      const created = {
        id: `wf-${list.length + 1}`,
        name: input.name,
        status: 'draft',
        version: 1,
        createdAt: '2026-09-29T12:00:00Z',
        createdBy: 'user-1',
        updatedAt: '2026-09-29T12:00:00Z',
        steps: input.steps,
      };
      list.push(created);
      return json(201, created);
    }
    if (route === 'workflows') {
      return (
        needs('workflow.read') ?? json(200, { workflows: options.workflows[organizationId] ?? [] })
      );
    }
    const oneWorkflow = route?.match(/^workflows\/([^/]+)(?:\/(versions|status))?$/);
    if (oneWorkflow?.[1] !== undefined) {
      const workflow = (options.workflows[organizationId] ?? []).find(
        (w) => w.id === oneWorkflow[1],
      );
      const action = oneWorkflow[2];
      if (action === undefined && method === 'GET') {
        const denied = needs('workflow.read');
        if (denied !== undefined) return denied;
        if (workflow === undefined) return json(404, { error: 'workflow_not_found' });
        const steps = (workflow.steps as Record<string, unknown>[] | undefined) ?? [
          {
            id: 'research',
            kind: 'specialist',
            label: 'Research',
            dependsOn: [],
            assignee: { departmentTypeId: 'research', roleId: 'research_agent' },
          },
        ];
        return json(200, {
          ...workflow,
          current: {
            version: workflow.version,
            name: workflow.name,
            steps: steps.map((s) => ({
              performedBy: null,
              tool: null,
              ...s,
              assignee: s.assignee ?? null,
              approvalRequired: s.approvalRequired ?? false,
            })),
          },
        });
      }
      if (action !== undefined && method === 'POST') {
        const denied = needs('workflow.manage');
        if (denied !== undefined) return denied;
        if (workflow === undefined) return json(404, { error: 'workflow_not_found' });
        const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
        if (action === 'status') {
          if (input.from !== workflow.status) {
            return json(409, { error: 'workflow_concurrency_conflict' });
          }
          workflow.status = input.to;
        } else {
          workflow.version = (workflow.version as number) + 1;
          if (typeof input.name === 'string') workflow.name = input.name;
          workflow.steps = input.steps;
        }
        return json(action === 'status' ? 200 : 201, workflow);
      }
    }
    const planWorkflow = route?.match(/^workflows\/([^/]+)\/plans$/);
    if (planWorkflow?.[1] !== undefined && method === 'POST') {
      const denied = needs('plan.create');
      if (denied !== undefined) return denied;
      const workflow = (options.workflows[organizationId] ?? []).find(
        (w) => w.id === planWorkflow[1],
      );
      if (workflow === undefined) return json(404, { error: 'workflow_not_found' });
      if (workflow.status !== 'active') return json(409, { error: 'workflow_not_active' });
      if (options.planRefusal !== undefined) {
        return json(422, { error: 'plan_refused', stage: 'plan', reason: options.planRefusal });
      }
      const input = JSON.parse(body ?? '{}') as { requestKey?: string };
      const plans = (options.plans[organizationId] ??= []);
      const existing = plans.find((p) => p.key === input.requestKey);
      if (existing !== undefined) return json(201, existing);
      const plan = {
        id: `plan-${plans.length + 1}`,
        key: input.requestKey,
        status: 'approval_required',
        version: 1,
        createdAt: '2026-09-29T12:00:00Z',
        current: {
          version: 1,
          digest: 'a'.repeat(64),
          request: { summary: workflow.name, objective: workflow.name },
          steps: [{ id: 'research', kind: 'specialist', label: 'Research', dependsOn: [] }],
          riskLevel: 'low',
          source: { kind: 'workflow', workflowId: workflow.id, workflowVersion: workflow.version },
        },
      };
      plans.push(plan);
      return json(201, plan);
    }
    if (route === 'plans') {
      return needs('plan.read') ?? json(200, { plans: options.plans[organizationId] ?? [] });
    }
    const onePlan = route?.match(/^plans\/([^/]+)(?:\/(steps|approve|reject))?$/);
    if (onePlan?.[1] !== undefined) {
      const plan = (options.plans[organizationId] ?? []).find((p) => p.id === onePlan[1]);
      const action = onePlan[2];
      if (action === 'approve' || action === 'reject') {
        const denied = needs('approval.approve');
        if (denied !== undefined) return denied;
        if (plan === undefined) return json(404, { error: 'plan_not_found' });
        if (plan.status !== 'approval_required') {
          return json(409, { error: 'invalid_plan_transition' });
        }
        plan.status = action === 'approve' ? 'executing' : 'rejected';
        return json(200, plan);
      }
      const denied = needs('plan.read');
      if (denied !== undefined) return denied;
      if (plan === undefined) return json(404, { error: 'plan_not_found' });
      if (action === 'steps') {
        return json(200, {
          planId: plan.id,
          status: plan.status,
          steps: options.planSteps[plan.id as string] ?? [],
        });
      }
      return json(200, plan);
    }
    if (route === 'agents/catalogue') {
      return (
        needs('specialist.read') ??
        json(200, {
          templates: [
            {
              id: 'commercial',
              departmentTypeId: 'sales',
              nameKey: 'agents.template.commercial.name',
              role: { id: 'commercial_agent', version: 1 },
              purpose: { es: 'Atiende clientes.', en: 'Serves customers.' },
              skills: [{ id: 'conversation_reply', version: 1 }],
            },
          ],
          skills: [
            {
              id: 'conversation_reply',
              version: 1,
              nameKey: 'agents.skill.conversation_reply.name',
              descriptionKey: 'agents.skill.conversation_reply.description',
              tools: [
                { id: 'message_send', versions: [2, 3] },
                { id: 'conversation_handoff', versions: [1] },
              ],
              actions: [],
              reads: ['conversation.read'],
            },
            {
              id: 'company_knowledge',
              version: 1,
              nameKey: 'agents.skill.company_knowledge.name',
              descriptionKey: 'agents.skill.company_knowledge.description',
              tools: [],
              actions: [],
              reads: ['knowledge.read'],
            },
          ],
        })
      );
    }
    if (route === 'tools') {
      const version = (n: number, approvalPolicy: string) => ({
        version: n,
        nameKey: 'tools.message_send.name',
        descriptionKey: 'tools.message_send.description',
        category: 'communication',
        action: 'send',
        mutating: true,
        riskLevel: 'medium',
        approvalPolicy,
        environments: ['dev'],
      });
      return (
        needs('tool.read') ??
        json(200, {
          tools: [
            {
              id: 'message_send',
              status: 'active',
              versions: [version(1, 'auto'), version(2, 'approval_required')],
            },
          ],
        })
      );
    }
    if (route === 'specialists' && method === 'POST') {
      const denied = needs('specialist.manage');
      if (denied !== undefined) return denied;
      const input = JSON.parse(body ?? '{}') as { templateId?: string; displayName?: string };
      if (typeof input.displayName !== 'string' || input.displayName.trim() === '') {
        return json(400, { error: 'invalid_specialist' });
      }
      const list = (options.specialists[organizationId] ??= []);
      const created = {
        id: `spec_new_${list.length + 1}`,
        name: input.displayName,
        type: 'sales',
        status: 'draft',
      };
      list.push(created);
      return json(201, {
        id: created.id,
        departmentId: `${organizationId}_sales`,
        displayName: created.name,
        status: 'draft',
        purpose: 'Serves customers.',
        version: 1,
      });
    }
    const agentStatus = route?.match(/^specialists\/([^/]+)\/status$/);
    if (agentStatus !== null && agentStatus !== undefined && method === 'POST') {
      const denied = needs('specialist.manage');
      if (denied !== undefined) return denied;
      const found = (options.specialists[organizationId] ?? []).find(
        (s) => s.id === agentStatus[1],
      );
      if (found === undefined) return json(404, { error: 'specialist_not_found' });
      const { from, to, reason } = JSON.parse(body ?? '{}') as {
        from?: string;
        to?: string;
        reason?: string;
      };
      if (from !== found.status) return json(409, { error: 'specialist_concurrency_conflict' });
      if (to === 'disabled' && (reason ?? '').trim() === '') {
        return json(400, { error: 'invalid_specialist', field: 'reason' });
      }
      const problems = options.activationProblems?.[found.id];
      if (to === 'active' && problems !== undefined) {
        return json(409, { error: 'specialist_not_ready', problems });
      }
      const was = found.status;
      found.status = to ?? found.status;
      return json(200, {
        id: found.id,
        departmentId: `${organizationId}_${found.type}`,
        displayName: found.name,
        status: found.status,
        purpose: found.purpose ?? null,
        lastStatusChange: {
          from: was,
          to: found.status,
          at: '2026-09-27T12:00:00Z',
          by: 'user_alice',
          reason: reason ?? null,
        },
      });
    }
    const agentAutonomy = route?.match(/^specialists\/([^/]+)\/autonomy$/);
    if (agentAutonomy !== null && agentAutonomy !== undefined && method === 'POST') {
      const denied = needs('specialist.manage');
      if (denied !== undefined) return denied;
      const found = (options.specialists[organizationId] ?? []).find(
        (s) => s.id === agentAutonomy[1],
      );
      if (found === undefined) return json(404, { error: 'specialist_not_found' });
      const { autonomy } = JSON.parse(body ?? '{}') as { autonomy: string };
      found.autonomy = autonomy;
      return json(200, {
        id: found.id,
        departmentId: `${organizationId}_${found.type}`,
        displayName: found.name,
        status: found.status,
        autonomy,
      });
    }
    const agentCapabilities = route?.match(/^specialists\/([^/]+)\/capabilities$/);
    if (agentCapabilities !== null && agentCapabilities !== undefined) {
      const denied = needs('specialist.read');
      if (denied !== undefined) return denied;
      const found = (options.specialists[organizationId] ?? []).find(
        (s) => s.id === agentCapabilities[1],
      );
      if (found === undefined) return json(404, { error: 'specialist_not_found' });
      return json(200, {
        id: found.id,
        version: 2,
        autonomy: found.autonomy ?? 'controlled',
        ready: found.status === 'active',
        // As the API gives it for the supervised conversation agent (ADR-0043, ADR-0069).
        skills: [
          {
            id: 'company_knowledge',
            version: 1,
            known: true,
            tools: [],
            actions: [],
            reads: ['knowledge.read'],
          },
          {
            id: 'conversation_reply',
            version: 1,
            known: true,
            tools: ['message_send', 'conversation_handoff'],
            actions: [],
            reads: ['conversation.read'],
          },
        ],
        tools: [
          {
            id: 'message_send',
            version: 2,
            known: true,
            riskLevel: 'medium',
            approval: 'approval_required',
          },
          {
            id: 'conversation_handoff',
            version: 1,
            known: true,
            riskLevel: 'low',
            approval: 'auto',
          },
        ],
        permissions: { required: [], missing: [] },
        problems: found.status === 'active' ? [] : [{ kind: 'not_active', status: found.status }],
      });
    }
    if (route === 'specialists') {
      const denied = needs('specialist.read');
      if (denied !== undefined) return denied;
      const all = (options.specialists[organizationId] ?? []).map((s) => ({
        id: s.id,
        departmentId: `${organizationId}_${s.type}`,
        displayName: s.name,
        status: s.status,
        purpose: s.purpose ?? null,
        updatedAt: '2026-09-27T12:00:00Z',
      }));
      if (query === '') return json(200, { specialists: all });
      // One page at a time (AE-4.3), filtered as the API does.
      const q = new URLSearchParams(query);
      const text = q.get('q')?.toLowerCase();
      const status = q.get('status');
      const departmentId = q.get('departmentId');
      const found = all.filter(
        (s) =>
          (text === undefined || s.displayName.toLowerCase().includes(text)) &&
          (status === null || s.status === status) &&
          (departmentId === null || s.departmentId === departmentId),
      );
      const { items, nextCursor } = pageOf(found, query);
      return json(200, { specialists: items, nextCursor });
    }
    if (route === 'credits') {
      const balance = options.credits[organizationId];
      return (
        needs('credits.read') ??
        json(
          200,
          balance === undefined
            ? { organizationId, status: 'absent', reason: 'no_wallet' }
            : {
                organizationId,
                status: 'present',
                balance,
                included: 0,
                purchased: balance,
                reserved: 0,
                available: balance,
                period: options.creditPeriods?.[organizationId] ?? null,
                updatedAt: '2026-09-27T12:00:00Z',
              },
        )
      );
    }
    if (route === 'entitlements') {
      return (
        needs('entitlement.read') ??
        json(200, {
          organizationId,
          status: 'active',
          plan: { id: 'entrepreneur', version: 1 },
          capabilities: {},
          limits: { 'users.max': 1, 'credits.monthlyIncluded': 0 },
        })
      );
    }
    if (route === 'activity') {
      const denied = needs('activity.read');
      if (denied !== undefined) return denied;
      if (options.activityFails === true) return json(500, { error: 'internal' });
      const profile = options.businessProfiles[organizationId];
      return json(200, {
        period: new URLSearchParams(query).get('period'),
        timeZone: profile?.timeZone ?? 'America/Lima',
        timeZoneSource: profile === undefined ? 'default' : 'business',
        from: '2026-09-28T05:00:00.000Z',
        to: '2026-09-28T15:00:00.000Z',
        items: options.activity[organizationId] ?? [],
        hasMore: false,
      });
    }
    if (route === 'audit-trail') {
      const denied = needs('activity.read');
      if (denied !== undefined) return denied;
      const failing = options.auditTrailFails;
      if (failing !== undefined) return json(failing.status, { error: failing.error });
      const q = new URLSearchParams(query);
      const category = q.get('category');
      const all = (options.auditTrail[organizationId] ?? []).filter(
        (i) => category === null || i['category'] === category,
      );
      const size = options.auditTrailPageSize ?? 25;
      const start = Number(q.get('cursor') ?? '0');
      const end = start + size;
      return json(200, {
        from: '2026-09-04T05:00:00.000Z',
        to: '2026-10-04T15:00:00.000Z',
        fromDay: q.get('from') ?? '2026-09-04',
        toDay: q.get('to') ?? '2026-10-04',
        timeZone: 'America/Lima',
        filter: category,
        filters: ['specialist', 'planning', 'tool', 'technical'],
        items: all.slice(start, end),
        nextCursor: end < all.length ? String(end) : null,
      });
    }
    if (route === 'approvals' || route?.startsWith('approvals/') === true) {
      const list = (options.approvals[organizationId] ??= []);
      if (route === 'approvals') {
        const denied = needs('approval.read');
        return denied ?? json(200, { approvals: list });
      }
      const denied = needs('approval.approve');
      if (denied !== undefined) return denied;
      const [, id, decision] = route.split('/');
      if (options.approvalDecisionFails !== undefined) {
        return json(options.approvalDecisionFails.status, {
          error: options.approvalDecisionFails.error,
        });
      }
      const index = list.findIndex((a) => a.id === id);
      const found = list[index];
      if (found === undefined) return json(404, { error: 'approval_not_found' });
      if (found.status !== 'pending') return json(409, { error: 'approval_not_pending' });
      const decided = {
        ...found,
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedAt: '2026-09-29T12:05:00.000Z',
      };
      list[index] = decided;
      return json(200, decided);
    }
    if (route === 'ai-usage' || route === 'ai-usage/events') {
      const denied = needs('ai_usage.read');
      if (denied !== undefined) return denied;
      const usage = options.aiUsage[organizationId];
      if (usage !== undefined && 'status' in usage)
        return json(usage.status, { error: 'internal' });
      if (route === 'ai-usage/events') {
        return json(200, { events: usage?.events ?? [], nextCursor: null });
      }
      const params = new URLSearchParams(query);
      return json(200, {
        ...(usage?.summary ?? {
          totals: { operations: 0, credits: 0 },
          by: {},
        }),
        from: params.get('from'),
        to: params.get('to'),
      });
    }
    if (route === 'documents') {
      const denied = needs(method === 'POST' ? 'document.upload' : 'document.read');
      if (denied !== undefined) return denied;
      const list = (options.documents[organizationId] ??= []);
      if (method !== 'POST') return json(200, { documents: list, nextCursor: null });
      if (options.documentUploadFails !== undefined) {
        return json(options.documentUploadFails.status, {
          error: options.documentUploadFails.error,
        });
      }
      const name = new URLSearchParams(query).get('name');
      uploads.push({ contentType: currentContentType, name });
      const document = {
        id: `doc_${list.length + 1}`,
        name: name ?? '',
        contentType: currentContentType ?? '',
        sizeBytes: 2048,
        sha256: 'a'.repeat(64),
        status: 'ingested',
        ingestion: null,
        knowledgeDocumentId: `k_${list.length + 1}`,
        textSource: 'library',
        pages: 3,
        uploadedBy: 'user_ana',
        createdAt: '2026-09-29T12:00:00.000Z',
        updatedAt: '2026-09-29T12:00:00.000Z',
      };
      list.unshift(document);
      return json(201, { document, duplicate: false });
    }
    if (route === 'metrics' || route?.startsWith('metrics/') === true) {
      const denied = needs('report.read');
      if (denied !== undefined) return denied;
      const reports = options.metrics[organizationId] ?? { list: [], histories: {} };
      if (route === 'metrics') return json(200, { metrics: reports.list });
      const frequency = new URLSearchParams(query).get('frequency') ?? 'day';
      const read = reports.histories[`${route.slice('metrics/'.length)}:${frequency}`];
      if (read === undefined) return json(404, { error: 'metric_not_found' });
      return 'error' in read && typeof read.status === 'number'
        ? json(read.status, {
            error: read.error,
            ...(read.field === undefined ? {} : { field: read.field }),
          })
        : json(200, read);
    }
    if (route === 'forecasts' && method === 'POST') {
      const denied = needs('forecast.run');
      if (denied !== undefined) return denied;
      const asked = JSON.parse(body ?? '{}') as { metric?: string; frequency?: string };
      const answer = options.forecasts?.[`${asked.metric}:${asked.frequency}`];
      if (answer === undefined) return json(404, { error: 'metric_not_found' });
      return 'error' in answer && typeof answer.status === 'number'
        ? json(answer.status, { error: answer.error })
        : json(200, answer);
    }
    if (route === 'gia/messages' && method === 'POST') {
      const denied = needs('gia.ask');
      if (denied !== undefined) return denied;
      const answer = options.gia;
      return 'error' in answer && typeof answer.status === 'number'
        ? json(answer.status, {
            error: answer.error,
            ...('estimatedCredits' in answer ? { estimatedCredits: answer.estimatedCredits } : {}),
          })
        : json(200, answer);
    }
    if (
      route === 'pipeline' ||
      route === 'opportunities' ||
      route?.startsWith('opportunities/') === true
    ) {
      return opportunitiesAnswer(organizationId, route, query, method, body, needs);
    }
    if (route === 'brain' || route?.startsWith('brain/') === true) {
      return brainAnswer(organizationId, route, query, method, body, needs);
    }
    if (route === 'follow-ups' || route?.startsWith('follow-ups/') === true) {
      return followUpsAnswer(organizationId, route, query, method, body, needs);
    }
    if (route === 'customers' || route?.startsWith('customers/') === true) {
      return customersAnswer(organizationId, route, query, method, body, needs);
    }
    if (route === 'business-profile') {
      const view = () => {
        const profile = options.businessProfiles[organizationId];
        return {
          profile: profile ?? null,
          departmentPriority:
            profile?.businessType === 'restaurant'
              ? ['sales', 'operations', 'marketing', 'finance', 'leadership', 'research']
              : ['sales', 'marketing', 'operations', 'finance', 'leadership', 'research'],
        };
      };
      if (method === 'PUT') {
        const denied = needs('organization.update');
        if (denied !== undefined) return denied;
        const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
        if (input.country === 'AQ')
          return json(400, { error: 'invalid_profile', field: 'country' });
        options.businessProfiles[organizationId] = {
          city: null,
          employees: null,
          salesChannels: [],
          offering: null,
          needs: null,
          notes: null,
          ...input,
          updatedAt: '2026-09-28T12:00:00Z',
        };
        return json(200, view());
      }
      return needs('organization.read') ?? json(200, view());
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
    uploads,
    cancelled,
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
