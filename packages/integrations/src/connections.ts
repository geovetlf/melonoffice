import {
  actorOf,
  buildAuditEvent,
  type AuditEvent,
  type InMemoryAuditStore,
} from '@melonoffice/audit';
import { isChannelType } from '@melonoffice/conversations';
import type {
  ChannelConnection,
  ChannelConnectionId,
  ChannelType,
  IsoTimestamp,
  OrganizationId,
  WhatsAppAccount,
} from '@melonoffice/domain';
import type { EntitlementService } from '@melonoffice/entitlements';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { IntegrationError } from './errors.js';
import { isSecretRef, secretRefsFor } from './secrets.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Meta's numeric ids (phone number id, WhatsApp Business Account id). */
const META_ID = /^[0-9]{5,32}$/;
const DISPLAY_PHONE = /^\+?[0-9 ()-]{6,32}$/;
const MAX_NAME_LENGTH = 80;

export const isConnectionId = (value: unknown): value is ChannelConnectionId =>
  typeof value === 'string' && UUID.test(value);

const invalid = (detail: string): never => {
  throw new IntegrationError('invalid_connection', detail);
};

function checkName(value: unknown): string {
  if (typeof value !== 'string') invalid('displayName');
  const name = (value as string).trim();
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    invalid('displayName');
  }
  return name;
}

/** Only the known, non-sensitive account fields; anything else (a token, a secret) is refused. */
export function checkWhatsAppAccount(value: unknown): WhatsAppAccount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('account');
  const a = value as Record<string, unknown>;
  const allowed = ['phoneNumberId', 'businessAccountId', 'displayPhoneNumber'];
  if (Object.keys(a).some((k) => !allowed.includes(k))) invalid('account.fields');
  if (typeof a.phoneNumberId !== 'string' || !META_ID.test(a.phoneNumberId)) {
    invalid('account.phoneNumberId');
  }
  if (
    a.businessAccountId !== undefined &&
    (typeof a.businessAccountId !== 'string' || !META_ID.test(a.businessAccountId))
  ) {
    invalid('account.businessAccountId');
  }
  if (
    a.displayPhoneNumber !== undefined &&
    (typeof a.displayPhoneNumber !== 'string' || !DISPLAY_PHONE.test(a.displayPhoneNumber))
  ) {
    invalid('account.displayPhoneNumber');
  }
  return Object.freeze({
    phoneNumberId: a.phoneNumberId as string,
    ...(a.businessAccountId === undefined
      ? {}
      : { businessAccountId: a.businessAccountId as string }),
    ...(a.displayPhoneNumber === undefined
      ? {}
      : { displayPhoneNumber: a.displayPhoneNumber as string }),
  });
}

/** Checks a connection read back from storage; bad data is refused, never used. */
export function checkStoredConnection(c: ChannelConnection): ChannelConnection {
  if (
    !isConnectionId(c.id) ||
    !UUID.test(c.organizationId) ||
    !isChannelType(c.channel) ||
    (c.status !== 'active' && c.status !== 'disabled') ||
    !Object.values(c.secrets).every(isSecretRef) ||
    Object.keys(c.secrets).length !== 3 ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1
  ) {
    throw new IntegrationError('invalid_connection', 'stored');
  }
  checkWhatsAppAccount(c.account);
  for (const ref of Object.values(c.secrets)) {
    // A reference must name this connection's own secrets and nothing else.
    if (!ref.includes(`/secrets/channel-${c.id}-`)) {
      throw new IntegrationError('invalid_connection', 'secrets');
    }
  }
  return c;
}

/** A connection change and the audit events that record it, stored together or not at all. */
export interface ConnectionWrite {
  readonly connection: ChannelConnection;
  readonly events: readonly AuditEvent[];
}

/**
 * Where channel connections live: Firestore in the API (ADR-0033), memory in tests.
 */
export interface ChannelConnectionRepository {
  /** The connection, only when it belongs to the organization. */
  find(
    organizationId: OrganizationId,
    id: ChannelConnectionId,
  ): Promise<ChannelConnection | undefined>;
  /**
   * The connection by id alone, for webhook deliveries: the connection is what names the
   * organization, which is then taken from the stored record, never from the request.
   */
  findForDelivery(id: ChannelConnectionId): Promise<ChannelConnection | undefined>;
  list(organizationId: OrganizationId): Promise<readonly ChannelConnection[]>;
  create(write: ConnectionWrite): Promise<void>;
  update(
    organizationId: OrganizationId,
    id: ChannelConnectionId,
    change: (current: ChannelConnection) => ConnectionWrite,
  ): Promise<ChannelConnection>;
}

