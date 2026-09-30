import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The platform AI view through the API (ADR-0082): for the MelonOffice platform administrator
 * only. Which AI providers and models MelonMotor has, their prices and terms, how calls are
 * routed and fall back, how each provider is doing, and every organization's AI usage with
 * MelonOffice's internal cost. A company never reaches it: the server refuses anyone else.
 */

export interface PlatformProvider {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly health: 'available' | 'degraded' | 'unavailable';
  readonly capabilities: readonly string[];
  readonly environments: readonly string[];
  readonly maxSensitivity: string;
}

export type PlatformPricing =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'known';
      readonly inputMicroUsdPerMillionTokens: number;
      readonly outputMicroUsdPerMillionTokens: number;
      readonly source: string;
      readonly asOf: string;
    };

export interface PlatformModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly version: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly pricing: PlatformPricing;
  readonly environments: readonly string[];
  readonly maxSensitivity: string;
  readonly terms: { readonly offering: string; readonly production: string } | null;
}

export interface PlatformPolicy {
  readonly id: string;
  readonly version: number;
  readonly allowedModels: readonly string[] | null;
  readonly environments: readonly string[];
  readonly maxSensitivity: string;
  readonly maxCostMicroUsd: number | null;
  readonly strategy: string | null;
  readonly fallback: 'none' | 'compatible';
  readonly maxAttempts: number;
}

export interface PlatformAI {
  readonly environment: string | null;
  readonly providers: readonly PlatformProvider[];
  readonly models: readonly PlatformModel[];
  readonly policies: readonly PlatformPolicy[];
}

export interface PlatformBucket {
  readonly operations: number;
  /** MelonOffice's internal cost, in millionths of a US dollar. */
  readonly costMicroUsd: number;
  readonly unpricedOperations: number;
  readonly credits: number;
}

export interface PlatformUsage {
  readonly from: string;
  readonly to: string;
  readonly totals: PlatformBucket;
  readonly by: Partial<Record<string, Readonly<Record<string, PlatformBucket>>>>;
  readonly byOrganization: readonly (PlatformBucket & {
    readonly organizationId: string;
    readonly name: string | null;
  })[];
}

