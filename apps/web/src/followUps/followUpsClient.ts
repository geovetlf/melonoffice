import type { ReplyRequest } from '../conversations/sendReply.js';
import { pageQuery, type PageRequest } from '../lists/pages.js';

/**
 * Follow-ups (C5, ADR-0058), as the API serves them: something a member must do about a contact
 * or an opportunity at a set time, in the business's time zone. When its time comes it is marked
 * due and shows in the office's activity. Nothing is ever sent to the contact.
 */

export const FOLLOW_UP_TYPES = ['follow_up', 'call', 'message', 'review', 'check_in'] as const;
export type FollowUpType = (typeof FOLLOW_UP_TYPES)[number];
export type FollowUpStatus = 'scheduled' | 'due' | 'completed' | 'cancelled' | 'failed';
export type FollowUpWhen = 'overdue' | 'today' | 'upcoming' | 'later';

export interface FollowUpView {
  readonly id: string;
  readonly contactId: string;
  readonly contactName?: string | null;
  readonly opportunityId: string | null;
  readonly assignee: 'you' | 'member' | null;
  readonly type: FollowUpType;
  readonly title: string;
  readonly description: string | null;
  readonly scheduledAt: string;
  readonly timeZone: string;
  readonly date: string;
  readonly time: string;
  readonly when: FollowUpWhen;
  readonly days: number;
  readonly status: FollowUpStatus;
  readonly source: 'manual' | 'gia' | 'rule';
  readonly cancelReason: string | null;
  readonly failure: string | null;
  readonly revision: number;
}

export interface FollowUpList {
  readonly timeZone: string;
  readonly today: string;
  readonly counts: {
    readonly overdue: number;
    readonly today: number;
    readonly upcoming: number;
    readonly open: number;
  };
  readonly items: readonly FollowUpView[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface FollowUpFilter {
  readonly contactId?: string;
  readonly opportunityId?: string;
  readonly mine?: boolean;
  readonly open?: boolean;
}

export interface NewFollowUp {
  readonly requestKey: string;
  readonly contactId: string;
  readonly opportunityId?: string;
  readonly type: FollowUpType;
  readonly title: string;
  readonly date: string;
  readonly time: string;
  readonly source?: 'manual' | 'gia';
}

export interface FollowUpsClient {
  /** One page of the follow-ups the filter keeps, soonest first. */
  list(filter?: FollowUpFilter, page?: PageRequest): Promise<FollowUpList>;
  create(input: NewFollowUp): Promise<FollowUpView & { readonly created: boolean }>;
  reschedule(
    id: string,
    input: { readonly revision: number; readonly date: string; readonly time: string },
  ): Promise<FollowUpView>;
  complete(id: string, revision: number): Promise<FollowUpView>;
  cancel(id: string, revision: number): Promise<FollowUpView>;
}

/** The API refused or failed; `field` names the refused field when it says. */
export class FollowUpRequestError extends Error {
  override readonly name = 'FollowUpRequestError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly field: string | undefined,
  ) {
    super(`follow-up request failed: ${status}`);
  }
}

export function createFollowUpsClient(
  request: ReplyRequest,
  organizationId: string,
): FollowUpsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/follow-ups`;
  async function read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      throw new FollowUpRequestError(response.status, text(body.error), text(body.field));
    }
    return (await response.json()) as T;
  }
  const send = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const one = (id: string, action: string) => `${base}/${encodeURIComponent(id)}/${action}`;
  return {
    async list(filter = {}, page) {
      const query = pageQuery(new URLSearchParams(), page);
      if (filter.contactId !== undefined) query.set('contact', filter.contactId);
      if (filter.opportunityId !== undefined) query.set('opportunity', filter.opportunityId);
      if (filter.mine === true) query.set('assignee', 'me');
      if (filter.open === true) query.set('open', 'true');
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      return read(await request(`${base}${suffix}`, {}));
    },
    create: async (input) => read(await request(base, send(input))),
    reschedule: async (id, input) => read(await request(one(id, 'reschedule'), send(input))),
    complete: async (id, revision) => read(await request(one(id, 'complete'), send({ revision }))),
    cancel: async (id, revision) => read(await request(one(id, 'cancel'), send({ revision }))),
  };
}

/** A new request key: the same click is the same follow-up, however often it is sent. */
export const newRequestKey = () => globalThis.crypto.randomUUID();
