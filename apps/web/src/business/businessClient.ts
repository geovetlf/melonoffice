import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The business profile (ADR-0048), as the API serves it: the organization's kind of business,
 * where it is, its currency and time zone, and what the owner chose to add. The kinds of business
 * come from the API as data; the screen never assumes the list.
 */

export const EMPLOYEE_RANGES = ['1', '2_5', '6_10', '11_50', '51_plus'] as const;

export const SALES_CHANNELS = [
  'physical_store',
  'whatsapp',
  'social_media',
  'website',
  'marketplace',
  'delivery_apps',
  'phone',
  'in_person',
] as const;

export interface BusinessProfile {
  readonly businessType: string;
  readonly country: string;
  readonly currency: string;
  readonly timeZone: string;
  readonly city: string;
  readonly employees: string | null;
  readonly salesChannels: readonly string[];
  readonly offering: string | null;
  readonly needs: string | null;
  readonly notes: string | null;
  readonly updatedAt: string;
}

export interface BusinessProfileView {
  /** Null until the business is described. */
  readonly profile: BusinessProfile | null;
  /** The suggested order of the departments (catalogue type ids), most relevant first. */
  readonly departmentPriority: readonly string[];
}

export interface BusinessType {
  readonly id: string;
  readonly nameKey: string;
}

/** What a person sends: the required fields and any optional one they filled in. */
export interface BusinessProfileInput {
  readonly businessType: string;
  readonly country: string;
  readonly currency: string;
  readonly timeZone: string;
  readonly city: string;
  readonly employees?: string;
  readonly salesChannels?: readonly string[];
  readonly offering?: string;
  readonly needs?: string;
  readonly notes?: string;
}

export interface BusinessClient {
  profile(): Promise<BusinessProfileView>;
  save(input: BusinessProfileInput): Promise<BusinessProfileView>;
  types(): Promise<readonly BusinessType[]>;
}

/** The API refused or failed. `field` names the field it refused, when it says. */
export class BusinessRequestError extends Error {
  override readonly name = 'BusinessRequestError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly field: string | undefined,
  ) {
    super(`business request failed: ${status}`);
  }
}

export function createBusinessClient(
  request: ReplyRequest,
  organizationId: string,
): BusinessClient {
  const path = `/v1/organizations/${encodeURIComponent(organizationId)}/business-profile`;
  async function read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        field?: unknown;
      };
      throw new BusinessRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
        typeof body.field === 'string' ? body.field : undefined,
      );
    }
    return (await response.json()) as T;
  }
  return {
    profile: async () => read<BusinessProfileView>(await request(path, {})),
    save: async (input) =>
      read<BusinessProfileView>(
        await request(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    types: async () =>
      (await read<{ businessTypes: BusinessType[] }>(await request('/v1/business-types', {})))
        .businessTypes,
  };
}
