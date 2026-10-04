import {
  AUDIT_ACTIONS,
  MAX_HISTORY_EVENTS,
  MAX_QUERY_ACTIONS,
  type AuditAction,
  type AuditActionDefinition,
  type AuditEvent,
  type AuditHistoryReader,
  type AuditReader,
} from '@melonoffice/audit';
import type { UserId } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { ActivityError } from './errors.js';
import { dayRange, isTimeZone } from './period.js';

/**
 * The audit trail viewer (ADR-0147): the organization's audit events, newest first, a page at a
 * time, read only. It is the same read side as the activity view (ADR-0049) and a record's
 * history (ADR-0054), over the same store: nothing here writes, edits or removes an event.
 *
 * Every event is shown through an allow-list of structured fields, each a code: request ids,
 * idempotency keys, credit references, lease ids, the organization a client asked for and the
 * partner account are never shown. Nothing free-form exists in an event to leak.
 */

/** How many events one page shows. */
export const AUDIT_TRAIL_PAGE_SIZE = 25;

export type AuditCategory = AuditActionDefinition['category'];

/**
 * Plumbing recorded on every request or job: tenant resolution, permission checks, job leases,
 * node changes and delivery attempts. Left out of "everything" so the trail stays readable;
 * shown under its own filter.
 */
export const TECHNICAL_ACTIONS: readonly AuditAction[] = Object.freeze([
  'tenancy.resolve',
  'authorization.check',
  'tool.authorization_checked',
  'execution.node_changed',
  'execution.job_released',
  'execution.job_enqueued',
  'execution.job_leased',
  'execution.job_finished',
  'execution.job_cancelled',
  'channel.delivery_attempted',
  'channel.delivery_retry_scheduled',
  'channel.delivery_rate_limited',
]);

/** What a person may filter on: a category of the catalogue, or the technical events. */
export type AuditTrailFilter = AuditCategory | 'technical';

const ALL_ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[];
const categoryOf = (action: AuditAction): AuditCategory => AUDIT_ACTIONS[action].category;

/** The categories that have at least one action outside the technical ones, in catalogue order. */
export const AUDIT_TRAIL_CATEGORIES: readonly AuditCategory[] = Object.freeze([
  ...new Set(ALL_ACTIONS.filter((a) => !TECHNICAL_ACTIONS.includes(a)).map(categoryOf)),
]);

/** Every filter, technical events last. */
export const AUDIT_TRAIL_FILTERS: readonly AuditTrailFilter[] = Object.freeze([
  ...AUDIT_TRAIL_CATEGORIES,
  'technical',
]);

const isFilter = (value: unknown): value is AuditTrailFilter =>
  value === 'technical' ||
  (typeof value === 'string' && (AUDIT_TRAIL_CATEGORIES as readonly string[]).includes(value));

/** The actions a filter reads; none means everything but the technical events. */
export function actionsOf(filter: AuditTrailFilter | undefined): readonly AuditAction[] {
  if (filter === 'technical') return TECHNICAL_ACTIONS;
  const shown = ALL_ACTIONS.filter((a) => !TECHNICAL_ACTIONS.includes(a));
  return filter === undefined ? shown : shown.filter((a) => categoryOf(a) === filter);
}

/** Who acted, as the person reading understands it. Never another user's id or email. */
export interface AuditTrailActor {
  readonly kind: 'you' | 'member' | 'gia' | 'agent' | 'contact' | 'system' | 'platform_admin';
  /** For GIA and agents: whose work it was, `you` or another `member`. */
  readonly onBehalfOf?: 'you' | 'member';
}

/** One event as the viewer shows it. Every value is a code or a number. */
export interface AuditTrailItem {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly category: AuditCategory;
  readonly result: 'success' | 'denied' | 'failure';
  readonly actor: AuditTrailActor;
  /** What it is about: its type always; its id only where the app opens it (`link`). */
  readonly target?: {
    readonly type: string;
    readonly link?: { readonly kind: 'conversation' | 'follow_up' | 'plan'; readonly id: string };
  };
  readonly details: {
    readonly reason?: string;
    readonly version?: number;
    readonly transition?: { readonly from: string; readonly to: string };
    readonly tool?: string;
    readonly step?: string;
    readonly permission?: string;
    readonly model?: string;
    readonly decision?: string;
  };
}

