import {
  actorOf,
  buildAuditEvent,
  type AuditActor,
  type AuditEvent,
  type InMemoryAuditStore,
} from '@melonoffice/audit';
import { isChannelType } from '@melonoffice/conversations';
import type {
  ChannelCapabilities,
  ChannelConnection,
  ChannelConnectionId,
  ChannelConnectionStatus,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { EntitlementService } from '@melonoffice/entitlements';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import type { ConnectionCheck } from './adapter.js';
import { IntegrationError } from './errors.js';
import { canTransition, isConnectionStatus, occupiesSlot } from './lifecycle.js';
import { isIntegrationCategory, isProviderId, type IntegrationRegistry } from './registry.js';
import { isSecretRef, secretRefsFor } from './secrets.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME_LENGTH = 80;
const ACCOUNT_VALUE = /^[A-Za-z0-9 +()_.-]{1,64}$/;
const STATUS_REASON = /^[a-z][a-z0-9_]{1,63}$/;

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

const CAPABILITY_FLAGS = [
  'inboundText',
  'inboundMedia',
  'outboundText',
  'outboundMedia',
  'outboundTemplates',
  'deliveryStatus',
] as const;

function isCapabilities(value: unknown): value is ChannelCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    CAPABILITY_FLAGS.every((flag) => typeof c[flag] === 'boolean') &&
    Number.isSafeInteger(c.maxOutboundTextLength) &&
    (c.maxOutboundTextLength as number) > 0 &&
    (c.serviceWindowMs === undefined ||
      (Number.isSafeInteger(c.serviceWindowMs) && (c.serviceWindowMs as number) > 0))
  );
}

/**
 * Checks a connection read back from storage; bad data is refused, never used. Provider-neutral:
 * the account is only checked to be a few short public values here, and its adapter checks it
 * again, field by field, whenever the Integration Engine uses it.
 */
export function checkStoredConnection(c: ChannelConnection): ChannelConnection {
  const account = c.account as unknown;
  if (
    !isConnectionId(c.id) ||
    !UUID.test(c.organizationId) ||
    !isProviderId(c.provider) ||
    !isIntegrationCategory(c.category) ||
    !isChannelType(c.channel) ||
    !isConnectionStatus(c.status) ||
    (c.statusReason !== undefined &&
      (c.status !== 'error' || !STATUS_REASON.test(c.statusReason))) ||
    typeof account !== 'object' ||
    account === null ||
    Object.keys(account).length > 8 ||
    !Object.values(account).every((v) => typeof v === 'string' && ACCOUNT_VALUE.test(v)) ||
    !isCapabilities(c.capabilities) ||
    !Object.values(c.secrets).every(isSecretRef) ||
    Object.keys(c.secrets).length !== 3 ||
    !UUID.test(c.createdBy) ||
    !UUID.test(c.updatedBy) ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1
  ) {
    throw new IntegrationError('invalid_connection', 'stored');
  }
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
 * Where channel connections live: Firestore in the API and the worker (ADR-0033), memory in
 * tests.
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
  /** Reads the current record, applies `change` and stores the result, atomically. */
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

/**
 * What a change may alter: the name, the status (along an allowed transition), its reason and
 * when it was last checked. Never the organization, the provider, the channel or where the
 * secrets are. The account only gains the business account id it lacked, once (ADR-0046); the
 * capabilities are taken again from the provider's adapter only when a check connects it, so a
 * connection made before its adapter could do more learns it by being checked again. One
 * revision at a time.
 */
export function checkNextConnection(current: ChannelConnection, next: ChannelConnection): void {
  const accountChanged = JSON.stringify(next.account) !== JSON.stringify(current.account);
  const accountGained =
    current.account.businessAccountId === undefined &&
    next.account.businessAccountId !== undefined &&
    JSON.stringify({ ...next.account, businessAccountId: undefined }) ===
      JSON.stringify({ ...current.account, businessAccountId: undefined });
  const capabilitiesChanged =
    JSON.stringify(next.capabilities) !== JSON.stringify(current.capabilities);
  const connecting = current.status === 'connecting' && next.status === 'connected';
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.provider !== current.provider ||
    next.category !== current.category ||
    next.channel !== current.channel ||
    next.revision !== current.revision + 1 ||
    next.createdAt !== current.createdAt ||
    next.createdBy !== current.createdBy ||
    (accountChanged && !accountGained) ||
    (capabilitiesChanged && !connecting) ||
    JSON.stringify(next.secrets) !== JSON.stringify(current.secrets)
  ) {
    throw new IntegrationError('invalid_connection', 'concurrency');
  }
  if (next.status !== current.status && !canTransition(current.status, next.status)) {
    throw new IntegrationError('invalid_transition', `${current.status}->${next.status}`);
  }
  checkStoredConnection(next);
}

