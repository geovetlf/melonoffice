import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Opportunities and the pipeline (C2, ADR-0054), as the API serves them. The stages are the
 * organization's own (proposed for its kind of business until stored); contacts are C1's.
 */

export type StageKind = 'open' | 'won' | 'lost';
export type OpportunityStatus = 'open' | 'won' | 'lost';
export const LOST_REASONS = [
  'price',
  'timing',
  'competitor',
  'no_response',
  'not_a_fit',
  'other',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export interface StageView {
  readonly id: string;
  readonly kind: StageKind;
  readonly name: string | null;
  readonly nameKey: string | null;
  readonly probability: number;
}

export interface PipelineView {
  readonly id: string;
  readonly template: string;
  readonly revision: number;
  readonly stored: boolean;
  readonly stages: readonly StageView[];
}

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface OpportunityView {
  readonly id: string;
  readonly contactId: string;
  readonly contactName?: string | null;
  readonly stageId: string;
  readonly status: OpportunityStatus;
  readonly title: string;
  readonly value: Money | null;
  readonly probability: number;
  readonly owner: 'you' | 'member' | null;
  readonly expectedCloseOn: string | null;
  readonly nextAction: { readonly text: string; readonly dueOn: string } | null;
  readonly lostReason: LostReason | null;
  readonly closedAt: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly transition: { readonly from: string; readonly to: string } | null;
  readonly reason: string | null;
  readonly actor: 'you' | 'member' | 'gia' | 'system';
}

export interface OpportunityDetail extends OpportunityView {
  readonly contact: {
    readonly id: string;
    readonly displayName: string | null;
    readonly stage: string | null;
  };
  /** Null for a reader who may not read conversations. */
  readonly conversations:
    | readonly {
        readonly id: string;
        readonly channel: string;
        readonly status: string;
        readonly lastMessageAt: string;
      }[]
    | null;
  readonly history: readonly HistoryEntry[];
}

export interface PipelineSummary {
  readonly currency: string | null;
  readonly stages: Readonly<
    Record<string, { readonly count: number; readonly valueMinor: number }>
  >;
  readonly open: { readonly count: number; readonly valueMinor: number };
  readonly won: number;
  readonly lost: number;
}

export interface OpportunityList {
  readonly items: readonly OpportunityView[];
  readonly summary: PipelineSummary;
  readonly hasMore: boolean;
}

export interface NewOpportunity {
  readonly contactId: string;
  readonly title: string;
  readonly stageId?: string;
  readonly value?: { readonly amountMinor: number };
  readonly expectedCloseOn?: string;
}

export interface OpportunityChange {
  readonly revision: number;
  readonly title?: string;
  readonly stageId?: string;
  readonly lostReason?: LostReason;
  readonly value?: { readonly amountMinor: number } | null;
  readonly probability?: number;
  readonly ownerId?: string | null;
  readonly expectedCloseOn?: string | null;
  readonly nextAction?: { readonly text: string; readonly dueOn: string } | null;
}

export interface StageInput {
  readonly id?: string;
  readonly name?: string;
  readonly probability?: number;
}

export interface OpportunitiesClient {
  pipeline(): Promise<PipelineView>;
  savePipeline(revision: number, stages: readonly StageInput[]): Promise<PipelineView>;
  list(status: OpportunityStatus): Promise<OpportunityList>;
  get(id: string): Promise<OpportunityDetail>;
  create(input: NewOpportunity): Promise<OpportunityView>;
  update(id: string, change: OpportunityChange): Promise<OpportunityView>;
}

/** The API refused or failed; `field` names the refused field when it says. */
export class OpportunityRequestError extends Error {
  override readonly name = 'OpportunityRequestError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly field: string | undefined,
  ) {
    super(`opportunity request failed: ${status}`);
  }
}

export function createOpportunitiesClient(
  request: ReplyRequest,
  organizationId: string,
): OpportunitiesClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  async function read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      throw new OpportunityRequestError(response.status, text(body.error), text(body.field));
    }
    return (await response.json()) as T;
  }
  const send = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const one = (id: string) => `${base}/opportunities/${encodeURIComponent(id)}`;
  return {
    pipeline: async () => read(await request(`${base}/pipeline`, {})),
    savePipeline: async (revision, stages) =>
      read(await request(`${base}/pipeline`, send('PUT', { revision, stages }))),
    list: async (status) => read(await request(`${base}/opportunities?status=${status}`, {})),
    get: async (id) => read(await request(one(id), {})),
    create: async (input) => read(await request(`${base}/opportunities`, send('POST', input))),
    update: async (id, change) => read(await request(one(id), send('PATCH', change))),
  };
}
