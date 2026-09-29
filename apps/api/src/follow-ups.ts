import { followUpKnowledge, type CompanyBrainService } from '@melonoffice/brain';
import {
  isConversationError,
  localDateTime,
  timingOf,
  type ConversationErrorCode,
  type FollowUpService,
} from '@melonoffice/conversations';
import type { FollowUp, UserId } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { contactNames, pageOf, type ContactsById } from './pages.js';

const STATUS: Partial<Record<ConversationErrorCode, ContentfulStatusCode>> = {
  invalid_request: 400,
  unresolved_tenant: 403,
  permission_denied: 403,
  requires_user: 403,
  organization_inactive: 403,
  contact_not_found: 404,
  opportunity_not_found: 404,
  follow_up_not_found: 404,
  owner_not_member: 409,
  opportunity_closed: 409,
  duplicate_request: 409,
  follow_up_closed: 409,
  follow_up_concurrency_conflict: 409,
  follow_up_limit_reached: 409,
  follow_up_not_scheduled: 503,
  follow_up_scheduler_unavailable: 503,
  follow_up_tool_unavailable: 503,
};

const who = (id: UserId | undefined, viewer: UserId) =>
  id === undefined ? null : id === viewer ? 'you' : 'member';

/**
 * A follow-up as the screens show it, with its local date and time in its own time zone and how
 * it stands today. Another member is `member`, never their id.
 */
export function toFollowUpView(f: FollowUp, viewer: UserId, today: string) {
  const timing = timingOf(f, today);
  return {
    id: f.id,
    contactId: f.contactId,
    opportunityId: f.opportunityId ?? null,
    assignee: who(f.assignedTo, viewer),
    type: f.type,
    title: f.title,
    description: f.description ?? null,
    scheduledAt: f.scheduledAt,
    timeZone: f.timeZone,
    date: timing.date,
    time: timing.time,
    when: timing.when,
    days: timing.days,
    status: f.status,
    source: f.source,
    history: f.history.map((h) => ({
      from: h.from,
      to: h.to,
      status: h.status,
      at: h.at,
      by: who(h.by, viewer),
    })),
    dueAt: f.dueAt ?? null,
    completedAt: f.completedAt ?? null,
    completedBy: who(f.completedBy, viewer),
    cancelledAt: f.cancelledAt ?? null,
    cancelledBy: who(f.cancelledBy, viewer),
    cancelReason: f.cancelReason ?? null,
    failure: f.failure ?? null,
    createdBy: who(f.createdBy, viewer),
    revision: f.revision,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/**
 * Follow-ups (C5, ADR-0058), under `/v1/organizations/:id/follow-ups`. Every change is a person's
 * (`follow_up.manage`); a GIA proposal reaches here only when the person confirms it. After a
 * change, Company Brain's follow-up totals are refreshed (best effort: the change stands if that
 * fails). Nothing here sends anything to a contact.
 */
export function registerFollowUpRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly followUps: FollowUpService;
    readonly authorization: Pick<AuthorizationService, 'authorize'>;
    readonly contacts?: ContactsById;
    readonly brain?: Pick<CompanyBrainService, 'ingest'>;
  },
): void {
  const { followUps, contacts, brain, authorization } = dependencies;
  const base = '/v1/organizations/:organizationId/follow-ups';

  async function answer(
    c: Context<AuthEnv>,
    work: () => Promise<{ body: object; status?: 200 | 201 }>,
  ): Promise<Response> {
    try {
      const { body, status = 200 } = await work();
      return c.json(body, status);
    } catch (error) {
      if (!isConversationError(error)) throw error;
      const status = STATUS[error.code];
      if (status === undefined) throw error;
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
      const { counts } = await followUps.list(tenant);
      const { source, facts } = followUpKnowledge(counts);
      await brain.ingest(tenant, source, facts);
    } catch (error) {
      c.get('logger').warn('follow_ups.brain_refresh_failed', {
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }

  /** One follow-up's view: "today" is read in its own time zone. */
  const viewOf = (f: FollowUp, viewer: UserId) =>
    toFollowUpView(f, viewer, localDateTime(new Date(), f.timeZone).date);

  app.get(
    base,
    withPermission('follow_up.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const q = (name: string) => c.req.query(name);
        const list = await followUps.list(
          tenant,
          {
            ...(q('status') === undefined ? {} : { status: q('status') }),
            ...(q('contact') === undefined ? {} : { contactId: q('contact') }),
            ...(q('opportunity') === undefined ? {} : { opportunityId: q('opportunity') }),
            ...(q('assignee') === undefined ? {} : { assignee: q('assignee') }),
            ...(q('open') === undefined ? {} : { open: q('open') }),
          },
          pageOf(c),
        );
        // The contacts' names, only to someone who may read contacts: this page's, no more.
        const names =
          contacts !== undefined && authorization.authorize(tenant, 'contact.read').allowed
            ? contactNames(
                await contacts.findContacts(
                  tenant.organizationId,
                  list.items.map((f) => f.contactId),
                ),
              )
            : undefined;
        return {
          body: {
            timeZone: list.timeZone,
            today: list.today,
            counts: list.counts,
            items: list.items.map((f) => ({
              ...toFollowUpView(f, tenant.userId, list.today),
              contactName: names?.get(f.contactId) ?? null,
            })),
            hasMore: list.hasMore,
            nextCursor: list.nextCursor,
          },
        };
      }),
    ),
  );

  app.get(
    `${base}/:followUpId`,
    withPermission('follow_up.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const found = await followUps.get(tenant, c.req.param('followUpId') ?? '');
        return { body: viewOf(found, tenant.userId) };
      }),
    ),
  );

  app.post(
    base,
    withPermission('follow_up.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const { followUp, created } = await followUps.create(tenant, body);
        if (created) await refreshBrain(c, tenant);
        return {
          body: { ...viewOf(followUp, tenant.userId), created },
          status: created ? 201 : 200,
        };
      });
    }),
  );

  const change = (
    path: string,
    method: 'patch' | 'post',
    run: (tenant: TenantContext, id: string, body: Record<string, unknown>) => Promise<FollowUp>,
  ) =>
    app[method](
      path,
      withPermission('follow_up.manage', dependencies, async (c, tenant) => {
        const body = await bodyOf(c);
        if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
        return answer(c, async () => {
          const changed = await run(tenant, c.req.param('followUpId') ?? '', body);
          await refreshBrain(c, tenant);
          return { body: viewOf(changed, tenant.userId) };
        });
      }),
    );

  change(`${base}/:followUpId`, 'patch', (t, id, b) => followUps.update(t, id, b));
  change(`${base}/:followUpId/reschedule`, 'post', (t, id, b) => followUps.reschedule(t, id, b));
  change(`${base}/:followUpId/complete`, 'post', (t, id, b) => followUps.complete(t, id, b));
  change(`${base}/:followUpId/cancel`, 'post', (t, id, b) => followUps.cancel(t, id, b));
}