export interface NewConnectionInput {
  /** The provider, e.g. `meta_whatsapp_cloud`. It names the channel and the category. */
  readonly provider: unknown;
  readonly displayName: unknown;
  readonly account: unknown;
}

/** Checks a connection's credentials with its provider: the Integration Engine's `validate`. */
export interface ConnectionChecker {
  validate(connection: ChannelConnection): Promise<ConnectionCheck>;
}

/**
 * The organization's connections to outside services (ADR-0033, lifecycle and permissions in
 * ADR-0044). Every change is made by a person acting directly (GIA and the runtime never change
 * where a connection points or whether it is on) and is audited in the same write. Each kind of
 * change has its own permission:
 *
 * - `channel.read`: see connections (never secrets);
 * - `channel.create`: add one, within the plan (`integrations.categoriesAllowed`,
 *   `integrations.connectionsMax`; unset = denied);
 * - `channel.update`: rename, check with the provider (connect), pause;
 * - `channel.disconnect`: turn off, which frees its slot;
 * - `channel.delete`: delete (revoke), for good.
 *
 * Using a connection is not here: it is sending in a conversation (`conversation.send`, or an
 * agent's `message_send`), always through the tool gate and the Integration Engine.
 */
export interface ChannelConnectionService {
  list(tenant: TenantContext): Promise<readonly ChannelConnection[]>;
  get(tenant: TenantContext, id: string): Promise<ChannelConnection>;
  create(tenant: TenantContext, input: NewConnectionInput): Promise<ChannelConnection>;
  rename(tenant: TenantContext, id: string, displayName: unknown): Promise<ChannelConnection>;
  /** Checks the credentials with the provider: `connected`, or `error` with the provider's code. */
  connect(tenant: TenantContext, id: string): Promise<ChannelConnection>;
  /**
   * Records the provider business account a connection was made without (ADR-0046): once, never
   * changed after. Templates are read from it.
   */
  setBusinessAccount(
    tenant: TenantContext,
    id: string,
    businessAccountId: unknown,
  ): Promise<ChannelConnection>;
  pause(tenant: TenantContext, id: string): Promise<ChannelConnection>;
  disconnect(tenant: TenantContext, id: string): Promise<ChannelConnection>;
  /** Deletes it: `revoked`, kept only as history. Its secrets are deleted by an operator. */
  revoke(tenant: TenantContext, id: string): Promise<ChannelConnection>;
}

export interface ChannelConnectionServiceOptions {
  readonly repository: ChannelConnectionRepository;
  readonly registry: IntegrationRegistry;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly entitlements: Pick<EntitlementService, 'entitlementsOf'>;
  /** The Integration Engine. Unset: no connection can be checked (`provider_unavailable`). */
  readonly checker?: ConnectionChecker;
  /**
   * The project whose Secret Manager holds the channel secrets. Unset: connections can be listed
   * and turned off, but none can be created (`secret_unavailable`).
   */
  readonly secretProjectId?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly requestId?: string;
}

type ConnectionAction =
  | 'channel.connection_created'
  | 'channel.connection_updated'
  | 'channel.connection_checked'
  | 'channel.connection_paused'
  | 'channel.connection_disconnected'
  | 'channel.connection_revoked'
  | 'channel.connection_failed';

/** The audit event of a connection change. The reason is a status or a stable code. */
export function connectionEventOf(
  actor: AuditActor,
  connection: ChannelConnection,
  action: ConnectionAction,
  at: Date,
  options: {
    readonly result?: 'success' | 'failure';
    readonly reason?: string;
    readonly requestId?: string;
  } = {},
): AuditEvent {
  return buildAuditEvent(
    {
      action,
      result: options.result ?? 'success',
      actor,
      organizationId: connection.organizationId,
      target: { type: 'channel_connection', id: connection.id },
      reference: `provider:${connection.provider}`,
      reason: options.reason ?? connection.status,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      source: 'api',
    },
    at,
  );
}

