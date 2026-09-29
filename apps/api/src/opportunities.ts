import type { AuditEvent, AuditHistoryReader } from '@melonoffice/audit';
import { pipelineKnowledge, type CompanyBrainService } from '@melonoffice/brain';
import {
  isConversationError,
  type ConversationErrorCode,
  type OpportunityService,
} from '@melonoffice/conversations';
import type {
  Conversation,
  Opportunity,
  OrganizationId,
  Pipeline,
  UserId,
} from '@melonoffice/domain';
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
  stage_not_found: 409,
  stage_in_use: 409,
  owner_not_member: 409,
  opportunity_closed: 409,
  opportunity_concurrency_conflict: 409,
  pipeline_concurrency_conflict: 409,
  contact_concurrency_conflict: 409,
  next_action_from_follow_up: 409,
};

/** How many history entries and conversations one opportunity shows. */
const SHOWN = Object.freeze({ history: 50, conversations: 20 });

const toPipelineView = (pipeline: Pipeline, stored: boolean) => ({
  id: pipeline.id,
  template: pipeline.template,
  revision: pipeline.revision,
  stored,
  stages: pipeline.stages.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name ?? null,
    nameKey: s.nameKey ?? null,
    probability: s.probability,
  })),
});

/** An opportunity as the screens show it. The responsible person is `you`, `member` or none. */
export function toOpportunityView(o: Opportunity, viewer: UserId) {
  return {
    id: o.id,
    contactId: o.contactId,
    stageId: o.stageId,
    status: o.status,
    title: o.title,
    value: o.value ?? null,
    probability: o.probability,
    owner: o.ownerId === undefined ? null : o.ownerId === viewer ? 'you' : 'member',
    expectedCloseOn: o.expectedCloseOn ?? null,
    nextAction: o.nextAction ?? null,
    lostReason: o.lostReason ?? null,
    closedAt: o.closedAt ?? null,
    stageChangedAt: o.stageChangedAt,
    revision: o.revision,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** One entry of an opportunity's history: what happened, when and who, never another's id. */
export const toHistoryView = (event: AuditEvent, viewer: UserId) => ({
  id: event.id,
  at: event.occurredAt,
  action: event.action,
  transition: event.transition ?? null,
  reason: event.reason ?? null,
  actor:
    event.actor.type === 'user'
      ? event.actor.via === 'gia'
        ? 'gia'
        : event.actor.userId === viewer
          ? 'you'
          : 'member'
      : 'system',
});

export const toConversationView = (c: Conversation) => ({
  id: c.id,
  channel: c.channel,
  status: c.status,
  lastMessageAt: c.lastMessageAt,
});

/**
 * Opportunities and the pipeline (C2, ADR-0054), under `/v1/organizations/:id`. An opportunity's
 * page also shows its contact's conversations (to a reader of conversations) and its history,
 * read from the audit trail. After a change that moves the totals, Company Brain's pipeline facts
 * are refreshed (best effort: the change stands if that fails).
 */
export function registerOpportunityRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly opportunities: OpportunityService;
    readonly authorization: Pick<AuthorizationService, 'authorize'>;
    readonly history?: AuditHistoryReader;
    readonly conversations?: {
      listConversations(organizationId: OrganizationId): Promise<readonly Conversation[]>;
    } & ContactsById;
    readonly brain?: Pick<CompanyBrainService, 'ingest'>;
  },
): void {
  const { opportunities, history, conversations, brain, authorization } = dependencies;
  const base = '/v1/organizations/:organizationId';

  async function answer(c: Context<AuthEnv>, work: () => Promise<unknown>): Promise<Response> {
    try {
      return c.json((await work()) as object);
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
      const { source, facts } = pipelineKnowledge(await opportunities.summary(tenant));
      await brain.ingest(tenant, source, facts);
    } catch (error) {
      c.get('logger').warn('opportunities.brain_refresh_failed', {
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }

  app.get(
    `${base}/pipeline`,
    withPermission('opportunity.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const { pipeline, stored } = await opportunities.pipeline(tenant);
        return toPipelineView(pipeline, stored);
      }),
    ),
  );

  app.put(
    `${base}/pipeline`,
    withPermission('pipeline.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () =>
        toPipelineView(await opportunities.savePipeline(tenant, body), true),
      );
    }),
  );

  app.get(
    `${base}/opportunities`,
    withPermission('opportunity.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const q = (name: string) => c.req.query(name);
        const owner = q('owner');
        const list = await opportunities.list(
          tenant,
          {
            ...(q('status') === undefined ? {} : { status: q('status') }),
            ...(q('stage') === undefined ? {} : { stageId: q('stage') }),
            ...(q('contact') === undefined ? {} : { contactId: q('contact') }),
            ...(owner === undefined ? {} : { ownerId: owner === 'me' ? tenant.userId : owner }),
          },
          pageOf(c),
        );
        // The contacts' names, only to someone who may read contacts: this page's, no more.
        const names =
          conversations !== undefined && authorization.authorize(tenant, 'contact.read').allowed
            ? contactNames(
                await conversations.findContacts(
                  tenant.organizationId,
                  list.items.map((o) => o.contactId),
                ),
              )
            : undefined;
        return {
          items: list.items.map((o) => ({
            ...toOpportunityView(o, tenant.userId),
            contactName: names?.get(o.contactId) ?? null,
          })),
          summary: list.summary,
          hasMore: list.hasMore,
          nextCursor: list.nextCursor,
        };
      }),
    ),
  );

  app.get(
    `${base}/opportunities/:opportunityId`,
    withPermission('opportunity.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const { opportunity, contact, pipeline } = await opportunities.get(
          tenant,
          c.req.param('opportunityId') ?? '',
        );
        // The contact's conversations, only to someone who may read conversations.
        const readsConversations =
          conversations !== undefined &&
          authorization.authorize(tenant, 'conversation.read').allowed;
        const own = readsConversations
          ? (await conversations.listConversations(tenant.organizationId))
              .filter((conv) => conv.contactId === contact.id)
              .slice(0, SHOWN.conversations)
          : undefined;
        const events =
          history === undefined
            ? []
            : await history.history(
                tenant.organizationId,
                { type: 'opportunity', id: opportunity.id },
                SHOWN.history,
              );
        return {
          ...toOpportunityView(opportunity, tenant.userId),
          contact: {
            id: contact.id,
            displayName: contact.displayName ?? null,
            stage: contact.commercial?.stage ?? null,
          },
          stage: pipeline.stages.find((s) => s.id === opportunity.stageId) ?? null,
          conversations: own === undefined ? null : own.map(toConversationView),
          history: events.map((e) => toHistoryView(e, tenant.userId)),
        };
      }),
    ),
  );

  app.post(
    `${base}/opportunities`,
    withPermission('opportunity.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const created = await opportunities.create(tenant, body);
        await refreshBrain(c, tenant);
        return toOpportunityView(created, tenant.userId);
      });
    }),
  );

  app.patch(
    `${base}/opportunities/:opportunityId`,
    withPermission('opportunity.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const changed = await opportunities.update(
          tenant,
          c.req.param('opportunityId') ?? '',
          body,
        );
        await refreshBrain(c, tenant);
        return toOpportunityView(changed, tenant.userId);
      });
    }),
  );
}
