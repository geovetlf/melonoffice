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
}

export type CreditsView =
  | { readonly status: 'present'; readonly balance: number; readonly updatedAt: string }
  | { readonly status: 'absent' | 'unavailable' };

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
  };
}
