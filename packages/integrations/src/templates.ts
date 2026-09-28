import {
  actorOf,
  buildAuditEvent,
  type AuditEvent,
  type InMemoryAuditStore,
} from '@melonoffice/audit';
import { isTemplateId, TEMPLATE_LANGUAGE, TEMPLATE_NAME } from '@melonoffice/conversations';
import type {
  ChannelConnection,
  ChannelConnectionId,
  ChannelTemplate,
  ChannelTemplateId,
  ChannelTemplateSpec,
  IsoTimestamp,
  OrganizationId,
  OutboundMediaRef,
  TemplateValues,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { createHash } from 'node:crypto';
import type { ChannelConnectionRepository } from './connections.js';
import { isConnectionId } from './connections.js';
import { IntegrationError } from './errors.js';

/**
 * An organization's message templates (CV-6D phase 2, ADR-0046). A template is created and
 * approved in the provider's own tools (Meta's WhatsApp Manager); MelonOffice never writes one.
 * A person registers it on a connection by name and language, and the Integration Engine asks the
 * provider whether it exists, is approved, and what it needs. Only then is it `active`, and a
 * message is built from it only when its values fit what the provider said, exactly: a missing,
 * extra or malformed value is refused before any provider call, and never retried.
 */

export const CHANNEL_TEMPLATE_STATUSES = ['pending', 'active', 'invalid', 'disabled'] as const;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most values of one kind a provider template takes that we accept. */
const MAX_PARAMETERS = 50;

/** One template per connection, name and language: registering it twice finds the same one. */
export function templateIdFor(
  organizationId: OrganizationId,
  connectionId: ChannelConnectionId,
  name: string,
  language: string,
): ChannelTemplateId {
  return createHash('sha256')
    .update(
      ['melonoffice.channel-template', organizationId, connectionId, name, language].join('\n'),
    )
    .digest('hex') as ChannelTemplateId;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PARAMETERS;

export function isTemplateSpec(value: unknown): value is ChannelTemplateSpec {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  const header = s.header as Record<string, unknown> | undefined;
  const headerOk =
    typeof header === 'object' &&
    header !== null &&
    (header.format === 'none' ||
      (header.format === 'text' && isCount(header.parameters)) ||
      header.format === 'image' ||
      header.format === 'document' ||
      header.format === 'video');
  return (
    headerOk &&
    isCount(s.bodyParameters) &&
    Array.isArray(s.urlButtons) &&
    s.urlButtons.length <= 10 &&
    s.urlButtons.every(
      (b) =>
        typeof b === 'object' &&
        b !== null &&
        Number.isInteger((b as { index?: unknown }).index) &&
        ((b as { index: number }).index as number) >= 0 &&
        ((b as { index: number }).index as number) <= 9,
    )
  );
}

/** Checks a template read back from storage: bad data is refused, never used. */
export function checkStoredTemplate(t: ChannelTemplate): ChannelTemplate {
  if (
    !isTemplateId(t.id) ||
    !UUID.test(t.organizationId) ||
    !isConnectionId(t.connectionId) ||
    t.id !== templateIdFor(t.organizationId, t.connectionId, t.name, t.language) ||
    t.channel !== 'whatsapp' ||
    !TEMPLATE_NAME.test(t.name) ||
    !TEMPLATE_LANGUAGE.test(t.language) ||
    !(CHANNEL_TEMPLATE_STATUSES as readonly string[]).includes(t.status) ||
    (t.statusReason !== undefined && !CODE.test(t.statusReason)) ||
    (t.category !== undefined && !CODE.test(t.category)) ||
    (t.status === 'active' && !isTemplateSpec(t.spec)) ||
    (t.spec !== undefined && !isTemplateSpec(t.spec)) ||
    !UUID.test(t.createdBy) ||
    !UUID.test(t.updatedBy) ||
    !Number.isSafeInteger(t.revision) ||
    t.revision < 1
  ) {
    throw new IntegrationError('invalid_connection', 'stored_template');
  }
  return t;
}

/** A template change and its audit events, stored together or not at all. */
export interface TemplateWrite {
  readonly template: ChannelTemplate;
  readonly events: readonly AuditEvent[];
}

/** Where templates live: Firestore in the API and the worker, memory in tests. */
export interface ChannelTemplateRepository {
  /** The template, only when it belongs to the organization. */
  find(organizationId: OrganizationId, id: ChannelTemplateId): Promise<ChannelTemplate | undefined>;
  list(
    organizationId: OrganizationId,
    connectionId: ChannelConnectionId,
  ): Promise<readonly ChannelTemplate[]>;
  /** Stores a new template; `false` when that one already exists (and nothing is written). */
  create(write: TemplateWrite): Promise<boolean>;
  update(
    organizationId: OrganizationId,
    id: ChannelTemplateId,
    change: (current: ChannelTemplate) => TemplateWrite,
  ): Promise<ChannelTemplate>;
}

/** What a change may alter: status, its reason, what the provider said, and when. */
export function checkNextTemplate(current: ChannelTemplate, next: ChannelTemplate): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.connectionId !== current.connectionId ||
    next.channel !== current.channel ||
    next.name !== current.name ||
    next.language !== current.language ||
    next.createdAt !== current.createdAt ||
    next.createdBy !== current.createdBy ||
    next.revision !== current.revision + 1
  ) {
    throw new IntegrationError('invalid_connection', 'template_concurrency');
  }
  checkStoredTemplate(next);
}

