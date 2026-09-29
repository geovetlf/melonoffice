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
  readonly skills: readonly { readonly id: string; readonly known: boolean }[];
  readonly tools: readonly {
    readonly id: string;
    readonly known: boolean;
    readonly riskLevel: string | null;
    readonly approval: string | null;
  }[];
  readonly problems: readonly { readonly kind: string }[];
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

export interface AgentsClient {
  templates(): Promise<readonly AgentTemplateView[]>;
  create(input: {
    readonly templateId: string;
    readonly displayName: string;
    readonly locale: 'es' | 'en';
  }): Promise<AgentView>;
  setStatus(id: string, from: SpecialistStatus, to: SpecialistStatus): Promise<AgentView>;
  capabilities(id: string): Promise<AgentCapabilitiesView>;
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
    create: (input) => post<AgentView>('/specialists', input),
    setStatus: (id, from, to) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/status`, { from, to }),
    capabilities: (id) =>
      call<AgentCapabilitiesView>(`/specialists/${encodeURIComponent(id)}/capabilities`),
  };
}