export interface AuditTrailPage {
  readonly from: string;
  readonly to: string;
  readonly fromDay: string;
  readonly toDay: string;
  readonly timeZone: string;
  readonly filter: AuditTrailFilter | null;
  /** What may be filtered on, so the screen never keeps its own list. */
  readonly filters: readonly AuditTrailFilter[];
  readonly items: readonly AuditTrailItem[];
  /** Pass back as `cursor` for the next, older page; null when there is none. */
  readonly nextCursor: string | null;
}

export interface AuditTrailService {
  /**
   * `activity.read`, by a person acting directly: GIA and the runtime do not read the trail.
   * Only the tenant's organization is read, whatever is asked. With `target`, the history of
   * that one record (at most `MAX_HISTORY_EVENTS`, the history reader's own limit).
   */
  page(
    tenant: TenantContext,
    input: {
      readonly filter?: unknown;
      readonly from?: unknown;
      readonly to?: unknown;
      readonly cursor?: unknown;
      readonly target?: unknown;
      readonly timeZone: unknown;
    },
  ): Promise<AuditTrailPage>;
}

/** A code shown as it is: lowercase words, digits and `_ . : -`. Anything else is not shown. */
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const code = (value: string | undefined): string | undefined =>
  value !== undefined && CODE.test(value) ? value : undefined;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET = /^([a-z_]{1,40}):([A-Za-z0-9_-]{1,128})$/;
const CONVERSATION_REFERENCE = /^conversation:([A-Za-z0-9_-]{1,128})$/;

function actorOf(event: AuditEvent, viewer: UserId): AuditTrailActor {
  if (event.actorRole === 'platform_admin') return { kind: 'platform_admin' };
  const actor = event.actor;
  const whose = (userId: UserId): 'you' | 'member' => (userId === viewer ? 'you' : 'member');
  if (actor.type === 'user') {
    return actor.via === 'gia'
      ? { kind: 'gia', onBehalfOf: whose(actor.userId) }
      : { kind: whose(actor.userId) };
  }
  if (actor.type === 'system') {
    // The scheduler marking a follow-up due is the system, not an agent (C5).
    return event.action.startsWith('follow_up.')
      ? { kind: 'system' }
      : { kind: 'agent', onBehalfOf: whose(actor.initiatedBy) };
  }
  // Only a verified channel records an anonymous actor: the contact wrote.
  return { kind: event.action === 'conversation.message_received' ? 'contact' : 'system' };
}

function targetOf(event: AuditEvent): AuditTrailItem['target'] {
  const target = event.target;
  const conversation = CONVERSATION_REFERENCE.exec(event.reference ?? '')?.[1];
  if (target === undefined) {
    return conversation === undefined
      ? undefined
      : { type: 'conversation', link: { kind: 'conversation', id: conversation } };
  }
  const opens =
    target.type === 'conversation' || target.type === 'follow_up' || target.type === 'plan';
  return opens && ID.test(target.id)
    ? { type: target.type, link: { kind: target.type, id: target.id } }
    : { type: target.type };
}

/** One event through the allow-list. */
export function toAuditTrailItem(event: AuditEvent, viewer: UserId): AuditTrailItem {
  const transition =
    event.transition !== undefined &&
    code(event.transition.from) !== undefined &&
    code(event.transition.to) !== undefined
      ? { from: event.transition.from, to: event.transition.to }
      : undefined;
  const details = {
    ...(code(event.reason) === undefined ? {} : { reason: event.reason }),
    ...(event.targetVersion === undefined ? {} : { version: event.targetVersion }),
    ...(transition === undefined ? {} : { transition }),
    ...(code(event.tool?.id) === undefined ? {} : { tool: event.tool?.id }),
    ...(code(event.nodeId) === undefined ? {} : { step: event.nodeId }),
    ...(code(event.permission) === undefined ? {} : { permission: event.permission }),
    ...(event.model === undefined || code(event.model.id) === undefined
      ? {}
      : { model: event.model.id }),
    ...(code(event.decision?.type) === undefined ? {} : { decision: event.decision?.type }),
  } as AuditTrailItem['details'];
  const target = targetOf(event);
  return Object.freeze({
    id: event.id,
    at: event.occurredAt,
    action: event.action,
    category: categoryOf(event.action),
    result: event.result,
    actor: Object.freeze(actorOf(event, viewer)),
    ...(target === undefined ? {} : { target }),
    details: Object.freeze(details),
  });
}

/** The cursor: the last event a page showed, opaque to the browser. */
interface Cursor {
  readonly at: string;
  readonly id: string;
}

const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify([c.at, c.id]), 'utf8').toString('base64url');