/** For tests and local runs only. */
export class InMemoryChannelConnectionRepository implements ChannelConnectionRepository {
  readonly #connections = new Map<string, ChannelConnection>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: ChannelConnectionId) {
    const c = this.#connections.get(id);
    return c?.organizationId === organizationId ? checkStoredConnection(c) : undefined;
  }

  async findForDelivery(id: ChannelConnectionId) {
    const c = this.#connections.get(id);
    return c === undefined ? undefined : checkStoredConnection(c);
  }

  async list(organizationId: OrganizationId) {
    return [...this.#connections.values()]
      .filter((c) => c.organizationId === organizationId)
      .map(checkStoredConnection)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async create({ connection, events }: ConnectionWrite) {
    if (this.#connections.has(connection.id)) throw new Error('connection already exists');
    checkStoredConnection(connection);
    this.audit?.append(events);
    this.#connections.set(connection.id, connection);
  }

  async update(
    organizationId: OrganizationId,
    id: ChannelConnectionId,
    change: (current: ChannelConnection) => ConnectionWrite,
  ) {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new IntegrationError('connection_not_found');
    const { connection, events } = change(current);
    checkNextConnection(current, connection);
    this.audit?.append(events);
    this.#connections.set(id, connection);
    return connection;
  }

  /** Test helper: stores a record as given, the way bad data or an operator change would. */
  put(connection: ChannelConnection): void {
    this.#connections.set(connection.id, connection);
  }
}

export function checkNextConnection(current: ChannelConnection, next: ChannelConnection): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.channel !== current.channel ||
    next.revision !== current.revision + 1 ||
    JSON.stringify(next.secrets) !== JSON.stringify(current.secrets)
  ) {
    throw new IntegrationError('invalid_connection', 'concurrency');
  }
  checkStoredConnection(next);
}

export interface NewConnectionInput {
  readonly channel: unknown;
  readonly displayName: unknown;
  readonly account: unknown;
}

/**
 * Channel connections of an organization (ADR-0033). Configuring or turning one off needs
 * `channel.manage` and a person acting directly: GIA and the runtime never change where
 * credentials point. A new connection also needs room under the plan's
 * `integrations.connectionsMax` (unset = 0 = denied, D-12). Server side only in CV-1: there is
 * no client route to create one.
 */
export interface ChannelConnectionService {
  create(tenant: TenantContext, input: NewConnectionInput): Promise<ChannelConnection>;
  disable(tenant: TenantContext, id: string): Promise<ChannelConnection>;
  list(tenant: TenantContext): Promise<readonly ChannelConnection[]>;
}

export interface ChannelConnectionServiceOptions {
  readonly repository: ChannelConnectionRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly entitlements: Pick<EntitlementService, 'getLimit'>;
  /**
   * The project whose Secret Manager holds the channel secrets. Unset: connections can be listed
   * and disabled, but none can be created (`secret_unavailable`).
   */
  readonly secretProjectId?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly requestId?: string;
}

export function createChannelConnectionService({
  repository,
  organizations,
  authorization,
  entitlements,
  secretProjectId,
  now = () => new Date(),
  newId = () => randomUUID(),
  requestId,
}: ChannelConnectionServiceOptions): ChannelConnectionService {
  async function organizationOf(
    tenant: TenantContext,
    permission: string,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new IntegrationError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new IntegrationError('permission_denied');
    }
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new IntegrationError('organization_inactive');
    }
    return organization.id;
  }

  const event = (
    tenant: TenantContext,
    connection: ChannelConnection,
    action: 'channel.connection_created' | 'channel.connection_disabled',
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId: connection.organizationId,
        target: { type: 'channel_connection', id: connection.id },
        reason: connection.channel,
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  return {
    async create(tenant, input) {
      const organizationId = await organizationOf(tenant, 'channel.manage');
      if (tenant.actor !== 'user') throw new IntegrationError('requires_user');
      if (secretProjectId === undefined) throw new IntegrationError('secret_unavailable');
      if (!isChannelType(input.channel)) invalid('channel');
      const channel = input.channel as ChannelType;
      const displayName = checkName(input.displayName);
      const account = checkWhatsAppAccount(input.account);
      const existing = await repository.list(organizationId);
      if (existing.some((c) => c.account.phoneNumberId === account.phoneNumberId)) {
        invalid('account.duplicate');
      }
      const limit = await entitlements.getLimit(tenant, 'integrations.connectionsMax');
      if (!limit.available) throw new IntegrationError('entitlements_unavailable');
      const active = existing.filter((c) => c.status === 'active').length;
      if (limit.value !== 'unlimited' && active + 1 > limit.value) {
        throw new IntegrationError('limit_reached');
      }
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const id = newId() as ChannelConnectionId;
      if (!isConnectionId(id)) invalid('id');
      const connection: ChannelConnection = Object.freeze({
        id,
        organizationId,
        channel,
        status: 'active',
        displayName,
        account,
        secrets: secretRefsFor(secretProjectId, id),
        createdAt: iso,
        createdBy: tenant.userId,
        updatedAt: iso,
        revision: 1,
      });
      await repository.create({
        connection,
        events: [event(tenant, connection, 'channel.connection_created', at)],
      });
      return connection;
    },

    async disable(tenant, id) {
      const organizationId = await organizationOf(tenant, 'channel.manage');
      if (tenant.actor !== 'user') throw new IntegrationError('requires_user');
      if (!isConnectionId(id)) throw new IntegrationError('connection_not_found');
      const at = now();
      return repository.update(organizationId, id, (current) => {
        if (current.status === 'disabled') throw new IntegrationError('connection_disabled');
        const connection: ChannelConnection = Object.freeze({
          ...current,
          status: 'disabled',
          updatedAt: at.toISOString() as IsoTimestamp,
          revision: current.revision + 1,
        });
        return {
          connection,
          events: [event(tenant, connection, 'channel.connection_disabled', at)],
        };
      });
    },

    async list(tenant) {
      const organizationId = await organizationOf(tenant, 'channel.read');
      return repository.list(organizationId);
    },
  };
}
