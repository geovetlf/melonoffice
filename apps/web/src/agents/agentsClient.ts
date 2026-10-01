import type { ReplyRequest } from '../conversations/sendReply.js';
import type { SpecialistStatus, SpecialistView } from '../office/officeClient.js';

/**
 * Agent lifecycle through the API (ADR-0025, ADR-0062): the templates an agent is created from,
 * creating one, moving its status, and what it can do now. The web never runs an agent; changing
 * an agent is `specialist.manage`, which the server checks again.
 */

export interface AgentTemplateView {
  readonly id: string;
  readonly departmentTypeId: string;
  readonly nameKey: string;
  readonly role: { readonly id: string; readonly version: number };
  readonly purpose: Readonly<Record<string, string>>;
  readonly skills: readonly { readonly id: string; readonly version: number }[];
}

export interface AgentView extends SpecialistView {
  readonly version?: number;
  readonly role?: { readonly id: string; readonly version: number };
  readonly skills?: readonly { readonly id: string; readonly version: number }[];
  /** Who last changed its status, when and why (AE-4). */
  readonly lastStatusChange?: {
    readonly from: SpecialistStatus;
    readonly to: SpecialistStatus;
    readonly at: string;
    readonly by: string;
    readonly reason: string | null;
  } | null;
}

/** Something that stops an agent from being activated (AE-4), with what it names. */
export interface ReadinessProblemView {
  readonly kind: string;
  readonly skill?: string;
  readonly tool?: string;
  readonly permission?: string;
}

/** What one page of agents asks for (AE-4). Empty values are left out. */
export interface AgentPageQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: SpecialistStatus;
  readonly departmentId?: string;
  readonly q?: string;
  readonly skill?: string;
}

export interface AgentPageView {
  readonly specialists: readonly AgentView[];
  readonly nextCursor: string | null;
}

export interface AgentCapabilitiesView {
  readonly version: number;
  readonly ready: boolean;
  /** Each skill at the exact version the agent has, and what that version grants (ADR-0069). */
  readonly skills: readonly {
    readonly id: string;
    readonly version: number;
    readonly known: boolean;
    readonly tools: readonly string[];
    readonly actions: readonly string[];
    readonly reads: readonly string[];
  }[];
  readonly tools: readonly {
    readonly id: string;
    readonly version: number;
    readonly known: boolean;
    readonly riskLevel: string | null;
    readonly approval: string | null;
  }[];
  readonly problems: readonly ReadinessProblemView[];
  /** A newer version of one of its skills, which a person may move it to (ADR-0084). */
  readonly upgrades?: readonly {
    readonly skillId: string;
    readonly from: number;
    readonly to: number;
  }[];
}

/** Where each status may go (ADR-0025): archived is final. */
export const TRANSITIONS: Readonly<Record<SpecialistStatus, readonly SpecialistStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['paused', 'disabled', 'archived'],
  paused: ['active', 'disabled', 'archived'],
  disabled: ['active', 'archived'],
  archived: [],
};

export class AgentRequestError extends Error {
  override readonly name = 'AgentRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
    /** What stops activation, for `specialist_not_ready` (AE-4). */
    readonly problems: readonly ReadinessProblemView[] = [],
  ) {
    super(`agent request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

/** A skill in the catalogue (ADR-0069): what it lets an agent do and read. */
export interface SkillView {
  readonly id: string;
  readonly version: number;
  readonly nameKey: string;
  readonly descriptionKey: string;
  readonly tools: readonly { readonly id: string; readonly versions: readonly number[] }[];
  readonly actions: readonly string[];
  readonly reads: readonly string[];
}

/** A tool as `GET tools` shows it (ADR-0026): each version and the policy it runs under. */
export interface ToolView {
  readonly id: string;
  readonly status: string;
  readonly versions: readonly {
    readonly version: number;
    readonly nameKey: string;
    readonly descriptionKey: string;
    readonly category: string;
    readonly action: string;
    readonly mutating: boolean;
    readonly riskLevel: string;
    readonly approvalPolicy: string;
    readonly environments: readonly string[];
  }[];
}

export interface AgentsClient {
  templates(): Promise<readonly AgentTemplateView[]>;
  skills(): Promise<readonly SkillView[]>;
  /** Needs `tool.read`. */
  tools(): Promise<readonly ToolView[]>;
  create(input: {
    readonly templateId: string;
    readonly displayName: string;
    readonly locale: 'es' | 'en';
  }): Promise<AgentView>;
  setStatus(
    id: string,
    from: SpecialistStatus,
    to: SpecialistStatus,
    reason?: string,
  ): Promise<AgentView>;
  /** One page of the organization's agents (AE-4): never the whole list. */
  page(query: AgentPageQuery): Promise<AgentPageView>;
  capabilities(id: string): Promise<AgentCapabilitiesView>;
  /** Needs `specialist.manage`: one skill to a newer version, as a new version of the agent. */
  upgradeSkill(
    id: string,
    input: { readonly fromVersion: number; readonly skillId: string; readonly version: number },
  ): Promise<AgentView>;
}

/** How many agents one page shows. */
export const AGENT_PAGE_LIMIT = 25;

export function createAgentsClient(request: ReplyRequest, organizationId: string): AgentsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await request(`${base}${path}`, init);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new AgentRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
        Array.isArray(body.problems) ? (body.problems as ReadinessProblemView[]) : [],
      );
    }
    return body as T;
  };
  const post = <T>(path: string, body: unknown) =>
    call<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    async templates() {
      return (await call<{ templates?: AgentTemplateView[] }>('/agents/catalogue')).templates ?? [];
    },
    async skills() {
      return (await call<{ skills?: SkillView[] }>('/agents/catalogue')).skills ?? [];
    },
    async tools() {
      return (await call<{ tools?: ToolView[] }>('/tools')).tools ?? [];
    },
    create: (input) => post<AgentView>('/specialists', input),
    setStatus: (id, from, to, reason) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/status`, {
        from,
        to,
        ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    async page(query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value));
      }
      // At least the page size, so the server always answers with one page.
      if (!params.has('limit')) params.set('limit', String(AGENT_PAGE_LIMIT));
      const body = await call<{ specialists?: AgentView[]; nextCursor?: string | null }>(
        `/specialists?${params.toString()}`,
      );
      return { specialists: body.specialists ?? [], nextCursor: body.nextCursor ?? null };
    },
    capabilities: (id) =>
      call<AgentCapabilitiesView>(`/specialists/${encodeURIComponent(id)}/capabilities`),
    upgradeSkill: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/skills/upgrade`, input),
  };
}
