import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditTransition,
} from '@melonoffice/audit';
import type {
  Contact,
  ContactCommercial,
  ContactId,
  ContactNote,
  ContactSourceKind,
  ContactStage,
  IsoTimestamp,
  MessagingConsent,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { ConversationError } from './errors.js';
import { isContactId, isE164, isUuid, MAX_DISPLAY_NAME_LENGTH } from './model.js';
import {
  contactPosition,
  decodeCursor,
  nextCursorOf,
  PAGE_SIZES,
  pageLimit,
  type ContactPageFilter,
  type PageInput,
} from './pages.js';
import type { ConversationRepository } from './repository.js';

/**
 * Customers and leads (C1, ADR-0053): the commercial layer of the existing `Contact`, not a second
 * contact system or a CRM. A contact becomes a lead, a customer or inactive; it gets a
 * responsible member, a source, messaging consent, a next action and notes. Contacts from
 * WhatsApp and contacts a person enters are the same records, deduplicated only by an exact
 * phone or email. GIA and the runtime never write here: every change is a person's, audited
 * without personal data.
 */

export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'customer', 'inactive'];
export const CONTACT_SOURCE_KINDS: readonly ContactSourceKind[] = [
  'channel',
  'manual',
  'import',
  'campaign',
];
export const MESSAGING_CONSENTS: readonly MessagingConsent[] = ['granted', 'denied', 'unknown'];

export const CUSTOMER_LIMITS = Object.freeze({
  /** The most contacts one page returns (ADR-0061: `PAGE_SIZES.contacts`). */
  list: PAGE_SIZES.contacts.max,
  nextActionLength: 200,
  noteLength: 2_000,
  notesShown: 20,
  sourceReferenceLength: 64,
  emailLength: 254,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REFERENCE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A phone as E.164: spaces, dashes, dots and brackets dropped; anything else is not a phone. */
export function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/[\s().-]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return isE164(withPlus) ? withPlus : undefined;
}

/** An email trimmed and lower-cased, or undefined when it is not one. */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= CUSTOMER_LIMITS.emailLength && EMAIL.test(email) ? email : undefined;
}

/**
 * Another contact of the same organization with the same phone or email: an exact match only.
 * A similar name never makes two contacts one.
 */
export function duplicateOf(
  contact: Pick<Contact, 'id' | 'phone' | 'email'>,
  others: readonly Pick<Contact, 'id' | 'phone' | 'email' | 'status'>[],
): ContactId | undefined {
  return others.find(
    (other) =>
      other.id !== contact.id &&
      other.status !== 'archived' &&
      ((contact.phone !== undefined && other.phone === contact.phone) ||
        (contact.email !== undefined && other.email === contact.email)),
  )?.id as ContactId | undefined;
}

/**
 * Whether the business may send a message it starts to this contact (C1 decision 2). Consent
 * never blocks creating or managing a contact, nor answering a contact who wrote first (`reply`);
 * a bulk or automated send the business starts needs consent granted.
 */
export function consentAllows(
  contact: Pick<Contact, 'commercial'>,
  send: 'reply' | 'bulk' | 'automated',
): boolean {
  if (send === 'reply') return contact.commercial?.consent.messaging !== 'denied';
  return contact.commercial?.consent.messaging === 'granted';
}

/** One contact as the customers screen needs it. */
export interface CustomerList {
  readonly items: readonly Contact[];
  /** How many contacts are at each stage, of all the organization's contacts. */
  readonly counts: Readonly<Record<ContactStage, number>>;
  readonly hasMore: boolean;
  /** The cursor of the next page under the same filter, or null on the last page (ADR-0061). */
  readonly nextCursor: string | null;
}

export interface CustomerDetail {
  readonly contact: Contact;
  readonly notes: readonly ContactNote[];
}

