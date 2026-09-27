import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditTransition,
} from '@melonoffice/audit';
import { isDepartmentId, type DepartmentRepository } from '@melonoffice/departments';
import type {
  ChannelIdentity,
  ChannelType,
  Contact,
  ContactId,
  Conversation,
  ConversationId,
  ConversationStatus,
  DepartmentId,
  Message,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { ConversationError } from './errors.js';
import {
  CONVERSATION_TRANSITIONS,
  isChannelType,
  isContactId,
  isConversationId,
  isConversationStatus,
  isIsoTimestamp,
  isTag,
  isUuid,
  normalizeTags,
  type DeliveryStatusUpdate,
  type InboundMessage,
} from './model.js';
import type { ConversationRepository, ReceiveResult } from './repository.js';

export const MAX_CONVERSATIONS_LISTED = 100;
export const MAX_MESSAGES_LISTED = 200;
export const MAX_CONTACTS_LISTED = 100;

/**
 * Filters of the inbox list. All optional; every one that is given must match. Values are
 * checked, and an invalid one is refused rather than ignored.
 */
export interface ConversationFilter {
  readonly status?: ConversationStatus;
  readonly channel?: ChannelType;
  readonly assigneeId?: UserId;
  /** Only conversations nobody is responsible for. */
  readonly unassigned?: boolean;
  readonly departmentId?: DepartmentId;
  readonly contactId?: ContactId;
  readonly tag?: string;
  /** Last message at or after this time. */
  readonly since?: string;
  /** Last message before this time. */
  readonly until?: string;
  readonly limit?: number;
}

/** Who is responsible: a member, a department, both, or nobody (`null` clears). */
export interface AssignmentChange {
  readonly assigneeId?: UserId | null;
  readonly departmentId?: DepartmentId | null;
}

export interface TagChange {
  readonly add?: readonly unknown[];
  readonly remove?: readonly unknown[];
}

/**
 * The human inbox (ADR-0033). Every method works on the organization of a resolved
 * `TenantContext`, never on an id the caller passes, and nothing here calls a model, a tool or a
 * provider: it is deterministic and costs no credits. Reading needs `conversation.read` or
 * `contact.read`; changing needs `conversation.manage`, checked again here so a caller that forgot
 * the route check still cannot change anything.
 */
export interface ConversationService {
  list(tenant: TenantContext, filter?: ConversationFilter): Promise<readonly Conversation[]>;
  /** `conversation_not_found` for an unknown id or another organization's alike. */
  get(tenant: TenantContext, id: string): Promise<Conversation>;
  messages(
    tenant: TenantContext,
    id: string,
    options?: { readonly limit?: number },
  ): Promise<readonly Message[]>;
  assign(tenant: TenantContext, id: string, change: AssignmentChange): Promise<Conversation>;
  changeStatus(tenant: TenantContext, id: string, status: unknown): Promise<Conversation>;
  changeTags(tenant: TenantContext, id: string, change: TagChange): Promise<Conversation>;
  contacts(tenant: TenantContext): Promise<readonly Contact[]>;
  contact(
    tenant: TenantContext,
    id: string,
  ): Promise<{ readonly contact: Contact; readonly identities: readonly ChannelIdentity[] }>;
}

export interface ConversationServiceOptions {
  readonly repository: ConversationRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization' | 'findMembership'>;
  readonly departments: Pick<DepartmentRepository, 'find'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  readonly requestId?: string;
}

type ConversationAction = Extract<AuditAction, `conversation.${string}`>;

export function createConversationService({
  repository,
  organizations,
  departments,
  authorization,
  now = () => new Date(),
  requestId,
}: ConversationServiceOptions): ConversationService {
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

  /**
   * Changing the inbox (assignment, status, tags) is a person's act in CV-1 (DG-1): GIA and the
   * runtime never assign, route or close a conversation, even where RBAC would allow the user
   * behind them.
   */
  async function managerOf(tenant: TenantContext): Promise<OrganizationId> {
    const organizationId = await organizationOf(tenant, 'conversation.manage');
    if (tenant.actor !== 'user') throw new ConversationError('requires_user');
    return organizationId;
  }

  const idOf = (id: string): ConversationId => {
    // A malformed id cannot exist: answered like any unknown id, without a lookup.
    if (!isConversationId(id)) throw new ConversationError('conversation_not_found');
    return id;
  };

  const event = (
    tenant: TenantContext,
    conversation: Conversation,
    action: ConversationAction,
    at: Date,
    fields: { readonly transition?: AuditTransition; readonly reason?: string } = {},
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId: conversation.organizationId,
        target: { type: 'conversation', id: conversation.id },
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  async function get(tenant: TenantContext, id: string): Promise<Conversation> {
    const organizationId = await organizationOf(tenant, 'conversation.read');
    const conversation = await repository.findConversation(organizationId, idOf(id));
    if (conversation === undefined) throw new ConversationError('conversation_not_found');
    return conversation;
  }

  const limitOf = (value: number | undefined, max: number): number => {
    if (value === undefined) return max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new ConversationError('invalid_request', 'limit');
    }
    return value;
  };

  function checkFilter(filter: ConversationFilter): void {
    const bad = (field: string): never => {
      throw new ConversationError('invalid_request', field);
    };
    if (filter.status !== undefined && !isConversationStatus(filter.status)) bad('status');
    if (filter.channel !== undefined && !isChannelType(filter.channel)) bad('channel');
    if (filter.assigneeId !== undefined && !isUuid(filter.assigneeId)) bad('assigneeId');
    if (filter.assigneeId !== undefined && filter.unassigned === true) bad('unassigned');
    if (filter.departmentId !== undefined && !isDepartmentId(filter.departmentId)) {
      bad('departmentId');
    }
    if (filter.contactId !== undefined && !isContactId(filter.contactId)) bad('contactId');
    if (filter.tag !== undefined && !isTag(filter.tag)) bad('tag');
    if (filter.since !== undefined && !isIsoTimestamp(filter.since)) bad('since');
    if (filter.until !== undefined && !isIsoTimestamp(filter.until)) bad('until');
  }

  return {
    async list(tenant, filter = {}) {
      const organizationId = await organizationOf(tenant, 'conversation.read');
      checkFilter(filter);
      const limit = limitOf(filter.limit, MAX_CONVERSATIONS_LISTED);
      const all = await repository.listConversations(organizationId);
      return all
        .filter(
          (c) =>
            (filter.status === undefined || c.status === filter.status) &&
            (filter.channel === undefined || c.channel === filter.channel) &&
            (filter.assigneeId === undefined || c.assigneeId === filter.assigneeId) &&
            (filter.unassigned !== true || c.assigneeId === undefined) &&
            (filter.departmentId === undefined || c.departmentId === filter.departmentId) &&
            (filter.contactId === undefined || c.contactId === filter.contactId) &&
            (filter.tag === undefined || c.tags.includes(filter.tag)) &&
            (filter.since === undefined || c.lastMessageAt >= filter.since) &&
            (filter.until === undefined || c.lastMessageAt < filter.until),
        )
        .slice(0, limit);
    },

    get,

    async messages(tenant, id, options = {}) {
      const conversation = await get(tenant, id);
      const limit = limitOf(options.limit, MAX_MESSAGES_LISTED);
      const all = await repository.listMessages(conversation.organizationId, conversation.id);
      // The latest `limit` messages, still oldest first.
      return all.slice(Math.max(0, all.length - limit));
    },

    async assign(tenant, id, change) {
      const organizationId = await managerOf(tenant);
      const conversationId = idOf(id);
      const { assigneeId, departmentId } = change;
      if (assigneeId === undefined && departmentId === undefined) {
        throw new ConversationError('invalid_request', 'assignment');
      }
      if (assigneeId !== undefined && assigneeId !== null) {
        if (!isUuid(assigneeId)) throw new ConversationError('invalid_request', 'assigneeId');
        const membership = await organizations.findMembership(organizationId, assigneeId);
        if (membership?.status !== 'active') throw new ConversationError('assignee_not_member');
      }
      if (departmentId !== undefined && departmentId !== null) {
        if (!isDepartmentId(departmentId)) {
          throw new ConversationError('invalid_request', 'departmentId');
        }
        const department = await departments.find(organizationId, departmentId);
        if (department === undefined) throw new ConversationError('department_not_found');
      }
      const at = now();
      return repository.updateConversation(organizationId, conversationId, (current) => {
        const { assigneeId: previousAssignee, departmentId: previousDepartment, ...rest } = current;
        const nextAssignee = assigneeId === undefined ? previousAssignee : assigneeId;
        const nextDepartment = departmentId === undefined ? previousDepartment : departmentId;
        const conversation: Conversation = Object.freeze({
          ...rest,
          ...(nextAssignee === null || nextAssignee === undefined
            ? {}
            : { assigneeId: nextAssignee }),
          ...(nextDepartment === null || nextDepartment === undefined
            ? {}
            : { departmentId: nextDepartment }),
          updatedAt: at.toISOString() as Conversation['updatedAt'],
          revision: current.revision + 1,
        });
        const reason =
          conversation.assigneeId === undefined && conversation.departmentId === undefined
            ? 'unassigned'
            : 'assigned';
        return {
          conversation,
          events: [event(tenant, conversation, 'conversation.assigned', at, { reason })],
        };
      });
    },

    async changeStatus(tenant, id, status) {
      const organizationId = await managerOf(tenant);
      const conversationId = idOf(id);
      if (!isConversationStatus(status)) throw new ConversationError('invalid_request', 'status');
      const at = now();
      return repository.updateConversation(organizationId, conversationId, (current) => {
        if (!CONVERSATION_TRANSITIONS[current.status].includes(status as never)) {
          throw new ConversationError('invalid_transition');
        }
        const conversation: Conversation = Object.freeze({
          ...current,
          status,
          updatedAt: at.toISOString() as Conversation['updatedAt'],
          revision: current.revision + 1,
        });
        return {
          conversation,
          events: [
            event(tenant, conversation, 'conversation.status_changed', at, {
              transition: { from: current.status, to: status },
            }),
          ],
        };
      });
    },

    async changeTags(tenant, id, change) {
      const organizationId = await managerOf(tenant);
      const conversationId = idOf(id);
      const add = change.add ?? [];
      const remove = change.remove ?? [];
      if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length === 0) {
        throw new ConversationError('invalid_request', 'tags');
      }
      normalizeTags([...add, ...remove]);
      const at = now();
      return repository.updateConversation(organizationId, conversationId, (current) => {
        const removed = new Set(remove as string[]);
        const tags = normalizeTags([...current.tags.filter((t) => !removed.has(t)), ...add]);
        const conversation: Conversation = Object.freeze({
          ...current,
          tags,
          updatedAt: at.toISOString() as Conversation['updatedAt'],
          revision: current.revision + 1,
        });
        return {
          conversation,
          events: [event(tenant, conversation, 'conversation.tags_changed', at)],
        };
      });
    },

    async contacts(tenant) {
      const organizationId = await organizationOf(tenant, 'contact.read');
      return (await repository.listContacts(organizationId)).slice(0, MAX_CONTACTS_LISTED);
    },

    async contact(tenant, id) {
      const organizationId = await organizationOf(tenant, 'contact.read');
      if (!isContactId(id)) throw new ConversationError('contact_not_found');
      const contact = await repository.findContact(organizationId, id);
      if (contact === undefined) throw new ConversationError('contact_not_found');
      return { contact, identities: await repository.listIdentities(organizationId, id) };
    },
  };
}

/**
 * Stores what a channel delivered (ADR-0033). It is not a user action: the channel connection,
 * resolved and verified by the caller, is the only authority, and it can only store messages and
 * delivery statuses. It never runs a model, a tool or a workflow.
 */
export interface ConversationIngress {
  receive(inbound: InboundMessage): Promise<ReceiveResult>;
  applyStatus(update: DeliveryStatusUpdate): Promise<{ readonly applied: boolean }>;
}

export function createConversationIngress({
  repository,
  now = () => new Date(),
  newId = () => randomUUID(),
}: {
  readonly repository: ConversationRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
}): ConversationIngress {
  return {
    receive: (inbound) => repository.receive(inbound, newId() as ContactId, now()),
    applyStatus: (update) => repository.applyStatus(update),
  };
}
