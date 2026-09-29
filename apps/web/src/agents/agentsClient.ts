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
  readonly problems: readonly { readonly kind: string }[];
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
  setStatus(id: string, from: SpecialistStatus, to: SpecialistStatus): Promise<AgentView>;
  capabilities(id: string): Promise<AgentCapabilitiesView>;
  /** Needs `specialist.manage`: one skill to a newer version, as a new version of the agent. */
  upgradeSkill(
    id: string,
    input: { readonly fromVersion: number; readonly skillId: string; readonly version: number },
  ): Promise<AgentView>;
}

export function createAgentsClient(request: ReplyRequest, organizationId: string): AgentsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await request(`${base}${path}`, init);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new AgentRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
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
    setStatus: (id, from, to) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/status`, { from, to }),
    capabilities: (id) =>
      call<AgentCapabilitiesView>(`/specialists/${encodeURIComponent(id)}/capabilities`),
    upgradeSkill: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/skills/upgrade`, input),
  };
}
