import {
  actorOf,
  buildAuditEvent,
  type AuditEvent,
  type AuditEventInput,
} from '@melonoffice/audit';
import type {
  IsoTimestamp,
  KnowledgeConflict,
  KnowledgeDocument,
  KnowledgeDomain,
  KnowledgeItem,
  KnowledgeRecorder,
  KnowledgeSensitivity,
  KnowledgeSourceType,
  KnowledgeSubject,
  KnowledgeVersion,
  OrganizationId,
} from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEPARTMENT_ACCESS,
  DOMAIN_IDS,
  isKnowledgeDomain,
  LIMITS,
  ONBOARDING_QUESTIONS,
  sensitivityAllows,
  type ContextPurpose,
} from './catalogue.js';
import { BrainError } from './errors.js';
import {
  checkKnowledgeInput,
  knowledgeItemId,
  omit,
  valueText,
  type KnowledgeInput,
} from './knowledge.js';
import {
  merge,
  updateOpenConflict,
  verificationFor,
  versionOf,
  type MergeOutcome,
} from './merge.js';
import type { KnowledgeRepository, KnowledgeWrite } from './repository.js';

/**
 * Company Brain (ADR-0051): the organization's knowledge of itself, as one service every caller
 * uses (the API, GIA, the runtime's agents and the server's own sources). Every call names a
 * resolved tenant, is checked by RBAC, and reads and writes that organization only.
 */

/** A source the server vouches for (a document, an integration, the profile…). Never client input. */
export interface TrustedSource {
  readonly type: KnowledgeSourceType;
  readonly id?: string;
  readonly reference?: string;
}

export interface KnowledgeOutcome {
  readonly outcome: MergeOutcome;
  readonly itemId: string;
  readonly revision?: number;
  readonly conflictId?: string;
}

/** An item as a reader sees it: restricted values are withheld from who may not read them. */
export type KnowledgeView = KnowledgeItem & { readonly needsConfirmation: boolean };

export interface ContextRequest {
  readonly purpose: ContextPurpose;
  readonly domains?: readonly KnowledgeDomain[];
  readonly keys?: readonly string[];
  readonly subjects?: readonly KnowledgeSubject[];
  /** Words to look for in keys, names and values. No model is used. */
  readonly query?: string;
  readonly limit?: number;
}

/** One fact handed to GIA or an agent: small, with its origin and trust. */
export interface ContextFact {
  readonly id: string;
  readonly domain: KnowledgeDomain;
  readonly key: string;
  readonly subject?: KnowledgeSubject;
  readonly label?: string;
  readonly value: string;
  readonly verification: KnowledgeItem['verification'];
  readonly needsConfirmation: boolean;
  readonly source: KnowledgeSourceType;
  readonly updatedAt: IsoTimestamp;
}

export interface CompanyContext {
  /** Which knowledge it was built from: the latest change among the facts given. */
  readonly ref: { readonly kind: 'company_context'; readonly id: string; readonly version: string };
  readonly purpose: ContextPurpose;
  readonly facts: readonly ContextFact[];
  /** Domains asked for that this purpose or person may not read. */
  readonly withheld: readonly KnowledgeDomain[];
  /** More facts matched than were given. */
  readonly truncated: boolean;
}

export interface KnowledgeGaps {
  /** What GIA should still ask, in order; already-known facts are not asked again. */
  readonly questions: readonly {
    readonly id: string;
    readonly domain: KnowledgeDomain;
    readonly key: string;
  }[];
  /** Facts a person should confirm: proposals, unverified or critical ones. */
  readonly toConfirm: readonly KnowledgeView[];
  readonly openConflicts: number;
}

export interface BrainSummary {
  readonly initialized: boolean;
  readonly items: number;
  readonly byDomain: Readonly<Partial<Record<KnowledgeDomain, number>>>;
  readonly gaps: KnowledgeGaps;
}

/** What turns text into candidate facts (ADR-0051): the AI Gateway in production. */
export interface KnowledgeExtractor {
  extract(
    tenant: TenantContext,
    request: {
      readonly subjectId: string;
      readonly kind: 'document' | 'statement';
      readonly text: string;
    },
  ): Promise<
    | { readonly status: 'extracted'; readonly facts: readonly unknown[] }
    | { readonly status: 'unavailable' | 'failed'; readonly code: string }
  >;
}

