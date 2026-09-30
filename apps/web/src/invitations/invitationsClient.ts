import type { ReplyRequest } from '../conversations/sendReply.js';
import type { CustomerScope } from '../partners/partnersClient.js';

/**
 * An invitation by email, as the invited person sees it through the API (ADR-0089). The secret
 * goes in the body, never in a URL. The API decides who may take it and for which organization.
 */

export type InvitationStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

export interface InvitationLookup {
  readonly invitation: {
    readonly account: { readonly name: string; readonly type: 'partner' | 'agency' } | null;
    readonly mode: string;
    readonly scopes: readonly CustomerScope[];
    readonly status: InvitationStatus;
    readonly expiresAt: string;
    readonly updatedAt: string;
  };
  /** Whether this signed-in person is the one invited. */
  readonly person: 'invited' | 'email_not_verified' | 'not_invited_person';
  /** Their organization, as the API resolved it. */
  readonly organization: null | 'ambiguous' | { readonly id: string; readonly canDecide: boolean };
}

export class InvitationRequestError extends Error {
  override readonly name = 'InvitationRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`invitation request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

export interface InvitationsClient {
  lookup(token: string): Promise<InvitationLookup>;
  accept(
    token: string,
    scopes: readonly CustomerScope[],
    expectedUpdatedAt: string,
  ): Promise<{ readonly status: 'active' | 'pending' }>;
  reject(token: string, expectedUpdatedAt: string): Promise<void>;
}

export function createInvitationsClient(request: ReplyRequest): InvitationsClient {
  const post = async <T>(action: string, body: object): Promise<T> => {
    const response = await request(`/v1/invitations/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new InvitationRequestError(
        response.status,
        typeof payload.error === 'string' ? payload.error : undefined,
      );
    }
    return payload as T;
  };
  return {
    lookup: (token) => post<InvitationLookup>('lookup', { token }),
    async accept(token, scopes, expectedUpdatedAt) {
      const { relationship } = await post<{ relationship: { status: 'active' | 'pending' } }>(
        'accept',
        { token, scopes, expectedUpdatedAt },
      );
      return { status: relationship.status };
    },
    async reject(token, expectedUpdatedAt) {
      await post('reject', { token, expectedUpdatedAt });
    },
  };
}
