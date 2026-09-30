import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The organization's partners and agencies through the API (ADR-0086, ADR-0088): who asked to
 * reach it, who may, and for what. Only its owner decides: accept with the scopes they grant,
 * narrow them, or end the relationship. The screen shows and sends; the API decides.
 */

export type CustomerScope =
  'summary' | 'usage' | 'billing' | 'branding' | 'support' | 'knowledge' | 'conversations';

export interface Relationship {
  readonly commercialAccountId: string;
  readonly mode: string;
  readonly status: 'pending' | 'active' | 'suspended' | 'ended';
  readonly scopes: readonly CustomerScope[];
  readonly updatedAt: string;
  readonly account: { readonly name: string; readonly type: 'partner' | 'agency' } | null;
}

export class PartnersRequestError extends Error {
  override readonly name = 'PartnersRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`partners request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

export interface PartnersClient {
  list(): Promise<readonly Relationship[]>;
  accept(r: Relationship, scopes: readonly CustomerScope[]): Promise<Relationship>;
  setScopes(r: Relationship, scopes: readonly CustomerScope[]): Promise<Relationship>;
  end(r: Relationship): Promise<Relationship>;
}

export function createPartnersClient(
  request: ReplyRequest,
  organizationId: string,
): PartnersClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/commercial-relationships`;
  const send = async (r: Relationship, action: string, body: object) => {
    const response = await request(
      `${base}/${encodeURIComponent(r.commercialAccountId)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, expectedUpdatedAt: r.updatedAt }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      relationship?: Omit<Relationship, 'account'>;
    };
    if (!response.ok || payload.relationship === undefined) {
      throw new PartnersRequestError(
        response.status,
        typeof payload.error === 'string' ? payload.error : undefined,
      );
    }
    return { ...payload.relationship, account: r.account };
  };
  return {
    async list() {
      const response = await request(base, {});
      if (!response.ok) throw new PartnersRequestError(response.status);
      return ((await response.json()) as { relationships?: Relationship[] }).relationships ?? [];
    },
    accept: (r, scopes) => send(r, 'accept', { scopes }),
    setScopes: (r, scopes) => send(r, 'scopes', { scopes }),
    end: (r) => send(r, 'end', {}),
  };
}
