import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Approvals through the API (ADR-0026): every operation an agent asked a person to approve, for
 * one exact tool version and execution step. Deciding sends the id alone; the server binds the
 * decision to what was asked, and GIA can never decide.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalView {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly reason: string;
  readonly impact: string;
  readonly estimatedCredits: number | null;
  readonly executionId: string;
  readonly specialist: { readonly id: string; readonly version: number };
  readonly tool: { readonly id: string; readonly version: number };
  readonly action: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

export class ApprovalRequestError extends Error {
  override readonly name = 'ApprovalRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`approval request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

export interface ApprovalsClient {
  list(): Promise<readonly ApprovalView[]>;
  decide(id: string, decision: 'approve' | 'reject'): Promise<ApprovalView>;
}

export function createApprovalsClient(
  request: ReplyRequest,
  organizationId: string,
): ApprovalsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/approvals`;
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await request(path, init);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ApprovalRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
      );
    }
    return body as T;
  };
  return {
    async list() {
      return (await call<{ approvals?: ApprovalView[] }>(base)).approvals ?? [];
    },
    decide: (id, decision) =>
      call<ApprovalView>(`${base}/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
  };
}
