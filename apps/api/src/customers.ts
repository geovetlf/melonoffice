import { customerKnowledge, type CompanyBrainService } from '@melonoffice/brain';
import {
  isConversationError,
  type ConversationErrorCode,
  type CustomerService,
} from '@melonoffice/conversations';
import type { Contact, ContactNote, UserId } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

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
  },
): void {
  const { customers, brain } = dependencies;
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

  app.get(
    base,
    withPermission('contact.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const stage = c.req.query('stage');
        const owner = c.req.query('owner');
        const list = await customers.list(tenant, {
          ...(stage === undefined ? {} : { stage }),
          ...(owner === undefined ? {} : { ownerId: owner === 'me' ? tenant.userId : owner }),
        });
        return {
          items: list.items.map((contact) => toCustomerView(contact, tenant.userId)),
          counts: list.counts,
          hasMore: list.hasMore,
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