export interface CustomerService {
  /**
   * `contact.read`: one page of the contacts at one stage, or of every marked one; the newest
   * change first. The counts are of all the organization's contacts, counted, not read.
   */
  list(
    tenant: TenantContext,
    filter?: { readonly stage?: unknown; readonly ownerId?: unknown },
    page?: PageInput,
  ): Promise<CustomerList>;
  /** `contact.read`: one contact with its latest notes. */
  get(tenant: TenantContext, id: string): Promise<CustomerDetail>;
  /** `contact.manage`, a person directly: a new contact, a lead by default. Refused if a duplicate. */
  create(tenant: TenantContext, input: Record<string, unknown>): Promise<Contact>;
  /**
   * `contact.manage`, a person directly: changes details, stage, owner, consent or next action,
   * against the contact's current `revision`. Marking a WhatsApp contact as a lead is this too.
   */
  update(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<Contact>;
  /** `contact.manage`, a person directly: adds a note. */
  addNote(tenant: TenantContext, id: string, text: unknown): Promise<ContactNote>;
  /** `contact.read`: how many contacts are at each stage (for Company Brain). */
  counts(tenant: TenantContext): Promise<Readonly<Record<ContactStage, number>>>;
}

export interface CustomerServiceOptions {
  readonly repository: Pick<
    ConversationRepository,
    | 'findContact'
    | 'listContacts'
    | 'pageContacts'
    | 'countContactStages'
    | 'createContact'
    | 'updateContact'
    | 'addContactNote'
    | 'listContactNotes'
  >;
  readonly organizations: Pick<TenancyStore, 'findOrganization' | 'findMembership'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly requestId?: string;
}

type ContactAction = Extract<AuditAction, `contact.${string}`>;

const INPUT_KEYS = new Set([
  'revision',
  'displayName',
  'phone',
  'email',
  'stage',
  'ownerId',
  'consent',
  'nextAction',
  'source',
]);

export function contactStageCounts(contacts: readonly Contact[]): Record<ContactStage, number> {
  const counts: Record<ContactStage, number> = { lead: 0, customer: 0, inactive: 0 };
  for (const c of contacts) {
    if (c.status !== 'archived' && c.commercial !== undefined) counts[c.commercial.stage] += 1;
  }
  return counts;
}

export function createCustomerService(options: CustomerServiceOptions): CustomerService {
  const {
    repository,
    organizations,
    authorization,
    now = () => new Date(),
    newId = randomUUID,
    requestId,
  } = options;

  async function organizationOf(
    tenant: TenantContext,
    permission: string,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new ConversationError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new ConversationError('permission_denied');
    }
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new ConversationError('organization_inactive');
    }
    return organization.id;
  }

  /** Every change is a person's, directly: GIA and the runtime never manage contacts. */
  async function managerOf(tenant: TenantContext): Promise<OrganizationId> {
    const organizationId = await organizationOf(tenant, 'contact.manage');
    if (tenant.actor !== 'user') throw new ConversationError('requires_user');
    return organizationId;
  }

  const event = (
    tenant: TenantContext,
    contact: Pick<Contact, 'organizationId' | 'id'>,
    action: ContactAction,
    at: Date,
    fields: { readonly transition?: AuditTransition; readonly reason?: string } = {},
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId: contact.organizationId,
        target: { type: 'contact', id: contact.id },
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  const bad = (field: string): never => {
    throw new ConversationError('invalid_request', field);
  };

  async function ownerOf(organizationId: OrganizationId, value: unknown): Promise<UserId> {
    if (!isUuid(value)) bad('ownerId');
    const membership = await organizations.findMembership(organizationId, value as UserId);
    if (membership?.status !== 'active') throw new ConversationError('owner_not_member');
    return value as UserId;
  }

  function nextActionOf(value: unknown): NonNullable<ContactCommercial['nextAction']> {
    if (typeof value !== 'object' || value === null) return bad('nextAction');
    const { text, dueOn } = value as Record<string, unknown>;
    if (
      typeof text !== 'string' ||
      text.trim() === '' ||
      text.length > CUSTOMER_LIMITS.nextActionLength
    ) {
      bad('nextAction.text');
    }
    if (typeof dueOn !== 'string' || !DATE.test(dueOn) || Number.isNaN(Date.parse(dueOn))) {
      bad('nextAction.dueOn');
    }
    return Object.freeze({ text: (text as string).trim(), dueOn: dueOn as string });
  }

  function consentOf(value: unknown, at: IsoTimestamp): ContactCommercial['consent'] {
    if (typeof value !== 'object' || value === null) return bad('consent');
    const { messaging, recordedBy } = value as Record<string, unknown>;
    if (!(MESSAGING_CONSENTS as readonly unknown[]).includes(messaging)) bad('consent.messaging');
    if (recordedBy !== undefined && recordedBy !== 'contact' && recordedBy !== 'member') {
      bad('consent.recordedBy');
    }
    if (messaging === 'unknown') return Object.freeze({ messaging: 'unknown' });
    return Object.freeze({
      messaging: messaging as MessagingConsent,
      at,
      recordedBy: (recordedBy as 'contact' | 'member' | undefined) ?? 'member',
    });
  }

  function detailsOf(input: Record<string, unknown>): {
    displayName?: string | null;
    phone?: string | null;
    email?: string | null;
  } {
    const out: { displayName?: string | null; phone?: string | null; email?: string | null } = {};
    if (input.displayName !== undefined) {
      const name = typeof input.displayName === 'string' ? input.displayName.trim() : '';
      if (name === '' || name.length > MAX_DISPLAY_NAME_LENGTH) bad('displayName');
      out.displayName = name;
    }
    if (input.phone !== undefined) {
      if (input.phone === null || input.phone === '') out.phone = null;
      else out.phone = normalizePhone(input.phone) ?? bad('phone');
    }
    if (input.email !== undefined) {
      if (input.email === null || input.email === '') out.email = null;
      else out.email = normalizeEmail(input.email) ?? bad('email');
    }
    return out;
  }

  const withDetails = (contact: Contact, details: ReturnType<typeof detailsOf>): Contact => {
    const pick = (key: 'displayName' | 'phone' | 'email') => {
      const value = details[key] === undefined ? contact[key] : details[key];
      return value === null || value === undefined ? {} : { [key]: value };
    };
    const rest = Object.fromEntries(
      Object.entries(contact).filter(([key]) => !['displayName', 'phone', 'email'].includes(key)),
    );
    return { ...rest, ...pick('displayName'), ...pick('phone'), ...pick('email') } as Contact;
  };

  function checkKeys(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) if (!INPUT_KEYS.has(key)) bad(key);
  }

  return Object.freeze({
    async list(
      tenant: TenantContext,
      filter: { stage?: unknown; ownerId?: unknown } = {},
      page: PageInput = {},
    ) {
      const organizationId = await organizationOf(tenant, 'contact.read');
      if (
        filter.stage !== undefined &&
        !(CONTACT_STAGES as readonly unknown[]).includes(filter.stage)
      ) {
        bad('stage');
      }
      if (filter.ownerId !== undefined && !isUuid(filter.ownerId)) bad('ownerId');
      const limit = pageLimit('contacts', page.limit);
      const wanted: ContactPageFilter = {
        ...(filter.stage === undefined ? {} : { stage: filter.stage as ContactStage }),
        ...(filter.ownerId === undefined ? {} : { ownerId: filter.ownerId as UserId }),
      };
      const after = decodeCursor(page.cursor, organizationId, 'contacts', wanted);
      const [found, counts] = await Promise.all([
        repository.pageContacts(organizationId, {
          filter: wanted,
          limit,
          ...(after === undefined ? {} : { after }),
        }),
        repository.countContactStages(organizationId),
      ]);
      // Belt and braces: a record of another organization is never handed out.
      const items = found.items.filter((c) => c.organizationId === organizationId);
      return Object.freeze({
        items: Object.freeze(items),
        counts: Object.freeze({ ...counts }),
        hasMore: found.hasMore,
        nextCursor: nextCursorOf(found, contactPosition, organizationId, 'contacts', wanted),
      });
    },

    async get(tenant: TenantContext, id: string) {
      const organizationId = await organizationOf(tenant, 'contact.read');
      if (!isContactId(id)) throw new ConversationError('contact_not_found');
      const contact = await repository.findContact(organizationId, id);
      if (contact === undefined) throw new ConversationError('contact_not_found');
      const notes = await repository.listContactNotes(
        organizationId,
        id,
        CUSTOMER_LIMITS.notesShown,
      );
      return Object.freeze({ contact, notes: Object.freeze([...notes]) });
    },

    async create(tenant: TenantContext, input: Record<string, unknown>) {
      const organizationId = await managerOf(tenant);
      checkKeys(input);
      if (input.revision !== undefined) bad('revision');
      const details = detailsOf(input);
      if (details.displayName === undefined || details.displayName === null) bad('displayName');
      if (!details.phone && !details.email) bad('phone');
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const stage = input.stage ?? 'lead';
      if (!(CONTACT_STAGES as readonly unknown[]).includes(stage)) bad('stage');
      const source = input.source ?? { kind: 'manual' };
      const { kind, reference } = (source ?? {}) as Record<string, unknown>;
      if (!(CONTACT_SOURCE_KINDS as readonly unknown[]).includes(kind) || kind === 'channel') {
        bad('source.kind');
      }
      if (
        reference !== undefined &&
        (typeof reference !== 'string' || !REFERENCE.test(reference))
      ) {
        bad('source.reference');
      }
      const ownerId =
        input.ownerId === undefined || input.ownerId === null
          ? undefined
          : await ownerOf(organizationId, input.ownerId);
      const commercial: ContactCommercial = Object.freeze({
        stage: stage as ContactStage,
        ...(ownerId === undefined ? {} : { ownerId }),
        source: Object.freeze({
          kind: kind as ContactSourceKind,
          ...(reference === undefined ? {} : { reference: reference as string }),
        }),
        consent:
          input.consent === undefined
            ? Object.freeze({ messaging: 'unknown' as const })
            : consentOf(input.consent, iso),
        ...(input.nextAction === undefined || input.nextAction === null
          ? {}
          : { nextAction: nextActionOf(input.nextAction) }),
        stageChangedAt: iso,
      });
      const contact: Contact = Object.freeze({
        id: newId() as ContactId,
        organizationId,
        displayName: details.displayName as string,
        ...(details.phone ? { phone: details.phone } : {}),
        ...(details.email ? { email: details.email } : {}),
        status: 'active',
        origin: Object.freeze({ kind: 'user', userId: tenant.userId }),
        commercial,
        revision: 1,
        createdAt: iso,
        updatedAt: iso,
      });
      return repository.createContact(contact, [
        event(tenant, contact, 'contact.created', at, {
          transition: { from: 'none', to: commercial.stage },
          reason: `source_${commercial.source.kind}`,
        }),
      ]);
    },

    async update(tenant: TenantContext, id: string, input: Record<string, unknown>) {
      const organizationId = await managerOf(tenant);
      if (!isContactId(id)) throw new ConversationError('contact_not_found');
      checkKeys(input);
      const { revision } = input;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        bad('revision');
      }
      if (input.source !== undefined) bad('source');
      const details = detailsOf(input);
      if (details.displayName === null) bad('displayName');
      if (
        input.stage !== undefined &&
        !(CONTACT_STAGES as readonly unknown[]).includes(input.stage)
      ) {
        bad('stage');
      }
      const ownerId =
        input.ownerId === undefined
          ? undefined
          : input.ownerId === null
            ? null
            : await ownerOf(organizationId, input.ownerId);
      const nextAction =
        input.nextAction === undefined
          ? undefined
          : input.nextAction === null
            ? null
            : nextActionOf(input.nextAction);
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const consent = input.consent === undefined ? undefined : consentOf(input.consent, iso);

      return repository.updateContact(organizationId, id, (current) => {
        if ((current.revision ?? 0) !== revision) {
          throw new ConversationError('contact_concurrency_conflict');
        }
        const events: AuditEvent[] = [];
        let next = withDetails(current, details);
        if (next.status === 'archived') throw new ConversationError('contact_not_found');
        if (!next.phone && !next.email && current.origin.kind === 'user') bad('phone');
        const changedDetails = (['displayName', 'phone', 'email'] as const).filter(
          (key) => next[key] !== current[key],
        );
        if (changedDetails.length > 0) {
          events.push(event(tenant, current, 'contact.updated', at, { reason: 'details' }));
        }

        const before = current.commercial;
        const marking = before === undefined;
        if (
          marking &&
          input.stage === undefined &&
          (ownerId !== undefined || consent !== undefined || nextAction !== undefined)
        ) {
          // A contact becomes commercial only by being given a stage.
          bad('stage');
        }
        let commercial = before;
        if (input.stage !== undefined || !marking) {
          const stage = (input.stage as ContactStage | undefined) ?? before?.stage ?? 'lead';
          const base: Record<string, unknown> = {
            ...(before ?? {
              source: Object.freeze({
                kind: current.origin.kind === 'channel' ? 'channel' : 'manual',
              }),
              consent: Object.freeze({ messaging: 'unknown' }),
            }),
            stage,
            stageChangedAt: before?.stage === stage ? before.stageChangedAt : iso,
          };
          if (ownerId === null) delete base.ownerId;
          else if (ownerId !== undefined) base.ownerId = ownerId;
          // A next action that comes from a follow-up changes only through it (ADR-0058).
          if (
            nextAction !== undefined &&
            before?.nextAction?.followUpId !== undefined &&
            (nextAction?.text !== before.nextAction.text ||
              nextAction?.dueOn !== before.nextAction.dueOn)
          ) {
            throw new ConversationError('next_action_from_follow_up');
          }
          if (nextAction === null) delete base.nextAction;
          else if (nextAction !== undefined && before?.nextAction?.followUpId === undefined) {
            base.nextAction = nextAction;
          }
          if (consent !== undefined) base.consent = consent;
          commercial = Object.freeze(base) as unknown as ContactCommercial;

          if (before?.stage !== stage) {
            events.push(
              event(tenant, current, 'contact.stage_changed', at, {
                transition: { from: before?.stage ?? 'none', to: stage },
              }),
            );
          }
          if (before?.ownerId !== commercial.ownerId) {
            events.push(
              event(tenant, current, 'contact.owner_changed', at, {
                reason: commercial.ownerId === undefined ? 'cleared' : 'assigned',
              }),
            );
          }
          if ((before?.consent.messaging ?? 'unknown') !== commercial.consent.messaging) {
            events.push(
              event(tenant, current, 'contact.consent_changed', at, {
                transition: {
                  from: before?.consent.messaging ?? 'unknown',
                  to: commercial.consent.messaging,
                },
              }),
            );
          }
          if (
            before?.nextAction?.text !== commercial.nextAction?.text ||
            before?.nextAction?.dueOn !== commercial.nextAction?.dueOn
          ) {
            events.push(
              event(tenant, current, 'contact.updated', at, {
                reason: commercial.nextAction === undefined ? 'next_action_cleared' : 'next_action',
              }),
            );
          }
        }
        if (events.length === 0) return { contact: current, events };
        next = Object.freeze({
          ...next,
          ...(commercial === undefined ? {} : { commercial }),
          revision: (current.revision ?? 0) + 1,
          updatedAt: iso,
        });
        return { contact: next, events };
      });
    },

    async addNote(tenant: TenantContext, id: string, text: unknown) {
      const organizationId = await managerOf(tenant);
      if (!isContactId(id)) throw new ConversationError('contact_not_found');
      if (
        typeof text !== 'string' ||
        text.trim() === '' ||
        text.length > CUSTOMER_LIMITS.noteLength
      ) {
        bad('text');
      }
      const contact = await repository.findContact(organizationId, id);
      if (contact === undefined) throw new ConversationError('contact_not_found');
      const at = now();
      const note: ContactNote = Object.freeze({
        id: newId(),
        organizationId,
        contactId: contact.id,
        text: (text as string).trim(),
        createdBy: tenant.userId,
        createdAt: at.toISOString() as IsoTimestamp,
      });
      await repository.addContactNote(note, [event(tenant, contact, 'contact.note_added', at)]);
      return note;
    },

    async counts(tenant: TenantContext) {
      const organizationId = await organizationOf(tenant, 'contact.read');
      return Object.freeze({ ...(await repository.countContactStages(organizationId)) });
    },
  });
}
