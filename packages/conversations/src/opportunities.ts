import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditTransition,
} from '@melonoffice/audit';
import type {
  Contact,
  ContactCommercial,
  ContactId,
  ContactStage,
  IsoTimestamp,
  LostReason,
  Money,
  Opportunity,
  OpportunityId,
  OpportunityStatus,
  OrganizationId,
  Pipeline,
  PipelineStage,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { ConversationError } from './errors.js';
import { isContactId, isUuid } from './model.js';
import {
  checkStages,
  isStageId,
  newStageId as randomStageId,
  proposedPipeline,
  stageOf,
} from './pipeline.js';
import type { ConversationRepository, OpportunityRead, OpportunityWrite } from './repository.js';

/**
 * Opportunities (C2, ADR-0054): possible sales to the C1 contacts, moving through the
 * organization's own pipeline to won or lost. A new opportunity makes its contact a lead; a won
 * one makes it a customer, in the same write; a lost one leaves the contact as it was. GIA may
 * read them (to answer and, in a later phase, suggest); every change is a person's, audited
 * without titles, amounts or personal data.
 */

export const LOST_REASONS: readonly LostReason[] = [
  'price',
  'timing',
  'competitor',
  'no_response',
  'not_a_fit',
  'other',
];

export const OPPORTUNITY_LIMITS = Object.freeze({
  /** Opportunities one list returns. */
  list: 500,
  titleLength: 120,
  nextActionLength: 200,
  /** The largest amount, in minor units (a trillion céntimos). */
  amountMinor: 1_000_000_000_000,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isOpportunityId = (value: unknown): value is OpportunityId => isUuid(value);

/** Where the pipeline stands, per stage and in total, in the business's currency. */
export interface PipelineSummary {
  readonly currency: string | null;
  readonly stages: Readonly<
    Record<string, { readonly count: number; readonly valueMinor: number }>
  >;
  readonly open: { readonly count: number; readonly valueMinor: number };
  readonly won: number;
  readonly lost: number;
}

/**
 * Totals of the opportunities. Amounts are added only in the business's currency; an amount in
 * another currency is counted but not added (no exchange rates are invented).
 */
export function pipelineSummary(
  opportunities: readonly Opportunity[],
  currency: string | undefined,
): PipelineSummary {
  const stages: Record<string, { count: number; valueMinor: number }> = {};
  const open = { count: 0, valueMinor: 0 };
  let won = 0;
  let lost = 0;
  for (const o of opportunities) {
    const amount = o.value !== undefined && o.value.currency === currency ? o.value.amountMinor : 0;
    const stage = (stages[o.stageId] ??= { count: 0, valueMinor: 0 });
    stage.count += 1;
    stage.valueMinor += amount;
    if (o.status === 'open') {
      open.count += 1;
      open.valueMinor += amount;
    } else if (o.status === 'won') won += 1;
    else lost += 1;
  }
  return { currency: currency ?? null, stages, open, won, lost };
}

export interface OpportunityList {
  readonly items: readonly Opportunity[];
  readonly summary: PipelineSummary;
  readonly hasMore: boolean;
}

export interface PipelineView {
  readonly pipeline: Pipeline;
  /** False while it is only the proposal for the business's kind. */
  readonly stored: boolean;
}

export interface OpportunityService {
  /** `opportunity.read`: the stored pipeline, or the one proposed for the kind of business. */
  pipeline(tenant: TenantContext): Promise<PipelineView>;
  /** `pipeline.manage`, a person directly: stores the stages, against the current revision. */
  savePipeline(tenant: TenantContext, input: Record<string, unknown>): Promise<Pipeline>;
  /** `opportunity.read`: the organization's opportunities, newest change first, with totals. */
  list(
    tenant: TenantContext,
    filter?: {
      readonly status?: unknown;
      readonly stageId?: unknown;
      readonly ownerId?: unknown;
      readonly contactId?: unknown;
    },
  ): Promise<OpportunityList>;
  /** `opportunity.read`: one opportunity with its contact and pipeline. */
  get(
    tenant: TenantContext,
    id: string,
  ): Promise<{
    readonly opportunity: Opportunity;
    readonly contact: Contact;
    readonly pipeline: Pipeline;
  }>;
  /** `opportunity.manage`, a person directly: a new open opportunity for a contact. */
  create(tenant: TenantContext, input: Record<string, unknown>): Promise<Opportunity>;
  /**
   * `opportunity.manage`, a person directly: changes an opportunity against its `revision`:
   * details, stage (won needs nothing more; lost needs a `lostReason`), responsible member.
   */
  update(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<Opportunity>;
  /** `opportunity.read`: the totals (for Company Brain). */
  summary(tenant: TenantContext): Promise<PipelineSummary>;
}

export interface OpportunityServiceOptions {
  readonly repository: Pick<
    ConversationRepository,
    | 'findPipeline'
    | 'savePipeline'
    | 'findOpportunity'
    | 'listOpportunities'
    | 'writeOpportunity'
    | 'findContact'
  >;
  readonly organizations: Pick<TenancyStore, 'findOrganization' | 'findMembership'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** The organization's kind of business, from Company Brain: it picks the proposed stages. */
  readonly businessType: (organizationId: OrganizationId) => Promise<string | undefined>;
  /** The organization's currency, from Company Brain: the default of a value, and the totals'. */
  readonly currency: (organizationId: OrganizationId) => Promise<string | undefined>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly newStageId?: () => string;
  readonly requestId?: string;
}

const CREATE_KEYS = new Set([
  'contactId',
  'title',
  'stageId',
  'value',
  'probability',
  'ownerId',
  'expectedCloseOn',
  'nextAction',
]);
const UPDATE_KEYS = new Set([
  'revision',
  'title',
  'stageId',
  'value',
  'probability',
  'ownerId',
  'expectedCloseOn',
  'nextAction',
  'lostReason',
]);

type EventAction = Extract<
  AuditAction,
  `opportunity.${string}` | `pipeline.${string}` | 'contact.stage_changed'
>;

const bad = (field: string): never => {
  throw new ConversationError('invalid_request', field);
};

const statusOf = (stage: PipelineStage): OpportunityStatus =>
  stage.kind === 'open' ? 'open' : stage.kind;

export function createOpportunityService(options: OpportunityServiceOptions): OpportunityService {
  const {
    repository,
    organizations,
    authorization,
    businessType,
    currency,
    now = () => new Date(),
    newId = randomUUID,
    newStageId = () => randomStageId(),
    requestId,
  } = options;

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

  /** Every change is a person's, directly: GIA and the runtime only read. */
  async function managerOf(tenant: TenantContext, permission: string): Promise<OrganizationId> {
    const organizationId = await organizationOf(tenant, permission);
    if (tenant.actor !== 'user') throw new ConversationError('requires_user');
    return organizationId;
  }

  const event = (
    tenant: TenantContext,
    organizationId: OrganizationId,
    target: { readonly type: 'opportunity' | 'pipeline' | 'contact'; readonly id: string },
    action: EventAction,
    at: Date,
    fields: { readonly transition?: AuditTransition; readonly reason?: string } = {},
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId,
        target,
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  async function ownerOf(organizationId: OrganizationId, value: unknown): Promise<UserId> {
    if (!isUuid(value)) bad('ownerId');
    const membership = await organizations.findMembership(organizationId, value as UserId);
    if (membership?.status !== 'active') throw new ConversationError('owner_not_member');
    return value as UserId;
  }

  function titleOf(value: unknown): string {
    if (typeof value !== 'string') return bad('title');
    const title = value.normalize('NFC').trim();
    if (title === '' || [...title].length > OPPORTUNITY_LIMITS.titleLength || CONTROL.test(title)) {
      bad('title');
    }
    return title;
  }

  function valueOf(value: unknown, fallbackCurrency: string | undefined): Money {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad('value');
    const { amountMinor, currency: code, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length > 0) bad('value');
    if (
      typeof amountMinor !== 'number' ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 0 ||
      amountMinor > OPPORTUNITY_LIMITS.amountMinor
    ) {
      bad('value.amountMinor');
    }
    const iso = code ?? fallbackCurrency;
    if (typeof iso !== 'string' || !CURRENCY.test(iso)) return bad('value.currency');
    return Object.freeze({ amountMinor: amountMinor as number, currency: iso });
  }

  const probabilityOf = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
      ? value
      : bad('probability');

  const dateOf = (value: unknown, field: string): string =>
    typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
      ? value
      : bad(field);

  function nextActionOf(value: unknown): NonNullable<Opportunity['nextAction']> {
    if (typeof value !== 'object' || value === null) return bad('nextAction');
    const { text, dueOn } = value as Record<string, unknown>;
    if (
      typeof text !== 'string' ||
      text.trim() === '' ||
      text.length > OPPORTUNITY_LIMITS.nextActionLength
    ) {
      bad('nextAction.text');
    }
    return Object.freeze({
      text: (text as string).trim(),
      dueOn: dateOf(dueOn, 'nextAction.dueOn'),
    });
  }

  const lostReasonOf = (value: unknown): LostReason =>
    (LOST_REASONS as readonly unknown[]).includes(value)
      ? (value as LostReason)
      : bad('lostReason');

  function checkKeys(input: Record<string, unknown>, keys: ReadonlySet<string>): void {
    for (const k of Object.keys(input)) if (!keys.has(k)) bad(k);
  }

  async function currentPipeline(organizationId: OrganizationId): Promise<PipelineView> {
    const stored = await repository.findPipeline(organizationId);
    if (stored !== undefined) return { pipeline: stored, stored: true };
    const at = now().toISOString() as IsoTimestamp;
    return {
      pipeline: proposedPipeline(organizationId, await businessType(organizationId), at),
      stored: false,
    };
  }

  /** The contact at a new commercial stage, one revision ahead (a lead, or a customer). */
  function contactAt(
    tenant: TenantContext,
    contact: Contact,
    stage: ContactStage,
    at: Date,
  ): { contact: Contact; event: AuditEvent } | undefined {
    const before = contact.commercial;
    if (before?.stage === stage) return undefined;
    const iso = at.toISOString() as IsoTimestamp;
    const commercial: ContactCommercial = Object.freeze({
      ...(before ?? {
        source: Object.freeze({ kind: contact.origin.kind === 'channel' ? 'channel' : 'manual' }),
        consent: Object.freeze({ messaging: 'unknown' }),
      }),
      stage,
      stageChangedAt: iso,
    }) as ContactCommercial;
    return {
      contact: Object.freeze({
        ...contact,
        commercial,
        revision: (contact.revision ?? 0) + 1,
        updatedAt: iso,
      }),
      event: event(
        tenant,
        contact.organizationId,
        { type: 'contact', id: contact.id },
        'contact.stage_changed',
        at,
        { transition: { from: before?.stage ?? 'none', to: stage } },
      ),
    };
  }

  const target = (o: Pick<Opportunity, 'id'>) => ({ type: 'opportunity' as const, id: o.id });

  return Object.freeze({
    async pipeline(tenant: TenantContext) {
      return currentPipeline(await organizationOf(tenant, 'opportunity.read'));
    },

    async savePipeline(tenant: TenantContext, input: Record<string, unknown>) {
      const organizationId = await managerOf(tenant, 'pipeline.manage');
      checkKeys(input, new Set(['revision', 'stages']));
      const { revision } = input;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        bad('revision');
      }
      const proposal = (await currentPipeline(organizationId)).pipeline;
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      return repository.savePipeline(organizationId, (current) => {
        if ((current?.revision ?? 0) !== revision) {
          throw new ConversationError('pipeline_concurrency_conflict');
        }
        const base = current ?? proposal;
        const stages = checkStages(base.stages, input.stages, newStageId);
        if (current !== undefined && JSON.stringify(stages) === JSON.stringify(current.stages)) {
          return { pipeline: current, events: [] };
        }
        const pipeline: Pipeline = Object.freeze({
          ...base,
          stages,
          revision: (current?.revision ?? 0) + 1,
          createdAt: current?.createdAt ?? iso,
          updatedAt: iso,
        });
        const t = { type: 'pipeline' as const, id: pipeline.id };
        return {
          pipeline,
          events:
            current === undefined
              ? [
                  event(tenant, organizationId, t, 'pipeline.created', at, {
                    reason: base.template,
                  }),
                ]
              : [event(tenant, organizationId, t, 'pipeline.updated', at)],
        };
      });
    },

    async list(tenant, filter = {}) {
      const organizationId = await organizationOf(tenant, 'opportunity.read');
      const { status, stageId, ownerId, contactId } = filter;
      if (status !== undefined && !['open', 'won', 'lost'].includes(status as string))
        bad('status');
      if (stageId !== undefined && !isStageId(stageId)) bad('stageId');
      if (ownerId !== undefined && !isUuid(ownerId)) bad('ownerId');
      if (contactId !== undefined && !isContactId(contactId)) bad('contactId');
      const all = (await repository.listOpportunities(organizationId)).filter(
        (o) => o.organizationId === organizationId,
      );
      const matching = all.filter(
        (o) =>
          (status === undefined || o.status === status) &&
          (stageId === undefined || o.stageId === stageId) &&
          (ownerId === undefined || o.ownerId === ownerId) &&
          (contactId === undefined || o.contactId === contactId),
      );
      return Object.freeze({
        items: Object.freeze(matching.slice(0, OPPORTUNITY_LIMITS.list)),
        summary: pipelineSummary(all, await currency(organizationId)),
        hasMore: matching.length > OPPORTUNITY_LIMITS.list,
      });
    },

    async get(tenant, id) {
      const organizationId = await organizationOf(tenant, 'opportunity.read');
      if (!isOpportunityId(id)) throw new ConversationError('opportunity_not_found');
      const opportunity = await repository.findOpportunity(organizationId, id);
      if (opportunity === undefined) throw new ConversationError('opportunity_not_found');
      const contact = await repository.findContact(organizationId, opportunity.contactId);
      if (contact === undefined) throw new ConversationError('contact_not_found');
      const { pipeline } = await currentPipeline(organizationId);
      return Object.freeze({ opportunity, contact, pipeline });
    },

    async create(tenant, input) {
      const organizationId = await managerOf(tenant, 'opportunity.manage');
      checkKeys(input, CREATE_KEYS);
      if (!isContactId(input.contactId)) bad('contactId');
      const title = titleOf(input.title);
      const money =
        input.value === undefined || input.value === null
          ? undefined
          : valueOf(input.value, await currency(organizationId));
      const ownerId =
        input.ownerId === undefined || input.ownerId === null
          ? undefined
          : await ownerOf(organizationId, input.ownerId);
      const expectedCloseOn =
        input.expectedCloseOn === undefined || input.expectedCloseOn === null
          ? undefined
          : dateOf(input.expectedCloseOn, 'expectedCloseOn');
      const nextAction =
        input.nextAction === undefined || input.nextAction === null
          ? undefined
          : nextActionOf(input.nextAction);
      const probability =
        input.probability === undefined ? undefined : probabilityOf(input.probability);
      if (input.stageId !== undefined && !isStageId(input.stageId)) bad('stageId');
      const proposal = (await currentPipeline(organizationId)).pipeline;
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const id = newId() as OpportunityId;

      return repository.writeOpportunity(
        organizationId,
        { contactId: input.contactId as ContactId },
        ({ contact, pipeline: stored }): OpportunityWrite => {
          const pipeline = stored ?? { ...proposal, revision: 1, createdAt: iso, updatedAt: iso };
          const stage =
            input.stageId === undefined
              ? pipeline.stages.find((s) => s.kind === 'open')
              : stageOf(pipeline, input.stageId as string);
          if (stage === undefined) throw new ConversationError('stage_not_found');
          if (stage.kind !== 'open') bad('stageId');
          const opportunity: Opportunity = Object.freeze({
            id,
            organizationId,
            contactId: contact.id,
            pipelineId: pipeline.id,
            stageId: stage.id,
            status: 'open',
            title,
            ...(money === undefined ? {} : { value: money }),
            probability: probability ?? stage.probability,
            ...(ownerId === undefined ? {} : { ownerId }),
            ...(expectedCloseOn === undefined ? {} : { expectedCloseOn }),
            ...(nextAction === undefined ? {} : { nextAction }),
            stageChangedAt: iso,
            revision: 1,
            createdBy: tenant.userId,
            createdAt: iso,
            updatedAt: iso,
          });
          const events: AuditEvent[] = [];
          if (stored === undefined) {
            events.push(
              event(
                tenant,
                organizationId,
                { type: 'pipeline', id: pipeline.id },
                'pipeline.created',
                at,
                {
                  reason: pipeline.template,
                },
              ),
            );
          }
          // An opportunity for a contact nobody marked makes it a lead (Lead → Opportunity).
          const lead =
            contact.commercial === undefined ? contactAt(tenant, contact, 'lead', at) : undefined;
          if (lead !== undefined) events.push(lead.event);
          events.push(
            event(tenant, organizationId, target(opportunity), 'opportunity.created', at, {
              transition: { from: 'none', to: stage.id },
            }),
          );
          return {
            opportunity,
            ...(lead === undefined ? {} : { contact: lead.contact }),
            ...(stored === undefined ? { pipeline } : {}),
            events,
          };
        },
      );
    },

    async update(tenant, id, input) {
      const organizationId = await managerOf(tenant, 'opportunity.manage');
      if (!isOpportunityId(id)) throw new ConversationError('opportunity_not_found');
      checkKeys(input, UPDATE_KEYS);
      const { revision } = input;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
        bad('revision');
      }
      const title = input.title === undefined ? undefined : titleOf(input.title);
      const money =
        input.value === undefined
          ? undefined
          : input.value === null
            ? null
            : valueOf(input.value, await currency(organizationId));
      const ownerId =
        input.ownerId === undefined
          ? undefined
          : input.ownerId === null
            ? null
            : await ownerOf(organizationId, input.ownerId);
      const expectedCloseOn =
        input.expectedCloseOn === undefined
          ? undefined
          : input.expectedCloseOn === null
            ? null
            : dateOf(input.expectedCloseOn, 'expectedCloseOn');
      const nextAction =
        input.nextAction === undefined
          ? undefined
          : input.nextAction === null
            ? null
            : nextActionOf(input.nextAction);
      const probability =
        input.probability === undefined ? undefined : probabilityOf(input.probability);
      if (input.stageId !== undefined && !isStageId(input.stageId)) bad('stageId');
      const lostReason =
        input.lostReason === undefined ? undefined : lostReasonOf(input.lostReason);
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;

      return repository.writeOpportunity(
        organizationId,
        { opportunityId: id },
        ({ current, contact, pipeline }: OpportunityRead): OpportunityWrite => {
          const before = current as Opportunity;
          if (before.revision !== revision) {
            throw new ConversationError('opportunity_concurrency_conflict');
          }
          if (pipeline === undefined) throw new ConversationError('stage_not_found');
          const stage =
            input.stageId === undefined
              ? stageOf(pipeline, before.stageId)
              : stageOf(pipeline, input.stageId as string);
          if (stage === undefined) throw new ConversationError('stage_not_found');
          const status = statusOf(stage);
          const moving = stage.id !== before.stageId;
          // A won or lost opportunity changes only by being reopened to an open stage.
          if (before.status !== 'open' && (status !== 'open' || !moving)) {
            throw new ConversationError('opportunity_closed');
          }
          if (lostReason !== undefined && status !== 'lost') bad('lostReason');
          if (status === 'lost' && moving && lostReason === undefined) bad('lostReason');
          if (status !== 'open' && probability !== undefined) bad('probability');

          const events: AuditEvent[] = [];
          const t = target(before);
          const record: Record<string, unknown> = { ...before };
          const reasons: string[] = [];
          const set = (key: string, value: unknown, reason: string) => {
            if (value === undefined) return;
            const old = JSON.stringify(record[key]);
            if (value === null) Reflect.deleteProperty(record, key);
            else record[key] = value;
            if (JSON.stringify(record[key]) !== old) reasons.push(reason);
          };
          set('title', title, 'details');
          set('value', money, 'value');
          set('expectedCloseOn', expectedCloseOn, 'expected_close');
          set(
            'nextAction',
            nextAction,
            nextAction === null ? 'next_action_cleared' : 'next_action',
          );

          let contactWrite: Contact | undefined;
          if (moving) {
            record.stageId = stage.id;
            record.status = status;
            record.stageChangedAt = iso;
            if (status === 'open') {
              record.probability = probability ?? stage.probability;
              delete record.closedAt;
              delete record.lostReason;
            } else {
              record.probability = stage.probability;
              record.closedAt = iso;
              if (status === 'lost') record.lostReason = lostReason;
            }
            const transition = { from: before.stageId, to: stage.id };
            if (status === 'won') {
              events.push(event(tenant, organizationId, t, 'opportunity.won', at, { transition }));
              // A won opportunity makes its contact a customer (C1's stage), in the same write.
              const customer = contactAt(tenant, contact, 'customer', at);
              if (customer !== undefined) {
                contactWrite = customer.contact;
                events.push(customer.event);
              }
            } else if (status === 'lost') {
              events.push(
                event(tenant, organizationId, t, 'opportunity.lost', at, {
                  transition,
                  reason: lostReason as string,
                }),
              );
            } else if (before.status !== 'open') {
              events.push(
                event(tenant, organizationId, t, 'opportunity.reopened', at, { transition }),
              );
            } else {
              events.push(
                event(tenant, organizationId, t, 'opportunity.stage_changed', at, { transition }),
              );
            }
          } else if (probability !== undefined && probability !== before.probability) {
            record.probability = probability;
            reasons.push('probability');
          }
          if (ownerId !== undefined && (ownerId ?? undefined) !== before.ownerId) {
            if (ownerId === null) delete record.ownerId;
            else record.ownerId = ownerId;
            events.push(
              event(tenant, organizationId, t, 'opportunity.owner_changed', at, {
                reason: ownerId === null ? 'cleared' : 'assigned',
              }),
            );
          }
          for (const reason of reasons) {
            events.push(event(tenant, organizationId, t, 'opportunity.updated', at, { reason }));
          }
          if (events.length === 0) return { opportunity: before, events };
          const opportunity = Object.freeze({
            ...record,
            revision: before.revision + 1,
            updatedAt: iso,
          }) as unknown as Opportunity;
          return {
            opportunity,
            ...(contactWrite === undefined ? {} : { contact: contactWrite }),
            events,
          };
        },
      );
    },

    async summary(tenant) {
      const organizationId = await organizationOf(tenant, 'opportunity.read');
      return pipelineSummary(
        await repository.listOpportunities(organizationId),
        await currency(organizationId),
      );
    },
  } satisfies OpportunityService);
}
