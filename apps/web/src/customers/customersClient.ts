import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Customers and leads (C1, ADR-0053), as the API serves them: the organization's contacts with a
 * commercial stage. They are the same contacts the conversations use; the organization, the
 * responsible person's identity and the audit trail are the server's.
 */

export type CustomerStage = 'lead' | 'customer' | 'inactive';
export const STAGES: readonly CustomerStage[] = ['lead', 'customer', 'inactive'];
export type Consent = 'granted' | 'denied' | 'unknown';
export const CONSENTS: readonly Consent[] = ['unknown', 'granted', 'denied'];

export interface CustomerView {
  readonly id: string;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly origin: string;
  readonly revision: number;
  readonly commercial: {
    readonly stage: CustomerStage;
    /** Only `you` or `member`: another member's id is never sent. */
    readonly owner: 'you' | 'member' | null;
    readonly source: string;
    readonly consent: Consent;
    readonly consentAt: string | null;
    readonly nextAction: {
      readonly text: string;
      readonly dueOn: string;
      /** Set when it is the record's earliest open follow-up (C5): it changes only through it. */
      readonly followUpId?: string;
    } | null;
    readonly stageChangedAt: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerNote {
  readonly id: string;
  readonly text: string;
  readonly author: 'you' | 'member';
  readonly createdAt: string;
}

/** One of the contact's opportunities as its card shows it (C3), with its stage. */
export interface ContactOpportunity {
  readonly id: string;
  readonly title: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly value: { readonly amountMinor: number; readonly currency: string } | null;
  readonly probability: number;
  readonly owner: 'you' | 'member' | null;
  readonly expectedCloseOn: string | null;
  readonly nextAction: {
    readonly text: string;
    readonly dueOn: string;
    /** Set when it is the record's earliest open follow-up (C5): it changes only through it. */
    readonly followUpId?: string;
  } | null;
  readonly lostReason: string | null;
  readonly stage: {
    readonly id: string;
    readonly kind: 'open' | 'won' | 'lost';
    readonly name: string | null;
    readonly nameKey: string | null;
  } | null;
  readonly updatedAt: string;
}

/** One entry of the contact's history (C3): its own events and its opportunities'. */
export interface ContactHistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly transition: { readonly from: string; readonly to: string } | null;
  readonly reason: string | null;
  readonly actor: 'you' | 'member' | 'gia' | 'system';
  readonly opportunityId: string | null;
}

export interface CustomerDetail extends CustomerView {
  readonly notes: readonly CustomerNote[];
  /**
   * The rest of the contact's commercial context (C3, ADR-0055). `null` when the reader may not
   * see that part (or the server does not send it), which the card says instead of "none".
   */
  readonly conversations?:
    | readonly {
        readonly id: string;
        readonly channel: string;
        readonly status: string;
        readonly lastMessageAt: string;
      }[]
    | null;
  readonly opportunities?: readonly ContactOpportunity[] | null;
  readonly history?: readonly ContactHistoryEntry[] | null;
}

export type StageCounts = Readonly<Record<CustomerStage, number>>;

export interface CustomerList {
  readonly items: readonly CustomerView[];
  readonly counts: StageCounts;
  readonly hasMore: boolean;
}

export interface NewCustomer {
  readonly displayName: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface CustomerChange {
  readonly revision: number;
  readonly stage?: CustomerStage;
  /** `me` is resolved by the screen to the signed-in user; null clears it. */
  readonly ownerId?: string | null;
  readonly consent?: { readonly messaging: Consent; readonly recordedBy?: 'contact' | 'member' };
  readonly nextAction?: { readonly text: string; readonly dueOn: string } | null;
}

export interface CustomersClient {
  list(stage: CustomerStage): Promise<CustomerList>;
  get(id: string): Promise<CustomerDetail>;
  create(input: NewCustomer): Promise<CustomerView>;
  update(id: string, change: CustomerChange): Promise<CustomerView>;
  addNote(id: string, text: string): Promise<CustomerNote>;
}

/** The API refused or failed. `contactId` names the existing contact of a duplicate. */
export class CustomerRequestError extends Error {
  override readonly name = 'CustomerRequestError';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly field: string | undefined,
    readonly contactId: string | undefined,
  ) {
    super(`customer request failed: ${status}`);
  }
}

export function createCustomersClient(
  request: ReplyRequest,
  organizationId: string,
): CustomersClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/customers`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  async function read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
      throw new CustomerRequestError(
        response.status,
        text(body.error),
        text(body.field),
        text(body.contactId),
      );
    }
    return (await response.json()) as T;
  }
  const send = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    list: async (stage) => read(await request(`${base}?stage=${stage}`, {})),
    get: async (id) => read(await request(one(id), {})),
    create: async (input) => read(await request(base, send('POST', input))),
    update: async (id, change) => read(await request(one(id), send('PATCH', change))),
    addNote: async (id, text) => read(await request(`${one(id)}/notes`, send('POST', { text }))),
  };
}