/** For tests and local runs only. */
export class InMemoryChannelTemplateRepository implements ChannelTemplateRepository {
  readonly #templates = new Map<string, ChannelTemplate>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: ChannelTemplateId) {
    const t = this.#templates.get(id);
    return t?.organizationId === organizationId ? checkStoredTemplate(t) : undefined;
  }

  async list(organizationId: OrganizationId, connectionId: ChannelConnectionId) {
    return [...this.#templates.values()]
      .filter((t) => t.organizationId === organizationId && t.connectionId === connectionId)
      .map(checkStoredTemplate)
      .sort((a, b) => (a.name + a.language < b.name + b.language ? -1 : 1));
  }

  async create({ template, events }: TemplateWrite) {
    checkStoredTemplate(template);
    if (this.#templates.has(template.id)) return false;
    this.audit?.append(events);
    this.#templates.set(template.id, template);
    return true;
  }

  async update(
    organizationId: OrganizationId,
    id: ChannelTemplateId,
    change: (current: ChannelTemplate) => TemplateWrite,
  ) {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new IntegrationError('template_not_found');
    const { template, events } = change(current);
    checkNextTemplate(current, template);
    this.audit?.append(events);
    this.#templates.set(id, template);
    return template;
  }

  /** Test helper: stores a record as given. */
  put(template: ChannelTemplate): void {
    this.#templates.set(template.id, template);
  }
}

/**
 * What the provider said about a template. `approved`: it exists in that language, approved, and
 * needs what `spec` says. `invalid`: it does not, with a stable code. `unavailable`: no answer.
 */
export type TemplateCheck =
  | {
      readonly status: 'approved';
      readonly category?: string;
      readonly spec: ChannelTemplateSpec;
    }
  | { readonly status: 'invalid'; readonly code: string }
  | { readonly status: 'unavailable'; readonly code: string };

/** Asks a connection's provider about a template: the Integration Engine's `checkTemplate`. */
export interface TemplateChecker {
  checkTemplate(
    connection: ChannelConnection,
    template: { readonly name: string; readonly language: string },
  ): Promise<TemplateCheck>;
}

/** A template message ready for an adapter: the provider's name, language and every value. */
export interface ResolvedTemplate {
  readonly name: string;
  readonly language: string;
  readonly header?:
    | { readonly type: 'text'; readonly values: readonly string[] }
    | { readonly type: 'media'; readonly media: OutboundMediaRef };
  readonly body: readonly string[];
  readonly buttons: readonly { readonly index: number; readonly text: string }[];
}

const refuse = (code: string): never => {
  throw new IntegrationError('invalid_outbound', code);
};

/**
 * A template's values checked against what its provider said it needs, exactly: an active
 * template, the same number of header and body values, a media header's own type, and one value
 * per dynamic URL button. Throws `invalid_outbound` with a stable code; nothing is sent.
 */
export function resolveTemplate(
  template: ChannelTemplate,
  values: TemplateValues,
): ResolvedTemplate {
  if (template.status !== 'active' || template.spec === undefined) {
    refuse('template_not_active');
  }
  const spec = template.spec as ChannelTemplateSpec;
  let header: ResolvedTemplate['header'];
  if (spec.header.format === 'none') {
    if (values.header !== undefined || values.headerMedia !== undefined) {
      refuse('template_header_mismatch');
    }
  } else if (spec.header.format === 'text') {
    if (values.headerMedia !== undefined) refuse('template_header_mismatch');
    const given = values.header ?? [];
    if (given.length < spec.header.parameters) refuse('template_parameter_missing');
    if (given.length > spec.header.parameters) refuse('template_parameter_extra');
    if (given.length > 0) header = { type: 'text', values: given };
  } else {
    if (values.header !== undefined) refuse('template_header_mismatch');
    if (values.headerMedia === undefined) refuse('template_parameter_missing');
    if (values.headerMedia?.type !== spec.header.format) refuse('template_header_mismatch');
    header = { type: 'media', media: values.headerMedia as OutboundMediaRef };
  }
  if (values.body.length < spec.bodyParameters) refuse('template_parameter_missing');
  if (values.body.length > spec.bodyParameters) refuse('template_parameter_extra');
  const buttons = values.buttons ?? [];
  const wanted = new Set(spec.urlButtons.map((b) => b.index));
  for (const b of buttons) if (!wanted.has(b.index)) refuse('template_parameter_extra');
  for (const index of wanted) {
    if (!buttons.some((b) => b.index === index)) refuse('template_parameter_missing');
  }
  return Object.freeze({
    name: template.name,
    language: template.language,
    ...(header === undefined ? {} : { header: Object.freeze(header) }),
    body: values.body,
    buttons: [...buttons].sort((a, b) => a.index - b.index),
  });
}

export interface ChannelTemplateService {
  list(tenant: TenantContext, connectionId: string): Promise<readonly ChannelTemplate[]>;
  get(tenant: TenantContext, connectionId: string, id: string): Promise<ChannelTemplate>;
  /**
   * Registers a template by its provider name and language, then checks it with the provider.
   * The same name and language on the same connection is the same template: checked again.
   */
  register(
    tenant: TenantContext,
    connectionId: string,
    input: { readonly name: unknown; readonly language: unknown },
  ): Promise<ChannelTemplate>;
  /** Asks the provider again (after it was approved, paused or edited there). */
  check(tenant: TenantContext, connectionId: string, id: string): Promise<ChannelTemplate>;
  disable(tenant: TenantContext, connectionId: string, id: string): Promise<ChannelTemplate>;
}

export interface ChannelTemplateServiceOptions {
  readonly repository: ChannelTemplateRepository;
  readonly connections: Pick<ChannelConnectionRepository, 'find'>;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** The Integration Engine. Unset: every check answers `provider_unavailable`. */
  readonly checker?: TemplateChecker;
  readonly now?: () => Date;
  readonly requestId?: string;
}

type TemplateAction =
  'channel.template_registered' | 'channel.template_checked' | 'channel.template_disabled';

export function templateEventOf(
  tenant: TenantContext,
  template: ChannelTemplate,
  action: TemplateAction,
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
      actor: actorOf(tenant as never),
      organizationId: template.organizationId,
      target: { type: 'channel_template', id: template.id },
      reference: `connection:${template.connectionId}`,
      reason: options.reason ?? template.status,
      message: { type: 'template', template: template.name, language: template.language },
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      source: 'api',
    },
    at,
  );
}

