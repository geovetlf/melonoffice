import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The audit trail (ADR-0147), read through the API, read only. The screen shows exactly what the
 * API returns, a page at a time; every filter is checked again on the server.
 */

export interface AuditTrailItemView {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly category: string;
  readonly result: 'success' | 'denied' | 'failure';
  readonly actor: {
    readonly kind: 'you' | 'member' | 'gia' | 'agent' | 'contact' | 'system' | 'platform_admin';
    readonly onBehalfOf?: 'you' | 'member';
  };
  readonly target?: {
    readonly type: string;
    readonly link?: { readonly kind: 'conversation' | 'follow_up' | 'plan'; readonly id: string };
  };
  readonly details: {
    readonly reason?: string;
    readonly version?: number;
    readonly transition?: { readonly from: string; readonly to: string };
    readonly tool?: string;
    readonly step?: string;
    readonly permission?: string;
    readonly model?: string;
    readonly decision?: string;
  };
}

export interface AuditTrailPageView {
  readonly fromDay: string;
  readonly toDay: string;
  readonly timeZone: string;
  readonly filter: string | null;
  /** What may be filtered on, as the API lists it. */
  readonly filters: readonly string[];
  readonly items: readonly AuditTrailItemView[];
  readonly nextCursor: string | null;
}

export interface AuditTrailQuery {
  readonly category?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
}

export interface AuditTrailClient {
  page(query: AuditTrailQuery): Promise<AuditTrailPageView>;
}

export class AuditTrailRequestError extends Error {
  override readonly name = 'AuditTrailRequestError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`audit trail request failed: ${status}`);
  }
}

export function createAuditTrailClient(
  request: ReplyRequest,
  organizationId: string,
): AuditTrailClient {
  const path = `/v1/organizations/${encodeURIComponent(organizationId)}/audit-trail`;
  return {
    async page(query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string' && value.length > 0) params.set(key, value);
      }
      const search = params.toString();
      const response = await request(search.length === 0 ? path : `${path}?${search}`, {});
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          { error?: unknown } | undefined;
        throw new AuditTrailRequestError(
          response.status,
          typeof body?.error === 'string' ? body.error : undefined,
        );
      }
      return (await response.json()) as AuditTrailPageView;
    },
  };
}
