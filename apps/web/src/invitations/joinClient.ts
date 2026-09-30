import type { ReplyRequest } from '../conversations/sendReply.js';
import { InvitationRequestError, type InvitationStatus } from './invitationsClient.js';

/**
 * An invitation to join a partner or agency account, as the invited person sees it through the
 * API (ADR-0093). The secret goes in the body, never in a URL; the API decides who may take it.
 */
export interface JoinLookup {
  readonly invitation: {
    readonly account: { readonly name: string; readonly type: 'partner' | 'agency' } | null;
    readonly role: string;
    readonly status: InvitationStatus;
    readonly expiresAt: string;
    readonly updatedAt: string;
  };
  readonly person: 'invited' | 'email_not_verified' | 'not_invited_person';
}

export interface JoinClient {
  lookup(token: string): Promise<JoinLookup>;
  accept(token: string, expectedUpdatedAt: string): Promise<void>;
  reject(token: string, expectedUpdatedAt: string): Promise<void>;
}

export function createJoinClient(request: ReplyRequest): JoinClient {
  const post = async <T>(action: string, body: object): Promise<T> => {
    const response = await request(`/v1/member-invitations/${action}`, {
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
    lookup: (token) => post<JoinLookup>('lookup', { token }),
    async accept(token, expectedUpdatedAt) {
      await post('accept', { token, expectedUpdatedAt });
    },
    async reject(token, expectedUpdatedAt) {
      await post('reject', { token, expectedUpdatedAt });
    },
  };
}