/**
 * Templates of one connection: read with `channel.read`, registered, checked and turned off with
 * `channel.update`, by a person acting directly (the same permissions as the connection itself).
 */
export function createChannelTemplateService(
  options: ChannelTemplateServiceOptions,
): ChannelTemplateService {
  const {
    repository,
    connections,
    organizations,
    authorization,
    checker,
    now = () => new Date(),
    requestId,
  } = options;

  async function organizationOf(
    tenant: TenantContext,
    permission: string,
    direct = true,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new IntegrationError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new IntegrationError('permission_denied');
    }
    if (direct && tenant.actor !== 'user') throw new IntegrationError('requires_user');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new IntegrationError('organization_inactive');
    }
    return organization.id;
  }

  async function connectionOf(
    organizationId: OrganizationId,
    id: string,
  ): Promise<ChannelConnection> {
    const connection = isConnectionId(id) ? await connections.find(organizationId, id) : undefined;
    if (connection === undefined || connection.organizationId !== organizationId) {
      throw new IntegrationError('connection_not_found');
    }
    return connection;
  }

  async function templateOf(
    organizationId: OrganizationId,
    connectionId: string,
    id: string,
  ): Promise<ChannelTemplate> {
    const template = isTemplateId(id) ? await repository.find(organizationId, id) : undefined;
    if (template === undefined || template.connectionId !== connectionId) {
      throw new IntegrationError('template_not_found');
    }
    return template;
  }

  async function askProvider(
    connection: ChannelConnection,
    template: ChannelTemplate,
  ): Promise<TemplateCheck> {
    if (connection.status === 'revoked') return { status: 'invalid', code: 'connection_revoked' };
    if (checker === undefined) return { status: 'unavailable', code: 'provider_unavailable' };
    try {
      return await checker.checkTemplate(connection, {
        name: template.name,
        language: template.language,
      });
    } catch {
      return { status: 'unavailable', code: 'provider_unavailable' };
    }
  }

  /** Stores what the provider said, audited in the same write. */
  async function recordCheck(
    tenant: TenantContext,
    template: ChannelTemplate,
    check: TemplateCheck,
  ): Promise<ChannelTemplate> {
    const userId = (tenant as { readonly userId: UserId }).userId;
    return repository.update(template.organizationId, template.id, (current) => {
      const at = now();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { statusReason: _r, category: _c, spec: _s, ...rest } = current;
      const next: ChannelTemplate =
        check.status === 'approved'
          ? Object.freeze({
              ...rest,
              status: 'active',
              ...(check.category === undefined ? {} : { category: check.category }),
              spec: check.spec,
              lastValidatedAt: at.toISOString() as IsoTimestamp,
              updatedAt: at.toISOString() as IsoTimestamp,
              updatedBy: userId,
              revision: current.revision + 1,
            })
          : current.status === 'active' && check.status === 'unavailable'
            ? // No answer: an active template stays as the provider last confirmed it.
              Object.freeze({
                ...current,
                updatedAt: at.toISOString() as IsoTimestamp,
                updatedBy: userId,
                revision: current.revision + 1,
              })
            : // Not confirmed: never sent until checked again.
              Object.freeze({
                ...rest,
                status: 'invalid',
                statusReason: check.code,
                updatedAt: at.toISOString() as IsoTimestamp,
                updatedBy: userId,
                revision: current.revision + 1,
              });
      return {
        template: next,
        events: [
          templateEventOf(tenant, next, 'channel.template_checked', at, {
            result: check.status === 'approved' ? 'success' : 'failure',
            reason: check.status === 'approved' ? 'active' : check.code,
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ],
      };
    });
  }

  return Object.freeze({
    async list(tenant, connectionId) {
      const organizationId = await organizationOf(tenant, 'channel.read', false);
      const connection = await connectionOf(organizationId, connectionId);
      return repository.list(organizationId, connection.id);
    },

    async get(tenant, connectionId, id) {
      const organizationId = await organizationOf(tenant, 'channel.read', false);
      await connectionOf(organizationId, connectionId);
      return templateOf(organizationId, connectionId, id);
    },

    async register(tenant, connectionId, input) {
      const organizationId = await organizationOf(tenant, 'channel.update');
      const connection = await connectionOf(organizationId, connectionId);
      if (connection.status === 'revoked') throw new IntegrationError('connection_revoked');
      if (typeof input.name !== 'string' || !TEMPLATE_NAME.test(input.name)) {
        throw new IntegrationError('invalid_template', 'name');
      }
      if (typeof input.language !== 'string' || !TEMPLATE_LANGUAGE.test(input.language)) {
        throw new IntegrationError('invalid_template', 'language');
      }
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const userId = (tenant as { readonly userId: UserId }).userId;
      const template: ChannelTemplate = Object.freeze({
        id: templateIdFor(organizationId, connection.id, input.name, input.language),
        organizationId,
        connectionId: connection.id,
        channel: connection.channel,
        name: input.name,
        language: input.language,
        status: 'pending',
        createdAt: iso,
        createdBy: userId,
        updatedAt: iso,
        updatedBy: userId,
        revision: 1,
      });
      await repository.create({
        template,
        events: [
          templateEventOf(tenant, template, 'channel.template_registered', at, {
            reason: 'pending',
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ],
      });
      const stored = await templateOf(organizationId, connection.id, template.id);
      return recordCheck(tenant, stored, await askProvider(connection, stored));
    },

    async check(tenant, connectionId, id) {
      const organizationId = await organizationOf(tenant, 'channel.update');
      const connection = await connectionOf(organizationId, connectionId);
      const template = await templateOf(organizationId, connection.id, id);
      return recordCheck(tenant, template, await askProvider(connection, template));
    },

    async disable(tenant, connectionId, id) {
      const organizationId = await organizationOf(tenant, 'channel.update');
      await connectionOf(organizationId, connectionId);
      const template = await templateOf(organizationId, connectionId, id);
      if (template.status === 'disabled')
        throw new IntegrationError('invalid_transition', 'disabled');
      const userId = (tenant as { readonly userId: UserId }).userId;
      return repository.update(organizationId, template.id, (current) => {
        const at = now();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { statusReason: _r, ...rest } = current;
        const next: ChannelTemplate = Object.freeze({
          ...rest,
          status: 'disabled',
          updatedAt: at.toISOString() as IsoTimestamp,
          updatedBy: userId,
          revision: current.revision + 1,
        });
        return {
          template: next,
          events: [
            templateEventOf(tenant, next, 'channel.template_disabled', at, {
              ...(requestId === undefined ? {} : { requestId }),
            }),
          ],
        };
      });
    },
  } satisfies ChannelTemplateService);
}
