import { isAIUsageError, MAX_EVENTS_PAGE, type AIUsageLedger } from '@melonoffice/ai-usage';
import type { AIUsageBucket, AIUsageEvent, AIUsageSummary } from '@melonoffice/domain';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * AI usage routes (ADR-0074): what the organization's AI use cost, over whole UTC days, in total
 * and by every dimension, and its operations one page at a time. Read only: nothing here records
 * or charges. Tenancy picks the organization from the caller's membership and RBAC checks
 * `ai_usage.read`.
 *
 * A company sees what its AI use charged it (credits) and where it went (capability, department,
 * agent, workflow, task), never which provider or model MelonMotor used nor what that cost
 * MelonOffice internally: those are the platform administrator's (`/v1/platform/ai-usage`).
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE = 50;

/** `occurredAt|eventId`, as the last event of a page. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,128})$/;

export function registerAIUsageRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly ledger: AIUsageLedger;
    readonly now?: () => Date;
  },
): void {
  const { ledger } = dependencies;
  const today = () => (dependencies.now?.() ?? new Date()).toISOString().slice(0, 10);

  app.get(
    '/v1/organizations/:organizationId/ai-usage',
    withPermission('ai_usage.read', dependencies, async (c, tenant) => {
      const from = c.req.query('from') ?? today();
      const to = c.req.query('to') ?? from;
      if (!DAY.test(from) || !DAY.test(to)) return c.json({ error: 'invalid_request' }, 400);
      try {
        return c.json(tenantSummary(await ledger.summary(tenant.organizationId, from, to)));
      } catch (error) {
        if (isAIUsageError(error)) return c.json({ error: 'invalid_request' }, 400);
        throw error;
      }
    }),
  );

  app.get(
    '/v1/organizations/:organizationId/ai-usage/events',
    withPermission('ai_usage.read', dependencies, async (c, tenant) => {
      const rawLimit = c.req.query('limit');
      const limit = rawLimit === undefined ? DEFAULT_PAGE : Number(rawLimit);
      if (!/^\d{1,3}$/.test(rawLimit ?? '0') || limit < 1 || limit > MAX_EVENTS_PAGE) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const cursor = c.req.query('cursor');
      const match = cursor === undefined ? undefined : CURSOR.exec(cursor);
      if (cursor !== undefined && match === null) return c.json({ error: 'invalid_request' }, 400);
      const page = await ledger.events(tenant.organizationId, {
        limit,
        ...(match?.[1] === undefined || match[2] === undefined
          ? {}
          : { before: { at: match[1], id: match[2] } }),
      });
      const last = page.items.at(-1);
      return c.json({
        events: page.items.map(tenantEvent),
        nextCursor: page.hasMore && last !== undefined ? `${last.occurredAt}|${last.id}` : null,
      });
    }),
  );
}

/** The dimensions a company sees: where its AI use went, never how MelonMotor served it. */
export const TENANT_USAGE_DIMENSIONS = Object.freeze([
  'capability',
  'actor',
  'user',
  'agent',
  'department',
  'workflow',
  'task_type',
] as const);

const tenantBucket = (b: AIUsageBucket) => ({ operations: b.operations, credits: b.credits });

/** A summary without provider, model or MelonOffice's internal cost. */
export function tenantSummary(summary: AIUsageSummary) {
  return {
    from: summary.from,
    to: summary.to,
    totals: tenantBucket(summary.totals),
    by: Object.fromEntries(
      TENANT_USAGE_DIMENSIONS.map((dimension) => [
        dimension,
        Object.fromEntries(
          Object.entries(summary.by[dimension] ?? {}).map(([key, bucket]) => [
            key,
            tenantBucket(bucket),
          ]),
        ),
      ]),
    ),
    quantities: summary.quantities,
  };
}

/** An operation as a company sees it: what it was for and what it charged. */
export function tenantEvent(event: AIUsageEvent) {
  const a = event.attribution;
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    capability: event.capability,
    outcome: event.outcome,
    credits: event.credits,
    attribution: {
      actor: a.actor,
      ...(a.userId === undefined ? {} : { userId: a.userId }),
      ...(a.specialistId === undefined ? {} : { specialistId: a.specialistId }),
      ...(a.departmentId === undefined ? {} : { departmentId: a.departmentId }),
      ...(a.workflowId === undefined ? {} : { workflowId: a.workflowId }),
      ...(a.executionId === undefined ? {} : { executionId: a.executionId }),
      ...(a.taskType === undefined ? {} : { taskType: a.taskType }),
    },
  };
}