export interface IngestResult {
  readonly outcomes: readonly KnowledgeOutcome[];
  /** Candidate facts refused by the checks (never stored). */
  readonly rejected: number;
}

export interface DocumentResult extends IngestResult {
  readonly document: Omit<KnowledgeDocument, 'text'>;
  readonly extraction: 'extracted' | 'unavailable' | 'failed' | 'duplicate';
}

export interface CompanyBrainService {
  summary(tenant: TenantContext): Promise<BrainSummary>;
  list(
    tenant: TenantContext,
    filter?: { readonly domain?: KnowledgeDomain; readonly includeInactive?: boolean },
  ): Promise<readonly KnowledgeView[]>;
  get(
    tenant: TenantContext,
    itemId: string,
  ): Promise<{ readonly item: KnowledgeView; readonly versions: readonly KnowledgeVersion[] }>;
  /** A fact from whoever calls: a person (confirmed if they manage knowledge), GIA or an agent. */
  propose(tenant: TenantContext, input: unknown): Promise<KnowledgeOutcome>;
  /** Facts from a source the server vouches for. Server-side only; there is no route to it. */
  ingest(
    tenant: TenantContext,
    source: TrustedSource,
    inputs: readonly unknown[],
    confidenceFloor?: number,
  ): Promise<IngestResult>;
  confirm(tenant: TenantContext, itemId: string, revision: number): Promise<KnowledgeOutcome>;
  invalidate(
    tenant: TenantContext,
    itemId: string,
    revision: number,
    reason?: string,
  ): Promise<KnowledgeOutcome>;
  archive(tenant: TenantContext, itemId: string, revision: number): Promise<KnowledgeOutcome>;
  conflicts(tenant: TenantContext): Promise<readonly KnowledgeConflict[]>;
  resolveConflict(
    tenant: TenantContext,
    conflictId: string,
    choice: 'kept_current' | 'took_candidate',
  ): Promise<KnowledgeOutcome>;
  context(tenant: TenantContext, request: ContextRequest): Promise<CompanyContext>;
  gaps(tenant: TenantContext): Promise<KnowledgeGaps>;
  /** GIA captures what a person told her: extracted facts become proposals, never confirmed. */
  capture(
    tenant: TenantContext,
    text: string,
  ): Promise<IngestResult & { readonly extraction: string }>;
  ingestDocument(
    tenant: TenantContext,
    document: { readonly name: unknown; readonly text: unknown },
  ): Promise<DocumentResult>;
}

export interface CompanyBrainOptions {
  readonly repository: KnowledgeRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly extractor?: KnowledgeExtractor;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly requestId?: string;
}

const REASON = /^[a-z][a-z_]{0,63}$/;
const ITEM_ID = /^[\w-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function recorderOf(tenant: TenantContext): KnowledgeRecorder {
  if (tenant.actor === 'runtime')
    return Object.freeze({ type: 'runtime', initiatedBy: tenant.userId });
  return Object.freeze({
    type: 'user',
    userId: tenant.userId,
    via: tenant.actor === 'gia' ? 'gia' : 'direct',
  });
}

/** Who states a fact when no source vouches for it: the person, GIA, or an agent. */
const sourceTypeOf = (tenant: TenantContext): KnowledgeSourceType =>
  tenant.actor === 'user' ? 'user' : tenant.actor === 'gia' ? 'gia' : 'agent';

/** Plain words for matching: lower case, without accents. */
const words = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

const noop: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noop,
};