export class PlatformRequestError extends Error {
  override readonly name = 'PlatformRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(`platform request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

/** What a refusal says, for the screen: the API's code and field, or the HTTP status. */
export const errorOf = (error: unknown) =>
  error instanceof PlatformRequestError
    ? [error.code, error.field].filter((x) => x !== undefined).join(': ') || String(error.status)
    : 'network';

/** A partner or agency account as the platform administrator sees it (ADR-0086). */
export interface CommercialAccountView {
  readonly id: string;
  readonly type: 'partner' | 'agency';
  readonly name: string;
  readonly status: string;
  readonly limits: { readonly customers: number; readonly members: number } | null;
  /** The version the server changes it from (ADR-0091): sent back with every change. */
  readonly updatedAt: string;
}

export type CommercialAccountStatus = 'active' | 'suspended' | 'closed';

/** Why the platform administrator adds credits by hand (ADR-0091): codes the API accepts. */
export const GRANT_REASONS = [
  'manual_purchase',
  'courtesy',
  'support_compensation',
  'testing',
] as const;
export type GrantReason = (typeof GRANT_REASONS)[number];

/** The organization about to receive credits, as the confirmation shows it. */
export interface PlatformOrganizationView {
  readonly organization: { readonly id: string; readonly name: string; readonly status: string };
  readonly credits: { readonly balance: number; readonly updatedAt: string } | null;
}

export interface CreditGrantResult {
  readonly grant: {
    readonly id: string;
    readonly organizationId: string;
    readonly amount: number;
    readonly reason: GrantReason;
    readonly idempotencyKey: string;
    readonly balanceAfter: number;
    readonly createdAt: string;
  };
  readonly balance: number;
  /** True when this key had already granted: the first grant is answered, nothing moved again. */
  readonly replayed: boolean;
}

export type DomainStatus = 'pending_verification' | 'verified' | 'active' | 'disabled';

/** A domain and what it points at (ADR-0087). */
export interface DomainView {
  readonly hostname: string;
  readonly target:
    | { readonly type: 'commercial_account'; readonly commercialAccountId: string }
    | { readonly type: 'organization'; readonly organizationId: string };
  readonly status: DomainStatus;
  readonly updatedAt: string;
}

export interface NewCommercialAccount {
  readonly type: 'partner' | 'agency';
  readonly name: string;
  readonly adminUserId: string;
  readonly limits: { readonly customers: number; readonly members: number };
}

export interface PlatformClient {
  /** Whether the signed-in person is a platform administrator; false on any failure. */
  access(): Promise<boolean>;
  ai(): Promise<PlatformAI>;
  usage(from: string, to: string): Promise<PlatformUsage>;
  commercialAccounts(): Promise<readonly CommercialAccountView[]>;
  createCommercialAccount(input: NewCommercialAccount): Promise<CommercialAccountView>;
  domains(): Promise<readonly DomainView[]>;
  createDomain(hostname: string, target: DomainView['target']): Promise<DomainView>;
  setDomainStatus(domain: DomainView, status: DomainStatus): Promise<DomainView>;
  /** Suspend, reactivate or close; closing names the account exactly, as confirmation. */
  setAccountStatus(
    account: CommercialAccountView,
    status: CommercialAccountStatus,
    confirmName?: string,
  ): Promise<CommercialAccountView>;
  setAccountLimits(
    account: CommercialAccountView,
    limits: { readonly customers: number; readonly members: number },
  ): Promise<CommercialAccountView>;
  organization(organizationId: string): Promise<PlatformOrganizationView>;
  grantCredits(
    organizationId: string,
    grant: {
      readonly amount: number;
      readonly reason: GrantReason;
      readonly idempotencyKey: string;
    },
  ): Promise<CreditGrantResult>;
}

export function createPlatformClient(request: ReplyRequest): PlatformClient {
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(path, {});
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new PlatformRequestError(
        response.status,
        typeof payload.error === 'string' ? payload.error : undefined,
      );
    }
    return (await response.json()) as T;
  };
  const write = async <T>(path: string, body: object): Promise<T> => {
    const response = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new PlatformRequestError(
        response.status,
        typeof payload.error === 'string' ? payload.error : undefined,
        typeof payload.field === 'string' ? payload.field : undefined,
      );
    }
    return payload as T;
  };
  return {
    access: () =>
      read<{ platformAdmin?: unknown }>('/v1/platform/access').then(
        (body) => body.platformAdmin === true,
        () => false,
      ),
    ai: () => read<PlatformAI>('/v1/platform/ai'),
    usage: (from, to) =>
      read<PlatformUsage>(`/v1/platform/ai-usage?${new URLSearchParams({ from, to }).toString()}`),
    commercialAccounts: () =>
      read<{ accounts: CommercialAccountView[] }>('/v1/platform/commercial-accounts').then(
        (body) => body.accounts,
      ),
    createCommercialAccount: (input) =>
      write<{ account: CommercialAccountView }>('/v1/platform/commercial-accounts', input).then(
        (body) => body.account,
      ),
    domains: () =>
      read<{ domains: DomainView[] }>('/v1/platform/domain-bindings').then((body) => body.domains),
    createDomain: (hostname, target) =>
      write<{ domain: DomainView }>('/v1/platform/domain-bindings', { hostname, target }).then(
        (body) => body.domain,
      ),
    setDomainStatus: (domain, status) =>
      write<{ domain: DomainView }>(
        `/v1/platform/domain-bindings/${encodeURIComponent(domain.hostname)}/status`,
        { status, expectedUpdatedAt: domain.updatedAt },
      ).then((body) => body.domain),
    setAccountStatus: (account, status, confirmName) =>
      write<{ account: CommercialAccountView }>(
        `/v1/platform/commercial-accounts/${encodeURIComponent(account.id)}/status`,
        {
          status,
          expectedUpdatedAt: account.updatedAt,
          ...(confirmName === undefined ? {} : { confirmName }),
        },
      ).then((body) => body.account),
    setAccountLimits: (account, limits) =>
      write<{ account: CommercialAccountView }>(
        `/v1/platform/commercial-accounts/${encodeURIComponent(account.id)}/limits`,
        { limits, expectedUpdatedAt: account.updatedAt },
      ).then((body) => body.account),
    organization: (organizationId) =>
      read<PlatformOrganizationView>(
        `/v1/platform/organizations/${encodeURIComponent(organizationId)}`,
      ),
    grantCredits: (organizationId, grant) =>
      write<CreditGrantResult>(
        `/v1/platform/organizations/${encodeURIComponent(organizationId)}/credit-grants`,
        grant,
      ),
  };
}
