import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The company's memory (ADR-0056): Company Brain (ADR-0051) as its API serves it. This is the one
 * company knowledge GIA reads and proposes to; the screen adds nothing of its own.
 */

export const KNOWLEDGE_DOMAINS = [
  'identity',
  'business_model',
  'products',
  'customers',
  'commercial',
  'marketing',
  'brand',
  'operations',
  'finance',
  'team',
  'policies',
  'goals',
  'documents',
  'integrations',
  'decisions',
] as const;
export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

export type KnowledgeValue =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'number'; readonly number: number; readonly unit?: string }
  | { readonly type: 'money'; readonly amountMinor: number; readonly currency: string }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'list'; readonly items: readonly string[] }
  | { readonly type: 'date'; readonly date: string };

export type Verification = 'proposed' | 'unverified' | 'confirmed' | 'calculated' | 'imported';
export type KnowledgeStatus = 'active' | 'outdated' | 'archived';
/** Who recorded it, as the reader understands it: never another person's id. */
export type Recorder = 'you' | 'member' | 'gia' | 'agent' | 'system';

export interface KnowledgeItem {
  readonly id: string;
  readonly domain: KnowledgeDomain;
  readonly key: string;
  readonly subject: { readonly type: string; readonly id: string } | null;
  readonly label: string | null;
  /** Absent when the reader may not see a restricted value. */
  readonly value?: KnowledgeValue;
  readonly verification: Verification;
  readonly status: KnowledgeStatus;
  readonly sensitivity: string;
  readonly critical: boolean;
  readonly needsConfirmation: boolean;
  readonly source: {
    readonly type: string;
    readonly id: string | null;
    readonly reference: string | null;
    readonly recordedBy: Recorder;
    readonly confidence: number | null;
  };
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly openConflictId: string | null;
}

export interface KnowledgeVersion {
  readonly revision: number;
  readonly operation: string;
  readonly value?: KnowledgeValue;
  readonly verification: Verification;
  readonly status: KnowledgeStatus;
  readonly source: string;
  readonly changedAt: string;
  readonly changedBy: Recorder;
  readonly reason: string | null;
}

export interface KnowledgeClaim {
  readonly value?: KnowledgeValue;
  readonly verification: Verification;
  readonly source: string;
  readonly recordedBy: Recorder;
}

export interface KnowledgeConflict {
  readonly id: string;
  readonly itemId: string;
  readonly domain: KnowledgeDomain;
  readonly key: string;
  readonly label: string | null;
  readonly current: KnowledgeClaim;
  readonly candidate: KnowledgeClaim;
  readonly createdAt: string;
}

export interface KnowledgeGaps {
  readonly questions: readonly {
    readonly id: string;
    readonly domain: KnowledgeDomain;
    readonly key: string;
  }[];
  readonly toConfirm: readonly KnowledgeItem[];
  readonly openConflicts: number;
}

export interface KnowledgeSummary {
  readonly initialized: boolean;
  readonly items: number;
  readonly byDomain: Readonly<Partial<Record<KnowledgeDomain, number>>>;
  readonly gaps: KnowledgeGaps;
}

export interface NewKnowledge {
  readonly domain: KnowledgeDomain;
  readonly key: string;
  readonly label?: string;
  readonly subject?: { readonly type: string; readonly id: string };
  readonly value: KnowledgeValue;
}

export interface KnowledgeOutcome {
  readonly outcome: string;
  readonly itemId: string;
  readonly revision?: number;
  readonly conflictId?: string;
}

export interface MemoryClient {
  summary(): Promise<KnowledgeSummary>;
  list(filter: {
    readonly domain?: KnowledgeDomain;
    readonly inactive?: boolean;
  }): Promise<readonly KnowledgeItem[]>;
  versions(itemId: string): Promise<readonly KnowledgeVersion[]>;
  propose(input: NewKnowledge): Promise<KnowledgeOutcome>;
  confirm(itemId: string, revision: number): Promise<KnowledgeOutcome>;
  invalidate(itemId: string, revision: number): Promise<KnowledgeOutcome>;
  archive(itemId: string, revision: number): Promise<KnowledgeOutcome>;
  conflicts(): Promise<readonly KnowledgeConflict[]>;
  resolve(conflictId: string, choice: 'kept_current' | 'took_candidate'): Promise<KnowledgeOutcome>;
  addDocument(name: string, text: string): Promise<unknown>;
}

/** The API refused or failed; `field` names the refused field when it says. */
export class MemoryRequestError extends Error {
  override readonly name = 'MemoryRequestError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly field: string | undefined,
  ) {
    super(`memory request failed: ${status}`);
  }
}

export function createMemoryClient(request: ReplyRequest, organizationId: string): MemoryClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/brain`;
  const item = (id: string) => `${base}/knowledge/${encodeURIComponent(id)}`;
  async function read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      throw new MemoryRequestError(response.status, text(body.error), text(body.field));
    }
    return (await response.json()) as T;
  }
  const send = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    summary: async () => read(await request(base, {})),
    list: async ({ domain, inactive }) => {
      const query = new URLSearchParams();
      if (domain !== undefined) query.set('domain', domain);
      if (inactive === true) query.set('inactive', '1');
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return (
        await read<{ items: readonly KnowledgeItem[] }>(
          await request(`${base}/knowledge${suffix}`, {}),
        )
      ).items;
    },
    versions: async (id) =>
      (await read<{ versions: readonly KnowledgeVersion[] }>(await request(item(id), {}))).versions,
    propose: async (input) => read(await request(`${base}/knowledge`, send(input))),
    confirm: async (id, revision) => read(await request(`${item(id)}/confirm`, send({ revision }))),
    invalidate: async (id, revision) =>
      read(await request(`${item(id)}/invalidate`, send({ revision }))),
    archive: async (id, revision) => read(await request(`${item(id)}/archive`, send({ revision }))),
    conflicts: async () =>
      (
        await read<{ conflicts: readonly KnowledgeConflict[] }>(
          await request(`${base}/conflicts`, {}),
        )
      ).conflicts,
    resolve: async (id, choice) =>
      read(await request(`${base}/conflicts/${encodeURIComponent(id)}/resolve`, send({ choice }))),
    addDocument: async (name, text) =>
      read(await request(`${base}/documents`, send({ name, text }))),
  };
}

/** A key for a fact a person names: "Horario de atención" → `horario_de_atencion`. */
export function keyFor(label: string): string | undefined {
  const key = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/g, '');
  return /^[a-z][a-z0-9_]*$/.test(key) ? key : undefined;
}
