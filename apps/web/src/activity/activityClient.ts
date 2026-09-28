import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The office's activity (ADR-0049), read from the audit trail through the API. The screen shows
 * exactly what it returns: an empty list means nothing happened, and nothing is ever filled in.
 */

export type ActivityPeriod = 'today' | 'week' | 'month';

export type ActivityActor = 'you' | 'member' | 'gia' | 'agent' | 'contact' | 'system';

export interface ActivityItemView {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly result: string;
  readonly actor: ActivityActor;
  readonly link?: { readonly kind: 'conversation' | 'follow_up'; readonly id: string };
}

export interface ActivityPageView {
  readonly period: ActivityPeriod;
  readonly timeZone: string;
  readonly timeZoneSource: 'business' | 'default';
  readonly from: string;
  readonly to: string;
  readonly items: readonly ActivityItemView[];
  readonly hasMore: boolean;
}

export interface ActivityClient {
  list(period: ActivityPeriod): Promise<ActivityPageView>;
}

export class ActivityRequestError extends Error {
  override readonly name = 'ActivityRequestError';
  constructor(readonly status: number) {
    super(`activity request failed: ${status}`);
  }
}

export function createActivityClient(
  request: ReplyRequest,
  organizationId: string,
): ActivityClient {
  const path = `/v1/organizations/${encodeURIComponent(organizationId)}/activity`;
  return {
    async list(period) {
      const response = await request(`${path}?period=${period}`, {});
      if (!response.ok) throw new ActivityRequestError(response.status);
      return (await response.json()) as ActivityPageView;
    },
  };
}