export function createCompanyBrain(options: CompanyBrainOptions): CompanyBrainService {
  const { repository, organizations, authorization, extractor, requestId } = options;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? noop;

  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;

  async function organizationOf(
    tenant: TenantContext,
    permission: string,
    direct = false,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new BrainError('unresolved_tenant');
    if (!can(tenant, permission)) {
      logger.warn('brain.authorization_denied', { permission, actor: tenant.actor });
      throw new BrainError('permission_denied');
    }
    if (direct && tenant.actor !== 'user') throw new BrainError('requires_user');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new BrainError('organization_inactive');
    }
    return organization.id;
  }

  /** The most sensitive knowledge this person (and so GIA or an agent for them) may read. */
  const ceilingOf = (tenant: TenantContext): KnowledgeSensitivity =>
    can(tenant, 'knowledge.read_restricted') ? 'restricted' : 'confidential';

  const viewOf = (item: KnowledgeItem): KnowledgeView =>
    Object.freeze({
      ...item,
      needsConfirmation:
        item.status === 'active' &&
        item.verification !== 'confirmed' &&
        (item.critical || item.verification === 'proposed' || item.verification === 'unverified'),
    });

  const audit = (
    tenant: TenantContext,
    organizationId: OrganizationId,
    input: Omit<AuditEventInput, 'actor' | 'organizationId' | 'source' | 'result'>,
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        ...input,
        result: 'success',
        actor: actorOf(tenant),
        organizationId,
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  const itemEvent = (
    tenant: TenantContext,
    item: KnowledgeItem,
    action: AuditEventInput['action'],
    at: Date,
    reason?: string,
  ) =>
    audit(
      tenant,
      item.organizationId,
      {
        action,
        target: { type: 'knowledge_item', id: item.id },
        targetVersion: item.revision,
        // Which area and which source, never the value: old and new values are its versions.
        reference: `${item.domain}:${item.provenance.sourceType}`,
        ...(reason === undefined ? {} : { reason }),
      },
      at,
    );

  const conflictEvent = (
    tenant: TenantContext,
    conflict: KnowledgeConflict,
    action: 'knowledge.conflict_detected' | 'knowledge.conflict_resolved',
    at: Date,
  ) =>
    audit(
      tenant,
      conflict.organizationId,
      {
        action,
        target: { type: 'knowledge_conflict', id: conflict.id },
        reference: `${conflict.domain}:${conflict.candidate.provenance.sourceType}`,
        ...(conflict.resolution === undefined ? {} : { reason: conflict.resolution }),
      },
      at,
    );

  /** Stores facts, one transaction each, merging them with what is there. */
  async function store(
    tenant: TenantContext,
    organizationId: OrganizationId,
    inputs: readonly KnowledgeInput[],
    source: TrustedSource,
    extraDocuments?: readonly KnowledgeDocument[],
  ): Promise<KnowledgeOutcome[]> {
    const byPerson =
      source.type === 'user' && tenant.actor === 'user' && can(tenant, 'knowledge.manage');
    const outcomes: KnowledgeOutcome[] = [];
    let documents = extraDocuments;
    for (const input of inputs) {
      const started = Date.now();
      const itemId = knowledgeItemId(organizationId, input.domain, input.key, input.subject);
      const existing = await repository.findItem(organizationId, itemId);
      const openId = existing?.openConflictId;
      const outcome = await repository.write<KnowledgeOutcome>(
        organizationId,
        { itemIds: [itemId], ...(openId === undefined ? {} : { conflictIds: [openId] }) },
        ({ items, conflicts }) => {
          const current = items.get(itemId);
          const open =
            current?.openConflictId === undefined
              ? undefined
              : conflicts.get(current.openConflictId);
          const at = now();
          const iso = at.toISOString() as IsoTimestamp;
          const provenance = Object.freeze({
            sourceType: source.type,
            ...(source.id === undefined ? {} : { sourceId: source.id }),
            ...(source.reference === undefined ? {} : { sourceReference: source.reference }),
            recordedBy: recorderOf(tenant),
            ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
          });
          const incoming = {
            organizationId,
            input,
            provenance,
            verification: verificationFor(source.type, byPerson),
            byPerson,
            at: iso,
          };
          const result = merge(current, incoming);
          const docs = documents ?? [];
          documents = undefined;
          if (result.outcome === 'unchanged') {
            if (docs.length === 0) return { result: { outcome: 'unchanged', itemId } };
            return {
              write: { items: [], versions: [], conflicts: [], events: [], documents: docs },
              result: { outcome: 'unchanged', itemId },
            };
          }
          if (result.outcome === 'conflict' && current !== undefined) {
            if (open?.status === 'open') {
              const updated = updateOpenConflict(open, current, incoming);
              return {
                write: {
                  items: [],
                  versions: [],
                  conflicts: [updated],
                  events: [conflictEvent(tenant, updated, 'knowledge.conflict_detected', at)],
                  documents: docs,
                },
                result: { outcome: 'conflict_updated', itemId, conflictId: updated.id },
              };
            }
            const conflict = result.conflicts[0] as KnowledgeConflict;
            // The item only gains a pointer to its open conflict; it stays as it was.
            const marked: KnowledgeItem = Object.freeze({
              ...current,
              openConflictId: conflict.id,
              revision: current.revision + 1,
              updatedAt: iso,
            });
            return {
              write: {
                items: [marked],
                versions: [versionOf(marked, 'conflict_detected', recorderOf(tenant))],
                conflicts: [conflict],
                events: [conflictEvent(tenant, conflict, 'knowledge.conflict_detected', at)],
                documents: docs,
              },
              result: {
                outcome: 'conflict',
                itemId,
                revision: marked.revision,
                conflictId: conflict.id,
              },
            };
          }
          let item = result.item as KnowledgeItem;
          const conflictsWrite: KnowledgeConflict[] = [];
          const events: AuditEvent[] = [];
          if (open?.status === 'open') {
            if (byPerson) {
              // A person decided by stating the value: the disagreement is settled.
              const settled: KnowledgeConflict = Object.freeze({
                ...open,
                status: 'resolved',
                resolution: sameCandidate(open, item) ? 'took_candidate' : 'replaced',
                resolvedBy: tenant.userId,
                resolvedAt: iso,
              });
              conflictsWrite.push(settled);
              events.push(conflictEvent(tenant, settled, 'knowledge.conflict_resolved', at));
              item = withoutConflict(item);
            } else {
              // The source it disagreed with gave a newer reading: the conflict is against that.
              conflictsWrite.push(
                Object.freeze({
                  ...open,
                  revision: item.revision,
                  current: {
                    value: item.value,
                    verification: item.verification,
                    provenance: item.provenance,
                  },
                }),
              );
            }
          }
          const action =
            result.outcome === 'created'
              ? 'knowledge.created'
              : result.outcome === 'confirmed'
                ? 'knowledge.confirmed'
                : 'knowledge.updated';
          events.unshift(itemEvent(tenant, item, action, at));
          const write: KnowledgeWrite = {
            items: [item],
            versions: [
              versionOf(item, result.version?.operation ?? 'updated', item.provenance.recordedBy),
            ],
            conflicts: conflictsWrite,
            events,
            documents: docs,
          };
          return { write, result: { outcome: result.outcome, itemId, revision: item.revision } };
        },
      );
      logger.info('brain.knowledge_written', {
        outcome: outcome.outcome,
        domain: input.domain,
        source: source.type,
        latencyMs: Date.now() - started,
      });
      if (outcome.outcome === 'conflict' || outcome.outcome === 'conflict_updated') {
        logger.warn('brain.knowledge_conflict', { domain: input.domain, source: source.type });
      }
      outcomes.push(outcome);
    }
    const pending: readonly KnowledgeDocument[] = documents ?? [];
    if (pending.length > 0) {
      await repository.write(organizationId, { itemIds: [] }, () => ({
        write: { items: [], versions: [], conflicts: [], events: [], documents: pending },
        result: undefined,
      }));
    }
    return outcomes;
  }

  /** Checks candidates one by one: a bad one is dropped and counted, never stored. */
  function checkAll(inputs: readonly unknown[], confidenceFloor = 0) {
    const valid: KnowledgeInput[] = [];
    let rejected = 0;
    for (const raw of inputs.slice(0, LIMITS.batch)) {
      try {
        const input = checkKnowledgeInput(raw);
        if ((input.confidence ?? 1) < confidenceFloor) rejected += 1;
        else valid.push(input);
      } catch {
        rejected += 1;
      }
    }
    return { valid, rejected: rejected + Math.max(0, inputs.length - LIMITS.batch) };
  }

  async function change(
    tenant: TenantContext,
    itemId: string,
    revision: number,
    apply: (
      item: KnowledgeItem,
      at: IsoTimestamp,
    ) => {
      item: KnowledgeItem;
      operation: KnowledgeVersion['operation'];
      action: AuditEventInput['action'];
      reason?: string;
    },
  ): Promise<KnowledgeOutcome> {
    const organizationId = await organizationOf(tenant, 'knowledge.manage', true);
    if (!ITEM_ID.test(itemId)) throw new BrainError('not_found');
    return repository.write(organizationId, { itemIds: [itemId] }, ({ items }) => {
      const current = items.get(itemId);
      if (current === undefined) throw new BrainError('not_found');
      if (current.revision !== revision) throw new BrainError('stale_revision');
      if (current.openConflictId !== undefined) throw new BrainError('conflict_open');
      const at = now();
      const next = apply(current, at.toISOString() as IsoTimestamp);
      const item = Object.freeze({
        ...next.item,
        revision: current.revision + 1,
        updatedAt: at.toISOString() as IsoTimestamp,
      });
      return {
        write: {
          items: [item],
          versions: [versionOf(item, next.operation, recorderOf(tenant), next.reason)],
          conflicts: [],
          events: [itemEvent(tenant, item, next.action, at, next.reason)],
        },
        result: { outcome: 'updated' as MergeOutcome, itemId, revision: item.revision },
      };
    });
  }

  async function visibleItems(
    tenant: TenantContext,
    organizationId: OrganizationId,
    domains: readonly KnowledgeDomain[] | undefined,
    includeInactive: boolean,
    ceiling = ceilingOf(tenant),
  ): Promise<KnowledgeItem[]> {
    const items = await repository.listItems(
      organizationId,
      {
        ...(domains === undefined ? {} : { domains }),
        ...(includeInactive ? {} : { statuses: ['active'] }),
      },
      LIMITS.readWindow,
    );
    return items.filter(
      (item) =>
        item.organizationId === organizationId && sensitivityAllows(ceiling, item.sensitivity),
    );
  }

  async function gapsOf(
    tenant: TenantContext,
    organizationId: OrganizationId,
  ): Promise<KnowledgeGaps> {
    const items = await visibleItems(tenant, organizationId, undefined, false);
    const known = new Set(
      items.filter((i) => i.subject === undefined).map((i) => `${i.domain}.${i.key}`),
    );
    const conflicts = await repository.listConflicts(organizationId, 'open');
    return Object.freeze({
      questions: ONBOARDING_QUESTIONS.filter((q) => !known.has(`${q.domain}.${q.key}`)),
      toConfirm: items
        .map(viewOf)
        .filter((i) => i.needsConfirmation)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 10),
      openConflicts: conflicts.length,
    });
  }

  const service: CompanyBrainService = {
    async summary(tenant) {
      const organizationId = await organizationOf(tenant, 'knowledge.read');
      const items = await visibleItems(tenant, organizationId, undefined, false);
      const byDomain: Partial<Record<KnowledgeDomain, number>> = {};
      for (const item of items) byDomain[item.domain] = (byDomain[item.domain] ?? 0) + 1;
      return Object.freeze({
        initialized: items.length > 0,
        items: items.length,
        byDomain: Object.freeze(byDomain),
        gaps: await gapsOf(tenant, organizationId),
      });
    },

    async list(tenant, filter = {}) {
      const organizationId = await organizationOf(tenant, 'knowledge.read');
      if (filter.domain !== undefined && !isKnowledgeDomain(filter.domain)) {
        throw new BrainError('invalid_knowledge', 'domain');
      }
      const items = await visibleItems(
        tenant,
        organizationId,
        filter.domain === undefined ? undefined : [filter.domain],
        filter.includeInactive === true,
      );
      return items
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.key.localeCompare(b.key))
        .map(viewOf);
    },

    async get(tenant, itemId) {
      const organizationId = await organizationOf(tenant, 'knowledge.read');
      if (!ITEM_ID.test(itemId)) throw new BrainError('not_found');
      const item = await repository.findItem(organizationId, itemId);
      if (item === undefined || !sensitivityAllows(ceilingOf(tenant), item.sensitivity)) {
        throw new BrainError('not_found');
      }
      return {
        item: viewOf(item),
        versions: await repository.listVersions(organizationId, itemId),
      };
    },

    async propose(tenant, raw) {
      const organizationId = await organizationOf(tenant, 'knowledge.propose');
      const input = checkKnowledgeInput(raw);
      const [outcome] = await store(tenant, organizationId, [input], {
        type: sourceTypeOf(tenant),
      });
      return outcome as KnowledgeOutcome;
    },

    async ingest(tenant, source, inputs, confidenceFloor) {
      const organizationId = await organizationOf(tenant, 'knowledge.propose');
      if (source.type === 'user' && tenant.actor !== 'user') throw new BrainError('requires_user');
      const { valid, rejected } = checkAll(inputs, confidenceFloor);
      return { outcomes: await store(tenant, organizationId, valid, source), rejected };
    },

    confirm(tenant, itemId, revision) {
      return change(tenant, itemId, revision, (item) => ({
        item: { ...item, verification: 'confirmed', status: 'active' },
        operation: 'confirmed',
        action: 'knowledge.confirmed',
      }));
    },

    invalidate(tenant, itemId, revision, reason) {
      if (reason !== undefined && !REASON.test(reason)) {
        return Promise.reject(new BrainError('invalid_knowledge', 'reason'));
      }
      return change(tenant, itemId, revision, (item, at) => ({
        item: { ...item, status: 'outdated', effectiveUntil: at },
        operation: 'invalidated',
        action: 'knowledge.invalidated',
        ...(reason === undefined ? {} : { reason }),
      }));
    },

    archive(tenant, itemId, revision) {
      return change(tenant, itemId, revision, (item) => ({
        item: { ...item, status: 'archived' },
        operation: 'archived',
        action: 'knowledge.archived',
      }));
    },

    async conflicts(tenant) {
      const organizationId = await organizationOf(tenant, 'knowledge.read');
      const ceiling = ceilingOf(tenant);
      const open = await repository.listConflicts(organizationId, 'open');
      const visible: KnowledgeConflict[] = [];
      for (const conflict of open) {
        const item = await repository.findItem(organizationId, conflict.itemId);
        if (item !== undefined && sensitivityAllows(ceiling, item.sensitivity))
          visible.push(conflict);
      }
      return visible;
    },

    async resolveConflict(tenant, conflictId, choice) {
      const organizationId = await organizationOf(tenant, 'knowledge.manage', true);
      if (!UUID.test(conflictId)) throw new BrainError('not_found');
      if (choice !== 'kept_current' && choice !== 'took_candidate') {
        throw new BrainError('invalid_knowledge', 'choice');
      }
      const conflict = await repository.findConflict(organizationId, conflictId);
      if (conflict === undefined) throw new BrainError('not_found');
      return repository.write(
        organizationId,
        { itemIds: [conflict.itemId], conflictIds: [conflictId] },
        ({ items, conflicts }) => {
          const open = conflicts.get(conflictId);
          const current = items.get(conflict.itemId);
          if (open === undefined || current === undefined) throw new BrainError('not_found');
          if (open.status !== 'open') throw new BrainError('not_open');
          const at = now();
          const iso = at.toISOString() as IsoTimestamp;
          const base = withoutConflict(current);
          const item: KnowledgeItem = Object.freeze(
            choice === 'took_candidate'
              ? {
                  ...base,
                  value: open.candidate.value,
                  provenance: open.candidate.provenance,
                  verification: 'confirmed',
                  effectiveFrom: iso,
                  revision: current.revision + 1,
                  updatedAt: iso,
                }
              : {
                  ...base,
                  verification: 'confirmed',
                  revision: current.revision + 1,
                  updatedAt: iso,
                },
          );
          const settled: KnowledgeConflict = Object.freeze({
            ...open,
            status: 'resolved',
            resolution: choice,
            resolvedBy: tenant.userId,
            resolvedAt: iso,
          });
          return {
            write: {
              items: [item],
              versions: [versionOf(item, 'conflict_resolved', recorderOf(tenant), choice)],
              conflicts: [settled],
              events: [
                itemEvent(
                  tenant,
                  item,
                  choice === 'took_candidate' ? 'knowledge.updated' : 'knowledge.confirmed',
                  at,
                ),
                conflictEvent(tenant, settled, 'knowledge.conflict_resolved', at),
              ],
            },
            result: {
              outcome: 'updated' as MergeOutcome,
              itemId: item.id,
              revision: item.revision,
            },
          };
        },
      );
    },

    async context(tenant, request) {
      const started = Date.now();
      const organizationId = await organizationOf(tenant, 'knowledge.read');
      const personCeiling = ceilingOf(tenant);
      let allowed: readonly KnowledgeDomain[];
      let ceiling: KnowledgeSensitivity;
      if (request.purpose === 'gia') {
        allowed = DOMAIN_IDS;
        ceiling = personCeiling;
      } else {
        const access = DEPARTMENT_ACCESS[request.purpose];
        allowed = access?.domains ?? [];
        ceiling =
          access === undefined
            ? 'internal'
            : sensitivityAllows(personCeiling, access.maxSensitivity)
              ? access.maxSensitivity
              : personCeiling;
      }
      const asked = (request.domains ?? allowed).filter(isKnowledgeDomain);
      const domains = asked.filter((d) => allowed.includes(d));
      const withheld = (request.domains ?? []).filter((d) => !allowed.includes(d));
      const items =
        domains.length === 0
          ? []
          : await visibleItems(tenant, organizationId, domains, false, ceiling);

      const keys = new Set(request.keys ?? []);
      const subjects = new Set((request.subjects ?? []).map((s) => `${s.type}:${s.id}`));
      const terms = new Set(words(request.query ?? ''));
      const focused = keys.size > 0 || subjects.size > 0 || terms.size > 0;
      const TRUST = { confirmed: 3, calculated: 2, imported: 2, unverified: 1, proposed: 0 };
      const scored = items
        .map((item) => {
          let match = 0;
          if (keys.has(item.key)) match += 5;
          if (item.subject !== undefined && subjects.has(`${item.subject.type}:${item.subject.id}`))
            match += 5;
          if (terms.size > 0) {
            const haystack = new Set(
              words(
                `${item.key} ${item.label ?? ''} ${item.subject?.id ?? ''} ${valueText(item.value)}`,
              ),
            );
            for (const term of terms) if (haystack.has(term)) match += 2;
          }
          return { item, match, score: match * 10 + TRUST[item.verification] };
        })
        .filter((s) => !focused || s.match > 0)
        .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
      const limit = Math.min(Math.max(1, request.limit ?? 20), LIMITS.contextFacts);
      const chosen = scored.slice(0, limit).map(({ item }) => {
        const view = viewOf(item);
        return Object.freeze({
          id: item.id,
          domain: item.domain,
          key: item.key,
          ...(item.subject === undefined ? {} : { subject: item.subject }),
          ...(item.label === undefined ? {} : { label: item.label }),
          value: valueText(item.value),
          verification: item.verification,
          needsConfirmation: view.needsConfirmation,
          source: item.provenance.sourceType,
          updatedAt: item.updatedAt,
        });
      });
      const version = chosen.reduce(
        (latest, f) => (f.updatedAt > latest ? f.updatedAt : latest),
        '',
      );
      logger.info('brain.context_retrieved', {
        purpose: request.purpose,
        facts: chosen.length,
        candidates: items.length,
        latencyMs: Date.now() - started,
      });
      return Object.freeze({
        ref: Object.freeze({
          kind: 'company_context',
          id: `company_brain:${organizationId}`,
          version: version === '' ? 'empty' : version,
        }),
        purpose: request.purpose,
        facts: Object.freeze(chosen),
        withheld: Object.freeze(withheld),
        truncated: scored.length > chosen.length,
      });
    },

    async gaps(tenant) {
      const organizationId = await organizationOf(tenant, 'knowledge.read');
      return gapsOf(tenant, organizationId);
    },

    async capture(tenant, text) {
      const organizationId = await organizationOf(tenant, 'knowledge.capture', true);
      if (!can(tenant, 'knowledge.propose')) throw new BrainError('permission_denied');
      if (typeof text !== 'string' || text.trim() === '' || text.length > LIMITS.textLength * 4) {
        throw new BrainError('invalid_knowledge', 'text');
      }
      if (extractor === undefined) throw new BrainError('extraction_unavailable');
      const extracted = await extractor.extract(tenant, {
        subjectId: randomUUID(),
        kind: 'statement',
        text,
      });
      if (extracted.status !== 'extracted') {
        logger.warn('brain.extraction_failed', { kind: 'statement', code: extracted.code });
        return { outcomes: [], rejected: 0, extraction: extracted.status };
      }
      const { valid, rejected } = checkAll(extracted.facts);
      // GIA interpreted it: proposals the person confirms, never confirmed facts.
      const outcomes = await store(tenant, organizationId, valid, { type: 'gia', id: 'capture' });
      return { outcomes, rejected, extraction: 'extracted' };
    },

    async ingestDocument(tenant, raw) {
      const organizationId = await organizationOf(tenant, 'knowledge.propose', true);
      const { name, text } = raw;
      if (typeof name !== 'string' || name.trim() === '' || name.length > LIMITS.documentName) {
        throw new BrainError('invalid_document', 'name');
      }
      if (
        typeof text !== 'string' ||
        text.trim() === '' ||
        text.length > LIMITS.documentCharacters
      ) {
        throw new BrainError('invalid_document', 'text');
      }
      const sha256 = createHash('sha256').update(text).digest('hex');
      const id = `${organizationId}_d_${sha256.slice(0, 32)}`;
      const existing = await repository.findDocument(organizationId, id);
      const strip = (document: KnowledgeDocument) => omit(document, 'text');
      if (existing !== undefined) {
        return { document: strip(existing), extraction: 'duplicate', outcomes: [], rejected: 0 };
      }
      const at = now().toISOString() as IsoTimestamp;
      const stored: KnowledgeDocument = Object.freeze({
        id,
        organizationId,
        name: name.trim(),
        sha256,
        characters: text.length,
        text,
        status: 'stored',
        facts: 0,
        createdBy: tenant.userId,
        createdAt: at,
        updatedAt: at,
      });
      const receivedEvent = audit(
        tenant,
        organizationId,
        {
          action: 'knowledge.document_ingested',
          target: { type: 'knowledge_document', id },
          reason: 'stored',
        },
        now(),
      );
      await repository.write(organizationId, { itemIds: [] }, () => ({
        write: {
          items: [],
          versions: [],
          conflicts: [],
          events: [receivedEvent],
          documents: [stored],
        },
        result: undefined,
      }));
      if (extractor === undefined || !can(tenant, 'knowledge.capture')) {
        return { document: strip(stored), extraction: 'unavailable', outcomes: [], rejected: 0 };
      }
      const extracted = await extractor.extract(tenant, { subjectId: id, kind: 'document', text });
      if (extracted.status === 'unavailable') {
        // No model may be used here (not configured, not allowed, no credits): kept as received.
        return { document: strip(stored), extraction: 'unavailable', outcomes: [], rejected: 0 };
      }
      if (extracted.status !== 'extracted') {
        logger.warn('brain.extraction_failed', { kind: 'document', code: extracted.code });
        const failed = Object.freeze({
          ...stored,
          status: 'extraction_failed' as const,
          updatedAt: now().toISOString() as IsoTimestamp,
        });
        await repository.write(organizationId, { itemIds: [] }, () => ({
          write: { items: [], versions: [], conflicts: [], events: [], documents: [failed] },
          result: undefined,
        }));
        return { document: strip(failed), extraction: extracted.status, outcomes: [], rejected: 0 };
      }
      const { valid, rejected } = checkAll(extracted.facts);
      const done: KnowledgeDocument = Object.freeze({
        ...stored,
        status: 'extracted',
        facts: valid.length,
        updatedAt: now().toISOString() as IsoTimestamp,
      });
      const outcomes = await store(
        tenant,
        organizationId,
        valid,
        {
          type: 'document',
          id,
          reference: done.name.slice(0, 100),
        },
        [done],
      );
      return { document: strip(done), extraction: 'extracted', outcomes, rejected };
    },
  };
  return Object.freeze(service);
}

function withoutConflict(item: KnowledgeItem): KnowledgeItem {
  return Object.freeze(omit(item, 'openConflictId'));
}

const sameCandidate = (conflict: KnowledgeConflict, item: KnowledgeItem): boolean =>
  JSON.stringify(conflict.candidate.value) === JSON.stringify(item.value);
