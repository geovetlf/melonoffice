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

/** A partner or agency account as the platform administrator sees it (ADR-0086). */
export interface CommercialAccountView {
  readonly id: string;
  readonly type: 'partner' | 'agency';
  readonly name: string;
  readonly status: string;
  readonly limits: { readonly customers: number; readonly members: number } | null;
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
}

export function createPlatformClient(request: ReplyRequest): PlatformClient {
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(path, {});
    if (!response.ok) throw new PlatformRequestError(response.status);
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
  };
}
