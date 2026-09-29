import type { AuditEvent, AuditHistoryReader } from '@melonoffice/audit';
import { customerKnowledge, type CompanyBrainService } from '@melonoffice/brain';
import {
  isConversationError,
  type ConversationErrorCode,
  type CustomerService,
  type OpportunityService,
} from '@melonoffice/conversations';
import type {
  Contact,
  ContactNote,
  Conversation,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { toConversationView, toHistoryView, toOpportunityView } from './opportunities.js';
import { pageOf } from './pages.js';

const STATUS: Partial<Record<ConversationErrorCode, ContentfulStatusCode>> = {
  invalid_request: 400,
  unresolved_tenant: 403,
  permission_denied: 403,
  requires_user: 403,
  organization_inactive: 403,
  contact_not_found: 404,
  duplicate_contact: 409,
  owner_not_member: 409,
  contact_concurrency_conflict: 409,
  next_action_from_follow_up: 409,
};

/** A contact as the customers screen shows it. The owner is `you`, `member` or absent. */
export function toCustomerView(contact: Contact, viewer: UserId) {
  const c = contact.commercial;
  return {
    id: contact.id,
    displayName: contact.displayName ?? null,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    origin: contact.origin.kind,
    revision: contact.revision ?? 0,
    commercial:
      c === undefined
        ? null
        : {
            stage: c.stage,
            owner: c.ownerId === undefined ? null : c.ownerId === viewer ? 'you' : 'member',
            source: c.source.kind,
            consent: c.consent.messaging,
            consentAt: c.consent.at ?? null,
            nextAction: c.nextAction ?? null,
            stageChangedAt: c.stageChangedAt,
          },
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

/**
 * How much of a contact's commercial context its card shows (C3, ADR-0055): its latest
 * conversations, its opportunities (the history of the most recent ones) and the merged history.
 */
const SHOWN = Object.freeze({
  conversations: 20,
  opportunities: 20,
  historyOf: 10,
  historyEach: 20,
  history: 40,
});

const toNoteView = (note: ContactNote, viewer: UserId) => ({
  id: note.id,
  text: note.text,
  author: note.createdBy === viewer ? 'you' : 'member',
  createdAt: note.createdAt,
});

/**
 * Customers and leads (C1, ADR-0053), under `/v1/organizations/:id/customers`: the organization's
 * contacts with a commercial stage. A contact is the one the conversations already use; marking a
 * WhatsApp contact as a lead is a `PATCH` on it. After a change that moves the totals, Company
 * Brain's customer counts are refreshed (best effort: the change stands if that fails).
 */
export function registerCustomerRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly customers: CustomerService;
    readonly brain?: Pick<CompanyBrainService, 'ingest'>;
    /** The contact's commercial context on its card (C3): each part only to a role that reads it. */
    readonly context?: {
      readonly authorization: Pick<AuthorizationService, 'authorize'>;
      readonly opportunities: Pick<OpportunityService, 'list' | 'pipeline'>;
      readonly conversations: {
        listConversations(organizationId: OrganizationId): Promise<readonly Conversation[]>;
      };
      readonly history?: AuditHistoryReader;
    };
  },
): void {
  const { customers, brain, context } = dependencies;
  const base = '/v1/organizations/:organizationId/customers';

  async function answer(c: Context<AuthEnv>, work: () => Promise<unknown>): Promise<Response> {
    try {
      return c.json((await work()) as object);
    } catch (error) {
      if (!isConversationError(error)) throw error;
      const status = STATUS[error.code];
      if (status === undefined) throw error;
      if (error.code === 'duplicate_contact') {
        return c.json({ error: error.code, contactId: error.detail ?? null }, status);
      }
      return c.json(
        { error: error.code, ...(error.detail === undefined ? {} : { field: error.detail }) },
        status,
      );
    }
  }

  const bodyOf = async (c: Context<AuthEnv>): Promise<Record<string, unknown> | undefined> => {
    const body: unknown = await c.req.json().catch(() => undefined);
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  };

  async function refreshBrain(c: Context<AuthEnv>, tenant: TenantContext): Promise<void> {
    if (brain === undefined) return;
    try {
      const { source, facts } = customerKnowledge(await customers.counts(tenant));
      await brain.ingest(tenant, source, facts);
    } catch (error) {
      c.get('logger').warn('customers.brain_refresh_failed', {
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }

  /**
   * The rest of the contact's story, read where it already lives (C3): its conversations, its
   * opportunities with their stage, and the history of both from the audit trail. A part the
   * reader may not see is `null`, never an empty list that would read as "none".
   */
  async function contextOf(tenant: TenantContext, contact: Contact) {
    if (context === undefined) return { conversations: null, opportunities: null, history: null };
    const may = (permission: Parameters<AuthorizationService['authorize']>[1]) =>
      context.authorization.authorize(tenant, permission).allowed;
    const readsConversations = may('conversation.read');
    const readsOpportunities = may('opportunity.read');
    const [allConversations, own, pipeline] = await Promise.all([
      readsConversations
        ? context.conversations.listConversations(tenant.organizationId)
        : Promise.resolve(undefined),
      readsOpportunities
        ? context.opportunities.list(tenant, { contactId: contact.id })
        : Promise.resolve(undefined),
      readsOpportunities
        ? context.opportunities.pipeline(tenant).then((p) => p.pipeline)
        : Promise.resolve(undefined),
    ]);
    const conversations = allConversations
      ?.filter((conv) => conv.contactId === contact.id)
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
      .slice(0, SHOWN.conversations);
    const opportunities = own?.items
      .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, SHOWN.opportunities);
    const history = context.history;
    let events: { event: AuditEvent; opportunityId: string | null }[] | null = null;
    if (history !== undefined) {
      const reads = [
        history
          .history(tenant.organizationId, { type: 'contact', id: contact.id }, SHOWN.historyEach)
          .then((list) => list.map((event) => ({ event, opportunityId: null }))),
        ...(opportunities ?? [])
          .slice(0, SHOWN.historyOf)
          .map((o) =>
            history
              .history(tenant.organizationId, { type: 'opportunity', id: o.id }, SHOWN.historyEach)
              .then((list) => list.map((event) => ({ event, opportunityId: o.id as string }))),
          ),
      ];
      events = (await Promise.all(reads))
        .flat()
        .sort((a, b) => (a.event.occurredAt < b.event.occurredAt ? 1 : -1))
        .slice(0, SHOWN.history);
    }
    return {
      conversations: conversations?.map(toConversationView) ?? null,
      opportunities:
        opportunities?.map((o) => {
          const stage = pipeline?.stages.find((s) => s.id === o.stageId);
          return {
            ...toOpportunityView(o, tenant.userId),
            stage:
              stage === undefined
                ? null
                : {
                    id: stage.id,
                    kind: stage.kind,
                    name: stage.name ?? null,
                    nameKey: stage.nameKey ?? null,
                  },
          };
        }) ?? null,
      history:
        events?.map(({ event, opportunityId }) => ({
          ...toHistoryView(event, tenant.userId),
          opportunityId,
        })) ?? null,
    };
  }

  app.get(
    base,
    withPermission('contact.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const stage = c.req.query('stage');
        const owner = c.req.query('owner');
        const list = await customers.list(
          tenant,
          {
            ...(stage === undefined ? {} : { stage }),
            ...(owner === undefined ? {} : { ownerId: owner === 'me' ? tenant.userId : owner }),
          },
          pageOf(c),
        );
        return {
          items: list.items.map((contact) => toCustomerView(contact, tenant.userId)),
          counts: list.counts,
          hasMore: list.hasMore,
          nextCursor: list.nextCursor,
        };
      }),
    ),
  );

  app.get(
    `${base}/:contactId`,
    withPermission('contact.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const { contact, notes } = await customers.get(tenant, c.req.param('contactId') ?? '');
        return {
          ...toCustomerView(contact, tenant.userId),
          notes: notes.map((n) => toNoteView(n, tenant.userId)),
          ...(await contextOf(tenant, contact)),
        };
      }),
    ),
  );

  app.post(
    base,
    withPermission('contact.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const contact = await customers.create(tenant, body);
        await refreshBrain(c, tenant);
        return toCustomerView(contact, tenant.userId);
      });
    }),
  );

  app.patch(
    `${base}/:contactId`,
    withPermission('contact.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const contact = await customers.update(tenant, c.req.param('contactId') ?? '', body);
        await refreshBrain(c, tenant);
        return toCustomerView(contact, tenant.userId);
      });
    }),
  );

  app.post(
    `${base}/:contactId/notes`,
    withPermission('contact.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined || Object.keys(body).some((k) => k !== 'text')) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () =>
        toNoteView(
          await customers.addNote(tenant, c.req.param('contactId') ?? '', body.text),
          tenant.userId,
        ),
      );
    }),
  );
}
