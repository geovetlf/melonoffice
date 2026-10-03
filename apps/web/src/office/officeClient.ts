import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * What the Home and the department offices read from the API (ADR-0040). Only existing,
 * permission-checked routes of the signed-in organization: departments (ADR-0025), specialists
 * (ADR-0025), credits (ADR-0023) and billing (ADR-0022). Nothing here writes, and nothing talks to
 * a provider.
 */

export interface DepartmentView {
  readonly id: string;
  readonly origin: 'catalog' | 'custom';
  readonly typeId: string | null;
  readonly nameKey: string | null;
  readonly shortNameKey: string | null;
  readonly name: string | null;
  readonly status: string;
  readonly description: string | null;
}

export type SpecialistStatus = 'draft' | 'active' | 'paused' | 'disabled' | 'archived';

export interface SpecialistView {
  readonly id: string;
  readonly departmentId: string;
  readonly displayName: string;
  readonly status: SpecialistStatus;
  /** What the agent is for, in the owner's words: the office shows it as the agent's role. */
  readonly purpose?: string | null;
  readonly updatedAt?: string;
}

export type CreditsView =
  | {
      readonly status: 'present';
      readonly balance: number;
      /** Where the balance came from, and what running operations hold (ADR-0123). */
      readonly included?: number;
      readonly purchased?: number;
      readonly reserved?: number;
      readonly available?: number;
      readonly updatedAt: string;
    }
  | { readonly status: 'absent' | 'unavailable' };

/** What the plan gives (entitlements, ADR-0021): credits included each month, when it gives any. */
export interface PlanLimitsView {
  readonly monthlyIncluded: number | 'unlimited' | null;
}

export type BillingView =
  | {
      readonly status: 'present';
      readonly subscription: { readonly plan: { readonly id: string }; readonly status: string };
      readonly planInForce: boolean;
    }
  | { readonly status: 'absent' | 'unavailable' };

export interface OfficeClient {
  departments(): Promise<readonly DepartmentView[]>;
  specialists(): Promise<readonly SpecialistView[]>;
  credits(): Promise<CreditsView>;
  billing(): Promise<BillingView>;
  entitlements?(): Promise<PlanLimitsView>;
}

/** The API refused or failed: the screen shows the part as unavailable, never guesses it. */
export class OfficeError extends Error {
  override readonly name = 'OfficeError';
  constructor(readonly status: number) {
    super(`office request failed: ${status}`);
  }
}

export function createOfficeClient(request: ReplyRequest, organizationId: string): OfficeClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  async function get<T>(path: string): Promise<T> {
    const response = await request(`${base}${path}`, {});
    if (!response.ok) throw new OfficeError(response.status);
    return (await response.json()) as T;
  }
  return {
    departments: async () =>
      (await get<{ departments: DepartmentView[] }>('/departments')).departments,
    specialists: async () =>
      (await get<{ specialists: SpecialistView[] }>('/specialists')).specialists,
    credits: async () => {
      const body = await get<CreditsView>('/credits');
      return body.status === 'present' && typeof body.balance === 'number'
        ? body
        : { status: body.status === 'absent' ? 'absent' : 'unavailable' };
    },
    billing: async () => {
      const body = await get<BillingView>('/billing');
      return body.status === 'present'
        ? body
        : { status: body.status === 'absent' ? 'absent' : 'unavailable' };
    },
    entitlements: async () => {
      const body = await get<{ limits?: Record<string, unknown> }>('/entitlements');
      const value = body.limits?.['credits.monthlyIncluded'];
      return {
        monthlyIncluded:
          value === 'unlimited' || (typeof value === 'number' && value > 0) ? value : null,
      };
    },
  };
}
