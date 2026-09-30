import type { ReplyRequest } from '../conversations/sendReply.js';
import type { CustomerScope } from '../partners/partnersClient.js';

/**
 * The partner and agency console through the API (ADR-0086..0090): the caller's own accounts, and
 * inside one of them its people, customers, invitations and brand. The screen only shows and
 * sends; the API decides every access, scope and limit.
 */

export type AccountType = 'partner' | 'agency';

export interface ConsoleAccount {
  readonly id: string;
  readonly type: AccountType;
  readonly name: string;
  readonly status: string;
  readonly limits: { readonly customers?: number; readonly members?: number } | null;
  /** The caller's role in it, e.g. `partner.admin`. */
  readonly role: string;
}

export interface ConsoleMember {
  readonly userId: string;
  readonly role: string;
  readonly status: 'active' | 'suspended' | 'revoked';
  readonly updatedAt: string;
}

export interface ConsoleCustomer {
  readonly organizationId: string;
  readonly mode: string;
  readonly scopes: readonly CustomerScope[];
  /** Only where the customer granted `summary`. */
  readonly name: string | null;
}

export interface ConsoleInvitation {
  readonly id: string;
  readonly email: string;
  readonly mode: string;
  readonly scopes: readonly CustomerScope[];
  readonly status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerSummary {
  readonly organization: { readonly id: string; readonly name: string; readonly status: string };
  readonly plan: string | null;
}

export interface CustomerUsage {
  readonly from: string;
  readonly to: string;
  readonly totals: { readonly operations: number; readonly credits: number };
  readonly byCapability: Readonly<
    Record<string, { readonly operations: number; readonly credits: number }>
  >;
}

export interface CustomerBilling {
  readonly billedTo: 'customer' | 'commercial_account' | null;
  readonly subscription: {
    readonly plan: string;
    readonly status: string;
    readonly planInForce: boolean;
  } | null;
}

/** A brand level as its owner edits it (ADR-0087). */
export interface OwnBrand {
  readonly own: Readonly<Record<string, unknown>> | null;
  readonly updatedAt: string | null;
}

export class ConsoleRequestError extends Error {
  override readonly name = 'ConsoleRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(`console request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

export interface ConsoleClient {
  accounts(): Promise<readonly ConsoleAccount[]>;
  members(accountId: string): Promise<readonly ConsoleMember[]>;
  addMember(accountId: string, userId: string, role: string): Promise<ConsoleMember>;
  revokeMember(accountId: string, userId: string): Promise<void>;
  customers(accountId: string): Promise<{
    readonly customers: readonly ConsoleCustomer[];
    readonly pending: readonly Omit<ConsoleCustomer, 'name'>[];
  }>;
  summary(accountId: string, organizationId: string): Promise<CustomerSummary>;
  usage(
    accountId: string,
    organizationId: string,
    from: string,
    to: string,
  ): Promise<CustomerUsage>;
  billing(accountId: string, organizationId: string): Promise<CustomerBilling>;
  invitations(accountId: string): Promise<readonly ConsoleInvitation[]>;
  invite(
    accountId: string,
    input: {
      readonly email: string;
      readonly mode: string;
      readonly scopes: readonly CustomerScope[];
    },
  ): Promise<{ readonly invitation: ConsoleInvitation; readonly token?: string }>;
  revokeInvitation(accountId: string, invitation: ConsoleInvitation): Promise<ConsoleInvitation>;
  accountBrand(accountId: string): Promise<OwnBrand>;
  saveAccountBrand(
    accountId: string,
    config: Readonly<Record<string, unknown>>,
    expectedUpdatedAt: string | null,
  ): Promise<OwnBrand>;
  customerBrand(accountId: string, organizationId: string): Promise<OwnBrand>;
  saveCustomerBrand(
    accountId: string,
    organizationId: string,
    config: Readonly<Record<string, unknown>>,
    expectedUpdatedAt: string | null,
  ): Promise<OwnBrand>;
}

export function createConsoleClient(request: ReplyRequest): ConsoleClient {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await request(path, init);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ConsoleRequestError(
        response.status,
        typeof payload.error === 'string' ? payload.error : undefined,
        typeof payload.field === 'string' ? payload.field : undefined,
      );
    }
    return payload as T;
  };
  const send = <T>(path: string, method: 'POST' | 'PUT', body: object) =>
    call<T>(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const acc = (id: string) => `/v1/commercial/accounts/${encodeURIComponent(id)}`;
  const cus = (id: string, org: string) => `${acc(id)}/customers/${encodeURIComponent(org)}`;
  const brandOf = (b: { config?: unknown; own?: unknown; updatedAt?: unknown }): OwnBrand => ({
    own: (b.own ?? b.config ?? null) as OwnBrand['own'],
    updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : null,
  });

  return {
    accounts: async () =>
      (await call<{ accounts: ConsoleAccount[] }>('/v1/commercial/accounts')).accounts,
    members: async (id) => (await call<{ members: ConsoleMember[] }>(`${acc(id)}/members`)).members,
    addMember: async (id, userId, role) =>
      (await send<{ member: ConsoleMember }>(`${acc(id)}/members`, 'POST', { userId, role }))
        .member,
    revokeMember: async (id, userId) => {
      await send(`${acc(id)}/members/${encodeURIComponent(userId)}/revoke`, 'POST', {});
    },
    customers: (id) =>
      call<{
        customers: ConsoleCustomer[];
        pending: Omit<ConsoleCustomer, 'name'>[];
      }>(`${acc(id)}/customers`),
    summary: (id, org) => call<CustomerSummary>(cus(id, org)),
    usage: (id, org, from, to) =>
      call<CustomerUsage>(
        `${cus(id, org)}/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    billing: (id, org) => call<CustomerBilling>(`${cus(id, org)}/billing`),
    invitations: async (id) =>
      (await call<{ invitations: ConsoleInvitation[] }>(`${acc(id)}/invitations`)).invitations,
    invite: async (id, input) => {
      const created = await send<{ invitation: ConsoleInvitation; token?: unknown }>(
        `${acc(id)}/invitations`,
        'POST',
        input,
      );
      return typeof created.token === 'string'
        ? { invitation: created.invitation, token: created.token }
        : { invitation: created.invitation };
    },
    revokeInvitation: async (id, invitation) =>
      (
        await send<{ invitation: ConsoleInvitation }>(
          `${acc(id)}/invitations/${encodeURIComponent(invitation.id)}/revoke`,
          'POST',
          { expectedUpdatedAt: invitation.updatedAt },
        )
      ).invitation,
    accountBrand: async (id) => brandOf(await call(`${acc(id)}/brand`)),
    saveAccountBrand: async (id, config, expectedUpdatedAt) =>
      brandOf(
        await send(`${acc(id)}/brand`, 'PUT', {
          config,
          ...(expectedUpdatedAt === null ? {} : { expectedUpdatedAt }),
        }),
      ),
    customerBrand: async (id, org) => brandOf(await call(`${cus(id, org)}/brand`)),
    saveCustomerBrand: async (id, org, config, expectedUpdatedAt) =>
      brandOf(
        await send(`${cus(id, org)}/brand`, 'PUT', {
          config,
          ...(expectedUpdatedAt === null ? {} : { expectedUpdatedAt }),
        }),
      ),
  };
}
