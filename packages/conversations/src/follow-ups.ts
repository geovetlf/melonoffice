import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditTransition,
} from '@melonoffice/audit';
import type {
  Contact,
  ContactId,
  FollowUp,
  FollowUpCancelReason,
  FollowUpFailure,
  FollowUpId,
  FollowUpSource,
  FollowUpStatus,
  FollowUpType,
  IsoTimestamp,
  NextAction,
  Opportunity,
  OpportunityId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { nameBasedUuid } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { ConversationError } from './errors.js';
import {
  daysBetween,
  isLocalDate,
  isLocalTime,
  localDateTime,
  plusDays,
  zonedInstant,
} from './follow-up-time.js';
import { isTimeZone } from './insights.js';
import { isContactId, isUuid } from './model.js';
import type { ConversationRepository, FollowUpRead, FollowUpWrite } from './repository.js';

/**
 * Commercial follow-ups (C5, ADR-0058): something a member must do about a contact or an
 * opportunity at a set time. A person schedules it (level A) or confirms one GIA proposed
 * (level B); automatic rules (level C) are not enabled. The existing job transport (Cloud Tasks,
 * ADR-0032) holds one task per scheduling and, when the time comes, the worker marks it due: the
 * office's activity is the notice. Nothing is ever sent to the contact.
 *
 * A record's next action is its earliest open follow-up, written in the same transaction as the
 * follow-up (ADR-0058): there is one source of truth for what is scheduled.
 */

export const FOLLOW_UP_TYPES: readonly FollowUpType[] = [
  'follow_up',
  'call',
  'message',
  'review',
  'check_in',
];

export const FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = [
  'scheduled',
  'due',
  'completed',
  'cancelled',
  'failed',
];

/** Open follow-ups still need a person: they count, show and set the record's next action. */
export const OPEN_FOLLOW_UP: ReadonlySet<FollowUpStatus> = new Set(['scheduled', 'due', 'failed']);
export const isOpenFollowUp = (f: Pick<FollowUp, 'status'>) => OPEN_FOLLOW_UP.has(f.status);

export const FOLLOW_UP_LIMITS = Object.freeze({
  titleLength: 120,
  descriptionLength: 1000,
  /** Follow-ups one list returns. */
  list: 500,
  /** Open follow-ups one contact or opportunity may have at once (a technical limit). */
  openPerRecord: 20,
  /** Earlier times kept per follow-up. */
  history: 20,
  /** How far ahead one may be scheduled. */
  horizonDays: 366,
  /** A time this close in the past is still accepted (the person's clock and the network). */
  pastToleranceMs: 5 * 60_000,
  /** How many days "upcoming" covers. */
  upcomingDays: 7,
});

/** Where a scheduled task is handed over. The worker runs it at `at` (ADR-0032 transport). */
export interface FollowUpTask {
  readonly organizationId: OrganizationId;
  readonly followUpId: FollowUpId;
  /** The follow-up's `schedule` when the task was made: an earlier one does nothing. */
  readonly schedule: number;
}

export interface FollowUpScheduler {
  /** Queues the task for `at`. Throws when it cannot: nothing is then pretended to be queued. */
  schedule(task: FollowUpTask, at: Date): Promise<void>;
}

/** The same follow-up from the same request, however often it is sent. */
export function followUpIdFor(organizationId: OrganizationId, requestKey: string): FollowUpId {
  return nameBasedUuid('melonoffice.follow_up', [organizationId, requestKey]) as FollowUpId;
}

export const isFollowUpId = (value: unknown): value is FollowUpId => isUuid(value);

/** The record a follow-up belongs to: its opportunity, or its contact when it has none. */
export const subjectOf = (f: Pick<FollowUp, 'contactId' | 'opportunityId'>): string =>
  f.opportunityId === undefined ? `contact:${f.contactId}` : `opportunity:${f.opportunityId}`;

const byTime = (a: FollowUp, b: FollowUp) =>
  a.scheduledAt === b.scheduledAt
    ? a.id.localeCompare(b.id)
    : a.scheduledAt < b.scheduledAt
      ? -1
      : 1;

/**
 * The next action a record shows given its open follow-ups: the earliest one. With none open, a
 * next action that came from a follow-up is cleared and a person's own note stays.
 */
export function nextActionFrom(
  current: NextAction | undefined,
  open: readonly FollowUp[],
): NextAction | undefined {
  const first = open.filter(isOpenFollowUp).toSorted(byTime)[0];
  if (first === undefined) return current?.followUpId === undefined ? current : undefined;
  return Object.freeze({
    text: first.title,
    dueOn: localDateTime(first.scheduledAt, first.timeZone).date,
    followUpId: first.id,
  });
}

const sameNextAction = (a: NextAction | undefined, b: NextAction | undefined) =>
  a?.text === b?.text && a?.dueOn === b?.dueOn && a?.followUpId === b?.followUpId;

/** A follow-up as a person reads it, in its own time zone. */
export interface FollowUpTiming {
  readonly date: string;
  readonly time: string;
  /** Days from today (business time zone) to its date: negative is overdue. */
  readonly days: number;
  readonly when: 'overdue' | 'today' | 'upcoming' | 'later';
}

export function timingOf(f: FollowUp, today: string): FollowUpTiming {
  const { date, time } = localDateTime(f.scheduledAt, f.timeZone);
  const days = daysBetween(today, date);
  const when =
    f.status === 'due' || days < 0
      ? days < 0
        ? 'overdue'
        : 'today'
      : days === 0
        ? 'today'
        : days <= FOLLOW_UP_LIMITS.upcomingDays
          ? 'upcoming'
          : 'later';
  return { date, time, days, when };
}

export interface FollowUpList {
  readonly items: readonly FollowUp[];
  readonly timeZone: string;
  readonly today: string;
  /** Open follow-ups: overdue, due today and within the next days. */
  readonly counts: {
    readonly overdue: number;
    readonly today: number;
    readonly upcoming: number;
    readonly open: number;
  };
  readonly hasMore: boolean;
}

export interface FollowUpFilter {
  readonly status?: unknown;
  readonly contactId?: unknown;
  readonly opportunityId?: unknown;
  /** `me`: only the ones assigned to the person asking. */
  readonly assignee?: unknown;
  /** `open`: scheduled, due or failed. */
  readonly open?: unknown;
}

/** What the worker's task did. */
export type DueResult =
  | { readonly kind: 'due'; readonly followUp: FollowUp }
  | { readonly kind: 'cancelled'; readonly reason: FollowUpCancelReason }
  | { readonly kind: 'early'; readonly next: Date }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not_found' };

export interface FollowUpService {
  /** `follow_up.read`: the organization's follow-ups, soonest first, with their counts. */
  list(tenant: TenantContext, filter?: FollowUpFilter): Promise<FollowUpList>;
  /** `follow_up.read`. */
  get(tenant: TenantContext, id: string): Promise<FollowUp>;
  /**
   * `follow_up.manage`, a person directly: schedules a follow-up and queues its task. The same
   * `requestKey` is the same follow-up (`created: false`). If the task cannot be queued, it is
   * kept as failed and `follow_up_not_scheduled` is thrown: nothing pretends to be scheduled.
   */
  create(
    tenant: TenantContext,
    input: Record<string, unknown>,
  ): Promise<{ readonly followUp: FollowUp; readonly created: boolean }>;
  /** `follow_up.manage`: title, description, type or assignee, against its `revision`. */
  update(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<FollowUp>;
  /**
   * `follow_up.manage`: a new date and time; also reopens a completed, cancelled or failed one.
   * The earlier time is kept in its history, and a new task is queued.
   */
  reschedule(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<FollowUp>;
  /** `follow_up.manage`: done. The record's next action moves to its next open follow-up. */
  complete(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<FollowUp>;
  /** `follow_up.manage`: cancelled and kept. */
  cancel(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<FollowUp>;
  /**
   * The scheduler's task (the worker): marks the follow-up due when its time has come and its
   * scheduling is still the task's. A repeated, earlier or ended one changes nothing. Beyond the
   * queue's horizon, the task arrives early and queues the next hop.
   */
  runDue(task: FollowUpTask): Promise<DueResult>;
  /** The queue gave up on the task: the follow-up is kept as failed, for a person to reschedule. */
  failDue(task: FollowUpTask): Promise<boolean>;
}

export interface FollowUpServiceOptions {
  readonly repository: Pick<
    ConversationRepository,
    'findFollowUp' | 'listFollowUps' | 'writeFollowUp'
  >;
  readonly organizations: Pick<TenancyStore, 'findOrganization' | 'findMembership'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** The business's time zone (its profile). */
  readonly timeZone: (organizationId: OrganizationId) => Promise<string>;
  /** Absent: nothing can be scheduled, and creating or rescheduling fails closed. */
  readonly scheduler?: FollowUpScheduler;
  /**
   * How far ahead the queue accepts a task. A later time is reached in hops: the task arrives
   * early, and queues the next one. Cloud Tasks keeps a task up to 30 days.
   */
  readonly horizonMs?: number;
  readonly now?: () => Date;
  readonly requestId?: string;
}

/** Cloud Tasks' own limit is 30 days; a day less leaves room for clocks. */
export const FOLLOW_UP_QUEUE_HORIZON_MS = 29 * 86_400_000;

const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CREATE_KEYS = new Set([
  'requestKey',
  'contactId',
  'opportunityId',
  'type',
  'title',
  'description',
  'date',
  'time',
  'timeZone',
  'assignedTo',
  'source',
]);
const UPDATE_KEYS = new Set(['revision', 'title', 'description', 'type', 'assignedTo']);
const RESCHEDULE_KEYS = new Set(['revision', 'date', 'time', 'timeZone']);
const REVISION_KEYS = new Set(['revision']);

type FollowUpAction = Extract<AuditAction, `follow_up.${string}`>;

const bad = (field: string): never => {
  throw new ConversationError('invalid_request', field);
};

function checkKeys(input: Record<string, unknown>, keys: ReadonlySet<string>): void {
  for (const k of Object.keys(input)) if (!keys.has(k)) bad(k);
}

function revisionOf(input: Record<string, unknown>): number {
  const { revision } = input;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return bad('revision');
  }
  return revision;
}

function titleOf(value: unknown): string {
  if (typeof value !== 'string') return bad('title');
  const title = value.normalize('NFC').trim();
  if (title === '' || [...title].length > FOLLOW_UP_LIMITS.titleLength || CONTROL.test(title)) {
    bad('title');
  }
  return title.replace(/\s+/g, ' ');
}

function descriptionOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return bad('description');
  const text = value.normalize('NFC').trim();
  if ([...text].length > FOLLOW_UP_LIMITS.descriptionLength || CONTROL.test(text)) {
    bad('description');
  }
  return text === '' ? null : text;
}

const typeOf = (value: unknown): FollowUpType =>
  (FOLLOW_UP_TYPES as readonly unknown[]).includes(value) ? (value as FollowUpType) : bad('type');

export function createFollowUpService(options: FollowUpServiceOptions): FollowUpService {
  const {
    repository,
    organizations,
    authorization,
    scheduler,
    horizonMs = FOLLOW_UP_QUEUE_HORIZON_MS,
    now = () => new Date(),
    requestId,
  } = options;

  async function zoneOf(organizationId: OrganizationId): Promise<string> {
    const zone = await options.timeZone(organizationId);
    return isTimeZone(zone) ? zone : 'UTC';
  }

  async function organizationOf(tenant: TenantContext, permission: string) {
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

  /** Every change is a person's, directly: GIA proposes, the runtime only marks one due. */
  async function managerOf(tenant: TenantContext): Promise<OrganizationId> {
    const organizationId = await organizationOf(tenant, 'follow_up.manage');
    if (tenant.actor !== 'user') throw new ConversationError('requires_user');
    return organizationId;
  }

  async function memberOf(organizationId: OrganizationId, value: unknown): Promise<UserId> {
    if (!isUuid(value)) return bad('assignedTo');
    const membership = await organizations.findMembership(organizationId, value as UserId);
    if (membership?.status !== 'active') throw new ConversationError('owner_not_member');
    return value as UserId;
  }

  /** A local date and time in a zone, as an instant from now to the horizon. */
  async function instantOf(
    organizationId: OrganizationId,
    input: Record<string, unknown>,
  ): Promise<{ at: Date; timeZone: string }> {
    const timeZone =
      input.timeZone === undefined || input.timeZone === null
        ? await zoneOf(organizationId)
        : typeof input.timeZone === 'string' && isTimeZone(input.timeZone)
          ? input.timeZone
          : bad('timeZone');
    if (!isLocalDate(input.date)) return bad('date');
    // The time is the person's: never assumed. Without one, the caller asks for it.
    if (!isLocalTime(input.time)) return bad('time');
    const at = zonedInstant(input.date, input.time, timeZone);
    const current = now();
    if (at.getTime() < current.getTime() - FOLLOW_UP_LIMITS.pastToleranceMs) bad('date_in_past');
    const today = localDateTime(current, timeZone).date;
    if (daysBetween(today, input.date) > FOLLOW_UP_LIMITS.horizonDays) bad('date_too_far');
    return { at, timeZone };
  }

  const event = (
    actor: TenantContext | { readonly actor: 'runtime'; readonly userId: UserId },
    organizationId: OrganizationId,
    target: { readonly type: 'follow_up' | 'contact' | 'opportunity'; readonly id: string },
    action: FollowUpAction | 'contact.updated' | 'opportunity.updated',
    at: Date,
    fields: {
      readonly transition?: AuditTransition;
      readonly reason?: string;
      readonly reference?: string;
      readonly result?: 'success' | 'failure';
    } = {},
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: fields.result ?? 'success',
        actor: actorOf(actor),
        organizationId,
        target,
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(fields.reference === undefined ? {} : { reference: fields.reference }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  /**
   * The follow-up's next state with its record's next action kept in step, in the same write.
   * The record changes only when its earliest open follow-up does.
   */
  function withRecord(
    actor: TenantContext | { readonly actor: 'runtime'; readonly userId: UserId },
    read: FollowUpRead,
    followUp: FollowUp,
    events: AuditEvent[],
    at: Date,
  ): FollowUpWrite {
    const open = [...read.open.filter((f) => f.id !== followUp.id), followUp];
    const iso = at.toISOString() as IsoTimestamp;
    if (read.opportunity !== undefined) {
      const o = read.opportunity;
      const next = nextActionFrom(o.nextAction, open);
      if (!sameNextAction(o.nextAction, next)) {
        const record: Record<string, unknown> = { ...o, revision: o.revision + 1, updatedAt: iso };
        if (next === undefined) delete record.nextAction;
        else record.nextAction = next;
        events.push(
          event(
            actor,
            o.organizationId,
            { type: 'opportunity', id: o.id },
            'opportunity.updated',
            at,
            {
              reason: next === undefined ? 'next_action_cleared' : 'follow_up',
            },
          ),
        );
        return { followUp, opportunity: Object.freeze(record) as unknown as Opportunity, events };
      }
      return { followUp, events };
    }
    const c = read.contact;
    // A contact that is not in Comercial yet has no next action to keep.
    if (c.commercial === undefined) return { followUp, events };
    const next = nextActionFrom(c.commercial.nextAction, open);
    if (sameNextAction(c.commercial.nextAction, next)) return { followUp, events };
    const commercial: Record<string, unknown> = { ...c.commercial };
    if (next === undefined) delete commercial.nextAction;
    else commercial.nextAction = next;
    events.push(
      event(actor, c.organizationId, { type: 'contact', id: c.id }, 'contact.updated', at, {
        reason: next === undefined ? 'next_action_cleared' : 'follow_up',
      }),
    );
    return {
      followUp,
      contact: Object.freeze({
        ...c,
        commercial: Object.freeze(commercial) as unknown as Contact['commercial'],
        revision: (c.revision ?? 0) + 1,
        updatedAt: iso,
      }) as Contact,
      events,
    };
  }

  const target = (f: Pick<FollowUp, 'id'>) => ({ type: 'follow_up' as const, id: f.id });

  /** The follow-up one revision ahead, with `fields` changed. */
  const advance = (f: FollowUp, at: Date, fields: Record<string, unknown>): FollowUp => {
    const record = Object.fromEntries(
      Object.entries({
        ...f,
        ...fields,
        revision: f.revision + 1,
        updatedAt: at.toISOString(),
      }).filter(([, v]) => v !== undefined),
    );
    return Object.freeze(record) as unknown as FollowUp;
  };

  /** Queues the task of the follow-up's current scheduling: the first hop within the horizon. */
  async function queue(f: FollowUp): Promise<void> {
    if (scheduler === undefined) throw new ConversationError('follow_up_scheduler_unavailable');
    const at = new Date(Math.min(Date.parse(f.scheduledAt), now().getTime() + horizonMs));
    await scheduler.schedule(
      { organizationId: f.organizationId, followUpId: f.id, schedule: f.schedule },
      at,
    );
  }

  /**
   * Queues the task; if that fails, the follow-up is kept as failed (`not_scheduled`) and the
   * caller learns it was not scheduled.
   */
  async function queueOrFail(tenant: TenantContext, f: FollowUp): Promise<FollowUp> {
    try {
      await queue(f);
      return f;
    } catch (error) {
      if (error instanceof ConversationError && error.code !== 'follow_up_scheduler_unavailable') {
        throw error;
      }
      await repository.writeFollowUp(f.organizationId, { followUpId: f.id }, (read) => {
        const current = read.current as FollowUp;
        if (current.schedule !== f.schedule || current.status !== 'scheduled') {
          return { followUp: current, events: [] };
        }
        const at = now();
        const failed = advance(current, at, {
          status: 'failed',
          failure: 'not_scheduled',
          failedAt: at.toISOString(),
        });
        return withRecord(
          tenant,
          read,
          failed,
          [
            event(tenant, f.organizationId, target(f), 'follow_up.failed', at, {
              reason: 'not_scheduled',
              result: 'failure',
            }),
          ],
          at,
        );
      });
      throw new ConversationError('follow_up_not_scheduled');
    }
  }

  async function change(
    tenant: TenantContext,
    id: string,
    input: Record<string, unknown>,
    keys: ReadonlySet<string>,
    decide: (
      read: FollowUpRead,
      current: FollowUp,
      organizationId: OrganizationId,
    ) => FollowUpWrite,
  ): Promise<FollowUp> {
    const organizationId = await managerOf(tenant);
    if (!isFollowUpId(id)) throw new ConversationError('follow_up_not_found');
    checkKeys(input, keys);
    const revision = revisionOf(input);
    return repository.writeFollowUp(organizationId, { followUpId: id }, (read) => {
      const current = read.current as FollowUp;
      if (current.revision !== revision)
        throw new ConversationError('follow_up_concurrency_conflict');
      return decide(read, current, organizationId);
    });
  }

  return Object.freeze({
    async list(tenant, filter = {}) {
      const organizationId = await organizationOf(tenant, 'follow_up.read');
      const { status, contactId, opportunityId, assignee, open } = filter;
      if (status !== undefined && !(FOLLOW_UP_STATUSES as readonly unknown[]).includes(status)) {
        bad('status');
      }
      if (contactId !== undefined && !isContactId(contactId)) bad('contactId');
      if (opportunityId !== undefined && !isUuid(opportunityId)) bad('opportunityId');
      if (assignee !== undefined && assignee !== 'me') bad('assignee');
      if (open !== undefined && open !== 'true' && open !== true) bad('open');
      const timeZone = await zoneOf(organizationId);
      const today = localDateTime(now(), timeZone).date;
      const all = (await repository.listFollowUps(organizationId))
        .filter((f) => f.organizationId === organizationId)
        .toSorted(byTime);
      const matching = all.filter(
        (f) =>
          (status === undefined || f.status === status) &&
          (open === undefined || isOpenFollowUp(f)) &&
          (contactId === undefined || f.contactId === contactId) &&
          (opportunityId === undefined || f.opportunityId === opportunityId) &&
          (assignee === undefined || f.assignedTo === tenant.userId),
      );
      const counts = { overdue: 0, today: 0, upcoming: 0, open: 0 };
      for (const f of matching) {
        if (!isOpenFollowUp(f)) continue;
        counts.open += 1;
        const { when } = timingOf(f, today);
        if (when === 'overdue') counts.overdue += 1;
        else if (when === 'today') counts.today += 1;
        else if (when === 'upcoming') counts.upcoming += 1;
      }
      return Object.freeze({
        items: Object.freeze(matching.slice(0, FOLLOW_UP_LIMITS.list)),
        timeZone,
        today,
        counts: Object.freeze(counts),
        hasMore: matching.length > FOLLOW_UP_LIMITS.list,
      });
    },

    async get(tenant, id) {
      const organizationId = await organizationOf(tenant, 'follow_up.read');
      if (!isFollowUpId(id)) throw new ConversationError('follow_up_not_found');
      const found = await repository.findFollowUp(organizationId, id);
      if (found === undefined) throw new ConversationError('follow_up_not_found');
      return found;
    },

    async create(tenant, input) {
      const organizationId = await managerOf(tenant);
      checkKeys(input, CREATE_KEYS);
      if (typeof input.requestKey !== 'string' || !REQUEST_KEY.test(input.requestKey)) {
        bad('requestKey');
      }
      if (!isContactId(input.contactId)) bad('contactId');
      if (
        input.opportunityId !== undefined &&
        input.opportunityId !== null &&
        !isUuid(input.opportunityId)
      ) {
        bad('opportunityId');
      }
      const type = input.type === undefined ? 'follow_up' : typeOf(input.type);
      const title = titleOf(input.title);
      const description = input.description === undefined ? null : descriptionOf(input.description);
      const source: FollowUpSource =
        input.source === undefined || input.source === 'manual'
          ? 'manual'
          : input.source === 'gia'
            ? 'gia'
            : bad('source');
      const chosen =
        input.assignedTo === undefined || input.assignedTo === null
          ? undefined
          : await memberOf(organizationId, input.assignedTo);
      const { at: scheduled, timeZone } = await instantOf(organizationId, input);
      if (scheduler === undefined) throw new ConversationError('follow_up_scheduler_unavailable');
      const id = followUpIdFor(organizationId, input.requestKey as string);
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const opportunityId =
        input.opportunityId === undefined || input.opportunityId === null
          ? undefined
          : (input.opportunityId as OpportunityId);
      let created = false;

      const followUp = await repository.writeFollowUp(
        organizationId,
        {
          followUpId: id,
          contactId: input.contactId as ContactId,
          ...(opportunityId === undefined ? {} : { opportunityId }),
        },
        (read) => {
          // The same request again: the follow-up it made, unchanged.
          if (read.current !== undefined) {
            if (
              read.current.contactId !== input.contactId ||
              read.current.opportunityId !== opportunityId
            ) {
              throw new ConversationError('duplicate_request');
            }
            return { followUp: read.current, events: [] };
          }
          if (read.contact.status === 'archived') throw new ConversationError('contact_not_found');
          if (read.opportunity !== undefined && read.opportunity.status !== 'open') {
            throw new ConversationError('opportunity_closed');
          }
          if (read.open.filter(isOpenFollowUp).length >= FOLLOW_UP_LIMITS.openPerRecord) {
            throw new ConversationError('follow_up_limit_reached');
          }
          // The assignee: the one chosen, else the record's responsible member, else the author.
          const assignedTo =
            chosen ??
            read.opportunity?.ownerId ??
            read.contact.commercial?.ownerId ??
            tenant.userId;
          const f: FollowUp = Object.freeze({
            id,
            organizationId,
            contactId: read.contact.id,
            ...(opportunityId === undefined ? {} : { opportunityId }),
            assignedTo,
            type,
            title,
            ...(description === null ? {} : { description }),
            scheduledAt: scheduled.toISOString() as IsoTimestamp,
            timeZone,
            status: 'scheduled',
            source,
            schedule: 1,
            history: Object.freeze([]),
            metadata: Object.freeze({ automation: source === 'gia' ? 'suggested' : 'manual' }),
            revision: 1,
            createdBy: tenant.userId,
            createdAt: iso,
            updatedAt: iso,
          });
          created = true;
          return withRecord(
            tenant,
            read,
            f,
            [
              event(tenant, organizationId, target(f), 'follow_up.created', at, {
                reason: type,
                reference: source,
              }),
            ],
            at,
          );
        },
      );
      if (!created) return { followUp, created: false };
      return { followUp: await queueOrFail(tenant, followUp), created: true };
    },

    async update(tenant, id, input) {
      const title = input.title === undefined ? undefined : titleOf(input.title);
      const description =
        input.description === undefined ? undefined : descriptionOf(input.description);
      const type = input.type === undefined ? undefined : typeOf(input.type);
      const organizationId = await managerOf(tenant);
      const assignedTo =
        input.assignedTo === undefined
          ? undefined
          : await memberOf(organizationId, input.assignedTo);
      return change(tenant, id, input, UPDATE_KEYS, (read, current) => {
        if (!isOpenFollowUp(current)) throw new ConversationError('follow_up_closed');
        const at = now();
        const reasons: string[] = [];
        const fields: Record<string, unknown> = {};
        if (title !== undefined && title !== current.title) {
          fields.title = title;
          reasons.push('details');
        }
        if (description !== undefined && (description ?? undefined) !== current.description) {
          fields.description = description ?? undefined;
          if (!reasons.includes('details')) reasons.push('details');
        }
        if (type !== undefined && type !== current.type) {
          fields.type = type;
          reasons.push('type');
        }
        if (assignedTo !== undefined && assignedTo !== current.assignedTo) {
          fields.assignedTo = assignedTo;
          reasons.push('assignee');
        }
        if (reasons.length === 0) return { followUp: current, events: [] };
        const next = advance(current, at, fields);
        return withRecord(
          tenant,
          read,
          next,
          reasons.map((reason) =>
            event(tenant, current.organizationId, target(current), 'follow_up.updated', at, {
              reason,
            }),
          ),
          at,
        );
      });
    },

    async reschedule(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const { at: scheduled, timeZone } = await instantOf(organizationId, input);
      if (scheduler === undefined) throw new ConversationError('follow_up_scheduler_unavailable');
      const next = await change(tenant, id, input, RESCHEDULE_KEYS, (read, current) => {
        if (read.opportunity !== undefined && read.opportunity.status !== 'open') {
          throw new ConversationError('opportunity_closed');
        }
        if (read.contact.status === 'archived') throw new ConversationError('contact_not_found');
        if (
          !isOpenFollowUp(current) &&
          read.open.filter(isOpenFollowUp).length >= FOLLOW_UP_LIMITS.openPerRecord
        ) {
          throw new ConversationError('follow_up_limit_reached');
        }
        const at = now();
        const iso = at.toISOString() as IsoTimestamp;
        const history = [
          ...current.history,
          Object.freeze({
            from: current.scheduledAt,
            to: scheduled.toISOString() as IsoTimestamp,
            status: current.status,
            at: iso,
            by: tenant.userId,
          }),
        ].slice(-FOLLOW_UP_LIMITS.history);
        const f = advance(current, at, {
          scheduledAt: scheduled.toISOString(),
          timeZone,
          status: 'scheduled',
          schedule: current.schedule + 1,
          history: Object.freeze(history),
          dueAt: undefined,
          completedAt: undefined,
          completedBy: undefined,
          cancelledAt: undefined,
          cancelledBy: undefined,
          cancelReason: undefined,
          failure: undefined,
          failedAt: undefined,
        });
        return withRecord(
          tenant,
          read,
          f,
          [
            event(tenant, current.organizationId, target(current), 'follow_up.rescheduled', at, {
              transition: { from: current.status, to: 'scheduled' },
            }),
          ],
          at,
        );
      });
      return queueOrFail(tenant, next);
    },

    async complete(tenant, id, input) {
      return change(tenant, id, input, REVISION_KEYS, (read, current) => {
        if (!isOpenFollowUp(current)) throw new ConversationError('follow_up_closed');
        const at = now();
        const f = advance(current, at, {
          status: 'completed',
          completedAt: at.toISOString(),
          completedBy: tenant.userId,
        });
        return withRecord(
          tenant,
          read,
          f,
          [
            event(tenant, current.organizationId, target(current), 'follow_up.completed', at, {
              transition: { from: current.status, to: 'completed' },
            }),
          ],
          at,
        );
      });
    },

    async cancel(tenant, id, input) {
      return change(tenant, id, input, REVISION_KEYS, (read, current) => {
        if (!isOpenFollowUp(current)) throw new ConversationError('follow_up_closed');
        const at = now();
        const f = advance(current, at, {
          status: 'cancelled',
          cancelledAt: at.toISOString(),
          cancelledBy: tenant.userId,
          cancelReason: 'person',
        });
        return withRecord(
          tenant,
          read,
          f,
          [
            event(tenant, current.organizationId, target(current), 'follow_up.cancelled', at, {
              reason: 'person',
            }),
          ],
          at,
        );
      });
    },

    async runDue(task) {
      if (!isUuid(task.organizationId) || !isFollowUpId(task.followUpId))
        return { kind: 'not_found' };
      if (!Number.isSafeInteger(task.schedule) || task.schedule < 1) return { kind: 'stale' };
      const organization = await organizations.findOrganization(task.organizationId);
      if (organization?.id !== task.organizationId) return { kind: 'not_found' };
      const found = await repository.findFollowUp(task.organizationId, task.followUpId);
      if (found === undefined) return { kind: 'not_found' };
      if (found.schedule !== task.schedule || found.status !== 'scheduled')
        return { kind: 'stale' };
      // Beyond the queue's horizon the task comes early: queue the next hop, change nothing.
      const current = now();
      if (
        Date.parse(found.scheduledAt) - current.getTime() >
        FOLLOW_UP_LIMITS.pastToleranceMs / 5
      ) {
        if (scheduler === undefined) throw new ConversationError('follow_up_scheduler_unavailable');
        const next = new Date(
          Math.min(Date.parse(found.scheduledAt), current.getTime() + horizonMs),
        );
        await scheduler.schedule(task, next);
        return { kind: 'early', next };
      }
      // The runtime acts for the member who scheduled it; it is never recorded as that person.
      const runtime = { actor: 'runtime' as const, userId: found.createdBy };
      let result: DueResult = { kind: 'stale' };
      await repository.writeFollowUp(
        task.organizationId,
        { followUpId: task.followUpId },
        (read) => {
          const f = read.current as FollowUp;
          if (f.schedule !== task.schedule || f.status !== 'scheduled') {
            result = { kind: 'stale' };
            return { followUp: f, events: [] };
          }
          const at = now();
          const iso = at.toISOString();
          // The organization stopped: its follow-ups wait, unchanged.
          if (organization.status !== 'active') {
            result = { kind: 'stale' };
            return { followUp: f, events: [] };
          }
          // Its record ended before its time came: nothing is left to do, and it says why.
          const ended: FollowUpCancelReason | undefined =
            read.contact.status === 'archived'
              ? 'contact_archived'
              : read.opportunity !== undefined && read.opportunity.status !== 'open'
                ? 'opportunity_closed'
                : undefined;
          if (ended !== undefined) {
            result = { kind: 'cancelled', reason: ended };
            return withRecord(
              runtime,
              read,
              advance(f, at, { status: 'cancelled', cancelledAt: iso, cancelReason: ended }),
              [
                event(runtime, f.organizationId, target(f), 'follow_up.cancelled', at, {
                  reason: ended,
                }),
              ],
              at,
            );
          }
          const due = advance(f, at, { status: 'due', dueAt: iso });
          result = { kind: 'due', followUp: due };
          return withRecord(
            runtime,
            read,
            due,
            [
              event(runtime, f.organizationId, target(f), 'follow_up.due', at, {
                transition: { from: 'scheduled', to: 'due' },
              }),
            ],
            at,
          );
        },
      );
      return result;
    },

    async failDue(task) {
      if (!isUuid(task.organizationId) || !isFollowUpId(task.followUpId)) return false;
      const found = await repository.findFollowUp(task.organizationId, task.followUpId);
      if (found === undefined || found.schedule !== task.schedule || found.status !== 'scheduled') {
        return false;
      }
      const runtime = { actor: 'runtime' as const, userId: found.createdBy };
      let failed = false;
      await repository.writeFollowUp(
        task.organizationId,
        { followUpId: task.followUpId },
        (read) => {
          const f = read.current as FollowUp;
          if (f.schedule !== task.schedule || f.status !== 'scheduled') {
            return { followUp: f, events: [] };
          }
          const at = now();
          failed = true;
          const reason: FollowUpFailure = 'retries_exhausted';
          return withRecord(
            runtime,
            read,
            advance(f, at, { status: 'failed', failure: reason, failedAt: at.toISOString() }),
            [
              event(runtime, f.organizationId, target(f), 'follow_up.failed', at, {
                reason,
                result: 'failure',
              }),
            ],
            at,
          );
        },
      );
      return failed;
    },
  } satisfies FollowUpService);
}

/** The dates of the coming days, for a model to pick one from (never to compute one). */
export function dateGrid(today: string, days = 14): readonly { date: string; weekday: string }[] {
  const names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return Array.from({ length: days }, (_, i) => {
    const date = plusDays(today, i);
    const weekday = names[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] as string;
    return { date, weekday };
  });
}
