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

/** How far an agent acts on its own (AE-4.4, ADR-0116). */
export type AgentAutonomyLevel = 'propose' | 'controlled' | 'within_policy';

export const AGENT_AUTONOMY_LEVELS: readonly AgentAutonomyLevel[] = [
  'propose',
  'controlled',
  'within_policy',
];

export interface AgentView extends SpecialistView {
  readonly version?: number;
  readonly autonomy?: AgentAutonomyLevel;
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
  readonly autonomy?: AgentAutonomyLevel;
}

export interface AgentPageView {
  readonly specialists: readonly AgentView[];
  readonly nextCursor: string | null;
}

/** What else an agent's work uses (ADR-0117): each off until a person switches it on. */
export interface AgentWorkSettingsView {
  readonly memory: boolean;
  readonly aiVerification: boolean;
  readonly collaboration: boolean;
}

export const AGENT_WORK_SETTINGS: readonly (keyof AgentWorkSettingsView)[] = [
  'memory',
  'aiVerification',
  'collaboration',
];

/** One note of an agent's own memory (ADR-0117): never Company Brain's. */
export interface AgentMemoryNoteView {
  readonly id: string;
  readonly kind: 'preference' | 'lesson' | 'note';
  readonly text: string;
  readonly source: 'task' | 'person';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AgentCapabilitiesView {
  readonly version: number;
  /** What it is for, in a person's words (ADR-0140). Absent from an older server. */
  readonly purpose?: string | null;
  readonly description?: string | null;
  /** Its work settings (ADR-0117). Absent from an older server: all off. */
  readonly work?: AgentWorkSettingsView;
  /** How far it acts on its own (AE-4.4). Absent from an older server: the default. */
  readonly autonomy?: AgentAutonomyLevel;
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
  /** Skills it may be given (ADR-0141), at the version the server would add. */
  readonly addable?: readonly { readonly skillId: string; readonly version: number }[];
  /** What removing each skill would take away (ADR-0141); empty when it has only one. */
  readonly removals?: readonly {
    readonly skillId: string;
    readonly removes: readonly string[];
    readonly breaks: readonly {
      readonly workflowId: string;
      readonly name: string;
      readonly step: string;
      readonly tool: string;
    }[];
  }[];
  /** Departments it may move to (ADR-0141), each with the skills that must go first. */
  readonly moves?: readonly {
    readonly departmentId: string;
    readonly blockedBy: readonly string[];
  }[];
  /** Active workflows that use its kind of agent in its current department (ADR-0141). */
  readonly moveLeaves?: readonly { readonly workflowId: string; readonly name: string }[];
  /** A newer version of one of its skills, which a person may move it to (ADR-0084). */
  readonly upgrades?: readonly {
    readonly skillId: string;
    readonly from: number;
    readonly to: number;
    /** The tools the upgrade takes away (G-2). Absent from an older server. */
    readonly removes?: readonly string[];
    /** Steps of active workflows that need one of them (G-2): a warning before confirming. */
    readonly breaks?: readonly {
      readonly workflowId: string;
      readonly name: string;
      readonly step: string;
      readonly tool: string;
    }[];
  }[];
}

/** One thing the review of the team found (G-1, ADR-0131), as plain values. */
export interface AuditFindingView {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly subject: {
    readonly type: 'agent' | 'workflow' | 'plan';
    readonly id: string;
    readonly version: number;
    readonly name?: string;
  };
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly recommendation: string;
}

/** The review of the team (G-1): read only, it changes nothing and asks no model. */
export interface AgentAuditView {
  readonly findings: readonly AuditFindingView[];
  readonly skipped: readonly string[];
  readonly reviewed: {
    readonly agents: number;
    readonly workflows: number;
    readonly plans: number;
  };
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

/** What one version of an agent changed (ADR-0142), as the API tells it. */
export type AgentChangeView =
  | { readonly kind: 'created' | 'other' }
  | { readonly kind: 'department'; readonly before: string; readonly after: string }
  | {
      readonly kind: 'purpose' | 'description';
      readonly before: string | null;
      readonly after: string | null;
    }
  | {
      readonly kind: 'skills';
      readonly added: readonly { readonly id: string; readonly version: number }[];
      readonly removed: readonly { readonly id: string; readonly version: number }[];
      readonly updated: readonly {
        readonly id: string;
        readonly from: number;
        readonly to: number;
      }[];
    }
  | { readonly kind: 'autonomy'; readonly before: string; readonly after: string }
  | {
      readonly kind: 'work';
      readonly before: Readonly<Record<string, boolean>>;
      readonly after: Readonly<Record<string, boolean>>;
    };

/** One version in an agent's history (ADR-0142): who, when and what it changed. */
export interface AgentHistoryEntryView {
  readonly version: number;
  readonly previousVersion: number | null;
  readonly createdAt: string;
  readonly actor: 'you' | 'another_person';
  /** The earlier version this one brought back (ADR-0143). Absent from an older server. */
  readonly restoredFrom?: number | null;
  readonly changes: readonly AgentChangeView[];
}

export interface AgentHistoryPageView {
  readonly entries: readonly AgentHistoryEntryView[];
  readonly nextBefore: number | null;
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
  /** Needs `specialist.manage`: one more skill, as a new version (ADR-0141). */
  addSkill?(
    id: string,
    input: { readonly fromVersion: number; readonly skillId: string; readonly version: number },
  ): Promise<AgentView>;
  /** Needs `specialist.manage`: an earlier version back, as a new one (ADR-0143). */
  restore?(
    id: string,
    input: { readonly fromVersion: number; readonly version: number },
  ): Promise<AgentView>;
  /** A page of its history, newest first (ADR-0142); `before` continues it. */
  history?(id: string, before?: number): Promise<AgentHistoryPageView>;
  /** Needs `specialist.manage`: skills and department as one new version (ADR-0141). */
  change?(
    id: string,
    input: {
      readonly fromVersion: number;
      readonly add?: readonly { readonly skillId: string; readonly version: number }[];
      readonly remove?: readonly string[];
      readonly departmentId?: string;
    },
  ): Promise<AgentView>;
  /** Needs `specialist.manage`: one skill fewer, as a new version (ADR-0141). */
  removeSkill?(
    id: string,
    input: { readonly fromVersion: number; readonly skillId: string },
  ): Promise<AgentView>;
  /** Needs `specialist.manage`: how far it acts on its own, as a new version (AE-4.4). */
  setAutonomy(
    id: string,
    input: { readonly fromVersion: number; readonly autonomy: AgentAutonomyLevel },
  ): Promise<AgentView>;
  /** Needs `specialist.manage`: its memory, AI check and collaboration, as a new version. */
  setWorkSettings?(
    id: string,
    input: { readonly fromVersion: number } & Partial<AgentWorkSettingsView>,
  ): Promise<AgentView>;
  /** Needs `specialist.manage`: its purpose and description, as a new version (ADR-0140). */
  setProfile?(
    id: string,
    input: {
      readonly fromVersion: number;
      readonly purpose?: string | null;
      readonly description?: string | null;
    },
  ): Promise<AgentView>;
  /** Its own memory (ADR-0117): whether it is on, and its notes. */
  memories?(
    id: string,
  ): Promise<{ readonly enabled: boolean; readonly items: readonly AgentMemoryNoteView[] }>;
  /** Needs `specialist.manage`: a person's note for the agent. */
  remember?(id: string, text: string): Promise<AgentMemoryNoteView>;
  forget?(id: string, memoryId: string): Promise<void>;
  clearMemory?(id: string): Promise<number>;
  /** The review of the organization's agents, workflows and plans (G-1). */
  audit?(): Promise<AgentAuditView>;
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
    addSkill: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/skills/add`, input),
    restore: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/restore`, input),
    async history(id, before) {
      const query = before === undefined ? '' : `?before=${before}`;
      const body = await call<Partial<AgentHistoryPageView>>(
        `/specialists/${encodeURIComponent(id)}/versions${query}`,
      );
      return { entries: body.entries ?? [], nextBefore: body.nextBefore ?? null };
    },
    change: (id, input) => post<AgentView>(`/specialists/${encodeURIComponent(id)}/changes`, input),
    removeSkill: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/skills/remove`, input),
    setAutonomy: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/autonomy`, input),
    setWorkSettings: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/settings`, input),
    setProfile: (id, input) =>
      post<AgentView>(`/specialists/${encodeURIComponent(id)}/profile`, input),
    memories: (id) =>
      call<{ enabled: boolean; items: AgentMemoryNoteView[] }>(
        `/specialists/${encodeURIComponent(id)}/memories`,
      ),
    remember: (id, text) =>
      post<AgentMemoryNoteView>(`/specialists/${encodeURIComponent(id)}/memories`, { text }),
    async forget(id, memoryId) {
      await call(
        `/specialists/${encodeURIComponent(id)}/memories/${encodeURIComponent(memoryId)}`,
        { method: 'DELETE' },
      );
    },
    async clearMemory(id) {
      const body = await call<{ deleted?: number }>(
        `/specialists/${encodeURIComponent(id)}/memories`,
        { method: 'DELETE' },
      );
      return body.deleted ?? 0;
    },
    audit: () => call<AgentAuditView>('/agents/audit'),
  };
}