function decodeCursor(value: unknown): Cursor | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [at, id] = parsed as unknown[];
    if (typeof at !== 'string' || typeof id !== 'string' || !ID.test(id)) return undefined;
    if (Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) return undefined;
    return { at, id };
  } catch {
    return undefined;
  }
}

/** Newest first; the same instant by id, so the order (and the cursor) is total. */
const newestFirst = (a: AuditEvent, b: AuditEvent): number =>
  a.occurredAt === b.occurredAt
    ? b.id.localeCompare(a.id)
    : b.occurredAt.localeCompare(a.occurredAt);

/** Older than the cursor in that order. */
const after = (event: AuditEvent, cursor: Cursor | undefined): boolean =>
  cursor === undefined ||
  event.occurredAt < cursor.at ||
  (event.occurredAt === cursor.at && event.id.localeCompare(cursor.id) < 0);

export function createAuditTrailService(options: {
  readonly reader: AuditReader & AuditHistoryReader;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
}): AuditTrailService {
  const { reader, organizations, authorization, now = () => new Date() } = options;
  return Object.freeze({
    async page(tenant: TenantContext, input: Parameters<AuditTrailService['page']>[1]) {
      if (!isResolvedTenant(tenant)) throw new ActivityError('unresolved_tenant');
      // A person reviews the trail themselves: GIA and the runtime never read it.
      if (tenant.actor !== 'user' || !authorization.authorize(tenant, 'activity.read').allowed) {
        throw new ActivityError('permission_denied');
      }
      if (!isTimeZone(input.timeZone)) throw new ActivityError('invalid_time_zone');
      if (input.filter !== undefined && !isFilter(input.filter)) {
        throw new ActivityError('invalid_filter');
      }
      const filter = input.filter as AuditTrailFilter | undefined;
      const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      if (input.cursor !== undefined && cursor === undefined) {
        throw new ActivityError('invalid_cursor');
      }
      const target =
        input.target === undefined
          ? undefined
          : typeof input.target === 'string'
            ? TARGET.exec(input.target)
            : null;
      if (target === null) throw new ActivityError('invalid_target');
      const range = dayRange({ from: input.from, to: input.to }, input.timeZone, now());
      if (range === undefined) throw new ActivityError('invalid_period');
      const organization = await organizations.findOrganization(tenant.organizationId);
      if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
        throw new ActivityError('organization_inactive');
      }

      const actions = new Set<string>(actionsOf(filter));
      let found: AuditEvent[];
      if (target !== undefined) {
        // One record's history: the history reader's equality read, filtered here.
        const history = await reader.history(
          tenant.organizationId,
          { type: target[1] as string, id: target[2] as string },
          MAX_HISTORY_EVENTS,
        );
        const from = range.from.toISOString();
        const to = range.to.toISOString();
        found = history.filter(
          (e) => actions.has(e.action) && e.occurredAt >= from && e.occurredAt < to,
        );
      } else {
        // Up to the cursor's instant included: events of that same instant are told apart by id.
        const to =
          cursor === undefined
            ? range.to
            : new Date(Math.min(range.to.getTime(), Date.parse(cursor.at) + 1));
        const all = [...actions] as AuditAction[];
        const groups: AuditAction[][] = [];
        for (let i = 0; i < all.length; i += MAX_QUERY_ACTIONS) {
          groups.push(all.slice(i, i + MAX_QUERY_ACTIONS));
        }
        const pages = await Promise.all(
          groups.map((group) =>
            reader.query({
              organizationId: tenant.organizationId,
              actions: group,
              from: range.from,
              to,
              limit: AUDIT_TRAIL_PAGE_SIZE * 2 + 1,
            }),
          ),
        );
        found = pages.flat();
      }
      // Only this organization's events, whatever the store returned, older than the cursor.
      const own = found
        .filter((e) => e.organizationId === tenant.organizationId && after(e, cursor))
        .sort(newestFirst);
      const shown = own.slice(0, AUDIT_TRAIL_PAGE_SIZE);
      const last = shown.at(-1);
      return Object.freeze({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        fromDay: range.fromDay,
        toDay: range.toDay,
        timeZone: input.timeZone as string,
        filter: filter ?? null,
        filters: AUDIT_TRAIL_FILTERS,
        items: Object.freeze(shown.map((e) => toAuditTrailItem(e, tenant.userId))),
        nextCursor:
          own.length > AUDIT_TRAIL_PAGE_SIZE && last !== undefined
            ? encodeCursor({ at: last.occurredAt, id: last.id })
            : null,
      });
    },
  });
}