export function createChannelConnectionService({
  repository,
  registry,
  organizations,
  authorization,
  entitlements,
  checker,
  secretProjectId,
  now = () => new Date(),
  newId = () => randomUUID(),
  requestId,
}: ChannelConnectionServiceOptions): ChannelConnectionService {
  async function organizationOf(
    tenant: TenantContext,
    permission: string,
    direct = true,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new IntegrationError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new IntegrationError('permission_denied');
    }
    // A change is a person's own act: never GIA, never the runtime.
    if (direct && tenant.actor !== 'user') throw new IntegrationError('requires_user');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new IntegrationError('organization_inactive');
    }
    return organization.id;
  }

  /** Room for one more connection of this category under the organization's plan. */
  async function checkPlan(
    tenant: TenantContext,
    organizationId: OrganizationId,
    category: ChannelConnection['category'],
    excluding?: ChannelConnectionId,
  ): Promise<void> {
    const plan = await entitlements.entitlementsOf(tenant);
    if (plan.status !== 'active') throw new IntegrationError('entitlements_unavailable');
    if (!plan.values['integrations.categoriesAllowed'].includes(category)) {
      throw new IntegrationError('category_not_allowed');
    }
    const limit = plan.values['integrations.connectionsMax'];
    const used = (await repository.list(organizationId)).filter(
      (c) => c.id !== excluding && occupiesSlot(c),
    ).length;
    if (limit !== 'unlimited' && used + 1 > limit) throw new IntegrationError('limit_reached');
  }

  /** Changes one connection of the tenant's organization, as the person, audited in the same write. */
  async function change(
    tenant: TenantContext,
    permission: string,
    id: string,
    apply: (
      current: ChannelConnection,
      at: Date,
    ) => {
      readonly next: Partial<
        Pick<
          ChannelConnection,
          'status' | 'displayName' | 'lastValidatedAt' | 'capabilities' | 'account'
        >
      > & {
        readonly statusReason?: string | undefined;
      };
      readonly action: ConnectionAction;
      readonly result?: 'success' | 'failure';
      readonly reason?: string;
    },
  ): Promise<ChannelConnection> {
    const organizationId = await organizationOf(tenant, permission);
    if (!isConnectionId(id)) throw new IntegrationError('connection_not_found');
    const userId = (tenant as { readonly userId: UserId }).userId;
    return repository.update(organizationId, id, (current) => {
      const at = now();
      const { next, action, result, reason } = apply(current, at);
      const status = next.status ?? current.status;
      if (status !== current.status && !canTransition(current.status, status)) {
        throw new IntegrationError('invalid_transition', `${current.status}->${status}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { statusReason: _dropped, ...rest } = current;
      const { statusReason: asked, ...fields } = next;
      const statusReason = 'statusReason' in next ? asked : current.statusReason;
      const connection: ChannelConnection = Object.freeze({
        ...rest,
        ...fields,
        status,
        ...(status === 'error' && statusReason !== undefined ? { statusReason } : {}),
        updatedAt: at.toISOString() as IsoTimestamp,
        updatedBy: userId,
        revision: current.revision + 1,
      });
      return {
        connection,
        events: [
          connectionEventOf(actorOf(tenant as never), connection, action, at, {
            ...(result === undefined ? {} : { result }),
            ...(reason === undefined ? {} : { reason }),
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ],
      };
    });
  }

  const moveTo =
    (status: ChannelConnectionStatus, action: ConnectionAction) => (current: ChannelConnection) => {
      if (current.status === status) throw new IntegrationError('invalid_transition', status);
      return { next: { status, statusReason: undefined }, action };
    };

  return {
    async list(tenant) {
      const organizationId = await organizationOf(tenant, 'channel.read', false);
      return repository.list(organizationId);
    },

    async get(tenant, id) {
      const organizationId = await organizationOf(tenant, 'channel.read', false);
      const connection = isConnectionId(id) ? await repository.find(organizationId, id) : undefined;
      if (connection === undefined) throw new IntegrationError('connection_not_found');
      return connection;
    },

    async create(tenant, input) {
      const organizationId = await organizationOf(tenant, 'channel.create');
      if (secretProjectId === undefined) throw new IntegrationError('secret_unavailable');
      const adapter = isProviderId(input.provider) ? registry.find(input.provider) : undefined;
      if (adapter === undefined) invalid('provider');
      const provider = adapter as NonNullable<typeof adapter>;
      const displayName = checkName(input.displayName);
      const account = provider.checkAccount(input.account);
      const accountId = provider.accountIdOf(account);
      const existing = await repository.list(organizationId);
      if (
        existing.some(
          (c) =>
            c.provider === provider.provider &&
            c.status !== 'revoked' &&
            provider.accountIdOf(c.account) === accountId,
        )
      ) {
        invalid('account.duplicate');
      }
      await checkPlan(tenant, organizationId, provider.category);
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const id = newId() as ChannelConnectionId;
      if (!isConnectionId(id)) invalid('id');
      const userId = (tenant as { readonly userId: UserId }).userId;
      const connection: ChannelConnection = Object.freeze({
        id,
        organizationId,
        provider: provider.provider,
        category: provider.category,
        channel: provider.channel,
        status: 'created',
        displayName,
        account,
        capabilities: provider.capabilities,
        secrets: secretRefsFor(secretProjectId, id),
        createdAt: iso,
        createdBy: userId,
        updatedAt: iso,
        updatedBy: userId,
        revision: 1,
      });
      await repository.create({
        connection,
        events: [
          connectionEventOf(
            actorOf(tenant as never),
            connection,
            'channel.connection_created',
            at,
            {
              ...(requestId === undefined ? {} : { requestId }),
            },
          ),
        ],
      });
      return connection;
    },

    rename(tenant, id, displayName) {
      const name = checkName(displayName);
      return change(tenant, 'channel.update', id, (current) => {
        if (current.status === 'revoked') throw new IntegrationError('connection_revoked');
        return {
          next: { displayName: name },
          action: 'channel.connection_updated',
          reason: 'renamed',
        };
      });
    },

    async connect(tenant, id) {
      const organizationId = await organizationOf(tenant, 'channel.update');
      if (!isConnectionId(id)) throw new IntegrationError('connection_not_found');
      const current = await repository.find(organizationId, id);
      if (current === undefined) throw new IntegrationError('connection_not_found');
      if (current.status === 'revoked') throw new IntegrationError('connection_revoked');
      if (current.status === 'disconnected') {
        // Connecting again takes a slot back: the plan is asked again.
        await checkPlan(tenant, organizationId, current.category, current.id);
      }
      const connecting = await change(tenant, 'channel.update', id, () => ({
        next: { status: 'connecting', statusReason: undefined },
        action: 'channel.connection_updated',
        reason: 'connecting',
      }));
      let check: ConnectionCheck;
      try {
        check =
          checker === undefined
            ? { status: 'unavailable', code: 'provider_unavailable' }
            : await checker.validate(connecting);
      } catch {
        check = { status: 'unavailable', code: 'provider_unavailable' };
      }
      return change(tenant, 'channel.update', id, (latest, at) => {
        // Someone else changed it meanwhile (turned off, deleted): their change stands.
        if (latest.status !== 'connecting' || latest.revision !== connecting.revision) {
          throw new IntegrationError('invalid_transition', 'concurrent_change');
        }
        const adapter = registry.find(latest.provider);
        return check.status === 'valid'
          ? {
              next: {
                status: 'connected',
                statusReason: undefined,
                lastValidatedAt: at.toISOString() as IsoTimestamp,
                // What its provider's adapter can do now (ADR-0046).
                ...(adapter === undefined ? {} : { capabilities: adapter.capabilities }),
              },
              action: 'channel.connection_checked',
              reason: 'connected',
            }
          : {
              next: { status: 'error', statusReason: check.code },
              action: 'channel.connection_checked',
              result: 'failure',
              reason: check.code,
            };
      });
    },

    setBusinessAccount(tenant, id, businessAccountId) {
      return change(tenant, 'channel.update', id, (current) => {
        if (current.status === 'revoked') throw new IntegrationError('connection_revoked');
        if (current.account.businessAccountId !== undefined) {
          throw new IntegrationError('invalid_connection', 'account.businessAccountId');
        }
        const adapter = registry.find(current.provider);
        if (adapter === undefined) throw new IntegrationError('invalid_connection', 'provider');
        // The adapter checks the account as it would a new one.
        const account = adapter.checkAccount({ ...current.account, businessAccountId });
        return {
          next: { account },
          action: 'channel.connection_updated',
          reason: 'business_account_set',
        };
      });
    },

    pause: (tenant, id) =>
      change(tenant, 'channel.update', id, moveTo('paused', 'channel.connection_paused')),

    disconnect: (tenant, id) =>
      change(
        tenant,
        'channel.disconnect',
        id,
        moveTo('disconnected', 'channel.connection_disconnected'),
      ),

    revoke: (tenant, id) =>
      change(tenant, 'channel.delete', id, moveTo('revoked', 'channel.connection_revoked')),
  };
}
