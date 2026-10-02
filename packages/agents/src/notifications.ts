import type {
  AgentNotification,
  AgentNotificationKind,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { createHash } from 'node:crypto';
import { AgentTaskError } from './errors.js';
import type { AgentHandoffRepository } from './handoffs.js';
import type { AgentTaskRepository } from './tasks.js';

/**
 * In-app notifications about agents' work (ADR-0117, AE-D5). A notice is made from a fact that
 * already happened (an event on the bus, or a person's own action in the API), for the person who
 * asked for the task, and handed to each registered channel. Only the in-app channel exists: a
 * channel is an adapter (`NotificationChannel`), so email, WhatsApp or push can be added later as
 * one more adapter, never as a second notification system. Nothing here calls a model, runs a
 * tool, or sends anything outside MelonOffice.
 *
 * A notice carries ids and codes only. It is read only by its person, in their organization, and
 * is kept for `retentionDays`.
 */

export const NOTIFICATION_LIMITS = Object.freeze({
  retentionDays: 90,
  page: 30,
  maxPage: 50,
  /** The unread count stops here; the bell shows "99+". */
  unread: 100,
  /** How many a "mark all read" reaches at once. */
  markAll: 200,
});

export const AGENT_NOTIFICATION_KINDS: readonly AgentNotificationKind[] = Object.freeze([
  'approval_required',
  'task_finished',
  'task_blocked',
  'task_failed',
  'agent_stopped',
  'needs_info',
  'task_delegated',
  'task_received',
]);

const MAX_MS = 9_999_999_999_999;

/**
 * A notice's id: the inverted time first, so ordering by id reads newest first with Firestore's
 * single-field indexes (no composite index), then a hash of what makes it unique. The same fact
 * at the same time is the same id: a repeated delivery stores it once.
 */
export function notificationIdOf(at: Date, key: string): string {
  const inverted = String(MAX_MS - at.getTime()).padStart(13, '0');
  return `${inverted}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

const NOTIFICATION_ID = /^\d{13}_[0-9a-f]{24}$/;
export const isNotificationId = (value: unknown): value is string =>
  typeof value === 'string' && NOTIFICATION_ID.test(value);

export interface AgentNotificationRepository {
  /** Stores a notice; one with the same id is kept as it is. */
  put(notification: AgentNotification): Promise<void>;
  /** The person's notices by id (newest first), after `after` when given. */
  page(
    organizationId: OrganizationId,
    recipientId: UserId,
    request: { readonly after?: string; readonly limit: number },
  ): Promise<{ readonly items: readonly AgentNotification[]; readonly hasMore: boolean }>;
  /** How many unread notices the person has, up to `limit`. */
  unread(organizationId: OrganizationId, recipientId: UserId, limit: number): Promise<number>;
  /** Marks one of the person's notices read; false when it is not theirs or not found. */
  markRead(
    organizationId: OrganizationId,
    recipientId: UserId,
    id: string,
    at: IsoTimestamp,
  ): Promise<boolean>;
  /** Marks up to `limit` unread notices of the person read; how many it marked. */
  markAllRead(
    organizationId: OrganizationId,
    recipientId: UserId,
    at: IsoTimestamp,
    limit: number,
  ): Promise<number>;
}

export class InMemoryAgentNotificationRepository implements AgentNotificationRepository {
  readonly #items = new Map<string, AgentNotification>();

  async put(notification: AgentNotification) {
    if (!this.#items.has(notification.id)) this.#items.set(notification.id, notification);
  }

  #of(organizationId: OrganizationId, recipientId: UserId) {
    return [...this.#items.values()]
      .filter((n) => n.organizationId === organizationId && n.recipientId === recipientId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async page(
    organizationId: OrganizationId,
    recipientId: UserId,
    request: { readonly after?: string; readonly limit: number },
  ) {
    const all = this.#of(organizationId, recipientId).filter(
      (n) => request.after === undefined || n.id > request.after,
    );
    return { items: all.slice(0, request.limit), hasMore: all.length > request.limit };
  }

  async unread(organizationId: OrganizationId, recipientId: UserId, limit: number) {
    return Math.min(
      this.#of(organizationId, recipientId).filter((n) => n.readAt === null).length,
      limit,
    );
  }

  async markRead(
    organizationId: OrganizationId,
    recipientId: UserId,
    id: string,
    at: IsoTimestamp,
  ) {
    const found = this.#items.get(id);
    if (found?.organizationId !== organizationId || found.recipientId !== recipientId) {
      return false;
    }
    if (found.readAt === null) this.#items.set(id, Object.freeze({ ...found, readAt: at }));
    return true;
  }

  async markAllRead(
    organizationId: OrganizationId,
    recipientId: UserId,
    at: IsoTimestamp,
    limit: number,
  ) {
    const unread = this.#of(organizationId, recipientId)
      .filter((n) => n.readAt === null)
      .slice(0, limit);
    for (const n of unread) this.#items.set(n.id, Object.freeze({ ...n, readAt: at }));
    return unread.length;
  }

  /** Test helper: every notice stored. */
  all(): readonly AgentNotification[] {
    return [...this.#items.values()];
  }
}

/** Where a notice goes. In-app is the only channel today; others are future adapters. */
export interface NotificationChannel {
  readonly id: string;
  deliver(notification: AgentNotification): Promise<void>;
}

/** The in-app channel: the notice is stored for the person's bell. */
export const inAppChannel = (repository: Pick<AgentNotificationRepository, 'put'>) =>
  Object.freeze({
    id: 'in_app',
    deliver: (notification: AgentNotification) => repository.put(notification),
  }) satisfies NotificationChannel;

export interface AgentNotificationDraft {
  readonly organizationId: OrganizationId;
  readonly recipientId: UserId;
  readonly kind: AgentNotificationKind;
  readonly specialistId: SpecialistId;
  readonly taskId: string;
  readonly code?: string | null;
  readonly otherSpecialistId?: SpecialistId | null;
  /** What makes it unique (an event id, or a task and kind). */
  readonly key: string;
  /** When the fact happened; the notifier's clock otherwise. */
  readonly at?: Date;
}

export interface AgentNotifier {
  /** Hands the notice to every channel. Never throws: a notice is never worth failing work for. */
  notify(draft: AgentNotificationDraft): Promise<void>;
}

const CODE = /^[a-z][a-z_]{0,63}$/;

export function createAgentNotifier(options: {
  readonly channels: readonly NotificationChannel[];
  readonly now?: () => Date;
  readonly onError?: (channel: string, kind: AgentNotificationKind) => void;
}): AgentNotifier {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async notify(draft: AgentNotificationDraft) {
      if (!AGENT_NOTIFICATION_KINDS.includes(draft.kind)) return;
      const at = draft.at ?? now();
      const code = draft.code ?? null;
      const notification: AgentNotification = Object.freeze({
        id: notificationIdOf(at, `${draft.organizationId}|${draft.recipientId}|${draft.key}`),
        organizationId: draft.organizationId,
        recipientId: draft.recipientId,
        kind: draft.kind,
        specialistId: draft.specialistId,
        taskId: draft.taskId,
        // Only a plain code is kept: nothing else from the fact reaches the person's screen.
        code: code !== null && CODE.test(code) ? code : null,
        otherSpecialistId: draft.otherSpecialistId ?? null,
        createdAt: at.toISOString() as IsoTimestamp,
        readAt: null,
        expiresAt: new Date(
          at.getTime() + NOTIFICATION_LIMITS.retentionDays * 86_400_000,
        ).toISOString() as IsoTimestamp,
      });
      for (const channel of options.channels) {
        try {
          await channel.deliver(notification);
        } catch {
          options.onError?.(channel.id, draft.kind);
        }
      }
    },
  });
}

/**
 * What a task's end tells its person (from `agent_task.finished`): finished, needs information,
 * stopped because its agent was paused or disabled, blocked waiting for access, or failed. A task
 * a person rejected the approval of tells them nothing new.
 */
export function notificationOfTaskEnd(end: {
  readonly outcome: string;
  readonly handoff: string | null;
  readonly code: string | null;
}): { readonly kind: AgentNotificationKind; readonly code: string | null } | null {
  const { outcome, handoff, code } = end;
  if (outcome === 'completed') {
    return handoff === 'missing_information'
      ? { kind: 'needs_info', code: null }
      : { kind: 'task_finished', code: null };
  }
  if (outcome === 'cancelled') return { kind: 'agent_stopped', code };
  if (outcome !== 'failed' || handoff === null) return null;
  if (handoff === 'policy') return { kind: 'agent_stopped', code };
  if (handoff === 'authorization_required') return { kind: 'task_blocked', code };
  return { kind: 'task_failed', code };
}

/** The part of a delivered domain event a notice reads (the event bus's `DomainEvent`). */
export interface NotifiableEvent {
  readonly id: string;
  readonly type: string;
  readonly organizationId: OrganizationId;
  readonly occurredAt: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

export const NOTIFIED_EVENT_TYPES = Object.freeze([
  'agent_task.finished',
  'agent_task.approval_required',
  'agent_handoff.proposed',
]);

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The event subscriber that turns agent facts into notices (registered in the worker's event bus).
 * The person is read from the stored task, in the event's organization; an event about a record
 * that is not that organization's makes no notice. Repeated deliveries make the same notice id.
 */
export function createAgentNotificationSubscriber(options: {
  readonly tasks: Pick<AgentTaskRepository, 'find'>;
  readonly handoffs?: Pick<AgentHandoffRepository, 'find'>;
  readonly notifier: AgentNotifier;
}): {
  readonly id: string;
  readonly types: readonly string[];
  handle(event: NotifiableEvent): Promise<void>;
} {
  const { tasks, handoffs, notifier } = options;
  return Object.freeze({
    id: 'agent_notifications',
    types: NOTIFIED_EVENT_TYPES,
    async handle(event: NotifiableEvent) {
      const organizationId = event.organizationId;
      const at = new Date(event.occurredAt);
      const when = Number.isNaN(at.getTime()) ? undefined : at;
      const base = { organizationId, key: event.id, ...(when === undefined ? {} : { at: when }) };
      if (event.type === 'agent_handoff.proposed') {
        if (handoffs === undefined) return;
        const handoff = await handoffs.find(organizationId, event.subject.id as ExecutionId);
        if (handoff === undefined) return;
        const task = await tasks.find(organizationId, handoff.parentTaskId);
        if (task === undefined) return;
        await notifier.notify({
          ...base,
          recipientId: task.requestedBy,
          kind: 'task_delegated',
          specialistId: handoff.requestingAgent.specialistId,
          taskId: task.id,
          code: handoff.state === 'refused' ? (handoff.refusal ?? null) : handoff.reason,
          otherSpecialistId: handoff.receivingAgent?.specialistId ?? null,
        });
        return;
      }
      const task = await tasks.find(organizationId, event.subject.id as ExecutionId);
      if (task === undefined) return;
      const recipient = { recipientId: task.requestedBy, specialistId: task.specialistId };
      if (event.type === 'agent_task.approval_required') {
        await notifier.notify({
          ...base,
          ...recipient,
          kind: 'approval_required',
          taskId: task.id,
          code: 'approval_required',
        });
        return;
      }
      if (event.type !== 'agent_task.finished') return;
      const end = notificationOfTaskEnd({
        outcome: text(event.data.outcome) ?? '',
        handoff: text(event.data.handoff),
        code: text(event.data.code),
      });
      if (end === null) return;
      await notifier.notify({ ...base, ...recipient, ...end, taskId: task.id });
    },
  });
}

export interface AgentNotificationPage {
  readonly items: readonly AgentNotification[];
  readonly nextCursor: string | null;
  readonly unread: number;
}

export interface AgentNotificationService {
  list(
    tenant: TenantContext,
    request?: { readonly cursor?: unknown; readonly limit?: unknown },
  ): Promise<AgentNotificationPage>;
  markRead(tenant: TenantContext, id: unknown): Promise<void>;
  markAllRead(tenant: TenantContext): Promise<number>;
}

/** The person's own notices: list, mark one read, mark all read. Only a person, only theirs. */
export function createAgentNotificationService(options: {
  readonly repository: AgentNotificationRepository;
  readonly now?: () => Date;
}): AgentNotificationService {
  const { repository } = options;
  const now = options.now ?? (() => new Date());
  const personOf = (tenant: TenantContext) => {
    if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
    if (tenant.actor !== 'user') throw new AgentTaskError('permission_denied');
    return {
      organizationId: tenant.organizationId as OrganizationId,
      recipientId: tenant.userId as UserId,
    };
  };
  const service: AgentNotificationService = {
    async list(tenant, request = {}) {
      const { organizationId, recipientId } = personOf(tenant);
      const { cursor, limit } = request;
      if (cursor !== undefined && !isNotificationId(cursor)) {
        throw new AgentTaskError('invalid_task', 'cursor');
      }
      const size = limit ?? NOTIFICATION_LIMITS.page;
      if (
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > NOTIFICATION_LIMITS.maxPage
      ) {
        throw new AgentTaskError('invalid_task', 'limit');
      }
      const at = now().toISOString();
      const page = await repository.page(organizationId, recipientId, {
        ...(cursor === undefined ? {} : { after: cursor }),
        limit: size,
      });
      const unread = await repository.unread(
        organizationId,
        recipientId,
        NOTIFICATION_LIMITS.unread,
      );
      const last = page.items.at(-1);
      return Object.freeze({
        // An expired notice is never shown, even before it is cleaned up.
        items: Object.freeze(page.items.filter((n) => n.expiresAt > at)),
        nextCursor: page.hasMore && last !== undefined ? last.id : null,
        unread,
      });
    },
    async markRead(tenant, id) {
      const { organizationId, recipientId } = personOf(tenant);
      if (!isNotificationId(id)) throw new AgentTaskError('notification_not_found');
      const marked = await repository.markRead(
        organizationId,
        recipientId,
        id,
        now().toISOString() as IsoTimestamp,
      );
      // Another person's notice is not found, exactly like a missing one.
      if (!marked) throw new AgentTaskError('notification_not_found');
    },
    async markAllRead(tenant) {
      const { organizationId, recipientId } = personOf(tenant);
      return repository.markAllRead(
        organizationId,
        recipientId,
        now().toISOString() as IsoTimestamp,
        NOTIFICATION_LIMITS.markAll,
      );
    },
  };
  return Object.freeze(service);
}
