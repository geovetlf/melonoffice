import {
  isBrainError,
  customerKnowledge,
  pipelineKnowledge,
  operationalKnowledge,
  organizationKnowledge,
  profileKnowledge,
  type BrainErrorCode,
  type CompanyBrainService,
  type KnowledgeView,
} from '@melonoffice/brain';
import type { BusinessProfileRepository } from '@melonoffice/business';
import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  ChannelConnection,
  KnowledgeConflict,
  KnowledgeRecorder,
  KnowledgeVersion,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { SpecialistRepository } from '@melonoffice/specialists';
import type { TenancyStore, TenantContext } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

const STATUS: Record<BrainErrorCode, ContentfulStatusCode> = {
  unresolved_tenant: 403,
  permission_denied: 403,
  requires_user: 403,
  organization_inactive: 403,
  invalid_knowledge: 400,
  invalid_document: 400,
  not_found: 404,
  stale_revision: 409,
  conflict_open: 409,
  not_open: 409,
  extraction_unavailable: 503,
};

/** What `sync` reads to feed Company Brain from MelonOffice's own records (ADR-0051). */
export interface BrainSources {
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly businessProfiles?: Pick<BusinessProfileRepository, 'find'>;
  readonly departments?: Pick<DepartmentRepository, 'list'>;
  readonly specialists?: Pick<SpecialistRepository, 'list'>;
  readonly connections?: {
    list(organizationId: OrganizationId): Promise<readonly ChannelConnection[]>;
  };
  /** How many contacts are at each commercial stage (C1). */
  readonly contacts?: {
    counts(
      organizationId: OrganizationId,
    ): Promise<{ readonly lead: number; readonly customer: number; readonly inactive: number }>;
  };
  /** Where the sales pipeline stands (C2). */
  readonly opportunities?: {
    summary(organizationId: OrganizationId): Promise<Parameters<typeof pipelineKnowledge>[0]>;
  };
}

/**
 * Company Brain over HTTP (ADR-0051), under `/v1/organizations/:id/brain`. The organization and
 * the person come from the token and the path; every rule (permissions, sensitivity, who may
 * confirm) is the service's, so GIA, agents and the server's own sources follow the same ones.
 */
export function registerBrainRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly brain: CompanyBrainService;
    readonly sources: BrainSources;
  },
): void {
  const { brain, sources } = dependencies;
  const base = '/v1/organizations/:organizationId/brain';

  const answer = async (c: Context<AuthEnv>, work: () => Promise<unknown>) => {
    try {
      return c.json((await work()) as object);
    } catch (error) {
      if (!isBrainError(error)) throw error;
      return c.json(
        { error: error.code, ...(error.field === undefined ? {} : { field: error.field }) },
        STATUS[error.code],
      );
    }
  };

  const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown> | undefined> => {
    const value: unknown = await c.req.json().catch(() => undefined);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  };

  const revisionOf = (b: Record<string, unknown>) =>
    typeof b.revision === 'number' && Number.isSafeInteger(b.revision) ? b.revision : undefined;

  app.get(
    base,
    withPermission('knowledge.read', dependencies, (c, tenant) =>
      answer(c, () => brain.summary(tenant)),
    ),
  );

  app.get(
    `${base}/knowledge`,
    withPermission('knowledge.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const domain = c.req.query('domain');
        const items = await brain.list(tenant, {
          ...(domain === undefined ? {} : { domain: domain as never }),
          includeInactive: c.req.query('inactive') === '1',
        });
        return { items: items.map((i) => toKnowledgeView(i, tenant.userId)) };
      }),
    ),
  );

  app.get(
    `${base}/knowledge/:itemId`,
    withPermission('knowledge.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const { item, versions } = await brain.get(tenant, c.req.param('itemId') ?? '');
        return {
          item: toKnowledgeView(item, tenant.userId),
          versions: versions.map((v) => toVersionView(v, tenant.userId)),
        };
      }),
    ),
  );

  app.post(
    `${base}/knowledge`,
    withPermission('knowledge.propose', dependencies, async (c, tenant) => {
      const input = await body(c);
      if (input === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, () => brain.propose(tenant, input));
    }),
  );

  for (const operation of ['confirm', 'invalidate', 'archive'] as const) {
    app.post(
      `${base}/knowledge/:itemId/${operation}`,
      withPermission('knowledge.manage', dependencies, async (c, tenant) => {
        const input = await body(c);
        const revision = input === undefined ? undefined : revisionOf(input);
        if (input === undefined || revision === undefined) {
          return c.json({ error: 'invalid_request' }, 400);
        }
        const itemId = c.req.param('itemId') ?? '';
        return answer(c, () =>
          operation === 'confirm'
            ? brain.confirm(tenant, itemId, revision)
            : operation === 'archive'
              ? brain.archive(tenant, itemId, revision)
              : brain.invalidate(
                  tenant,
                  itemId,
                  revision,
                  typeof input.reason === 'string' ? input.reason : undefined,
                ),
        );
      }),
    );
  }

  app.get(
    `${base}/conflicts`,
    withPermission('knowledge.read', dependencies, (c, tenant) =>
      answer(c, async () => ({
        conflicts: (await brain.conflicts(tenant)).map((k) => toConflictView(k, tenant.userId)),
      })),
    ),
  );

  app.post(
    `${base}/conflicts/:conflictId/resolve`,
    withPermission('knowledge.manage', dependencies, async (c, tenant) => {
      const input = await body(c);
      if (input === undefined || typeof input.choice !== 'string') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, () =>
        brain.resolveConflict(tenant, c.req.param('conflictId') ?? '', input.choice as never),
      );
    }),
  );

  app.get(
    `${base}/gaps`,
    withPermission('knowledge.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const gaps = await brain.gaps(tenant);
        return { ...gaps, toConfirm: gaps.toConfirm.map((i) => toKnowledgeView(i, tenant.userId)) };
      }),
    ),
  );

  // Selective retrieval, as GIA and agents get it: only the facts asked for, never the whole.
  app.post(
    `${base}/context`,
    withPermission('knowledge.read', dependencies, async (c, tenant) => {
      const input = await body(c);
      if (input === undefined || typeof input.purpose !== 'string') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const list = (v: unknown) => (Array.isArray(v) ? v : undefined);
      return answer(c, () =>
        brain.context(tenant, {
          purpose: input.purpose as string,
          ...(list(input.domains) === undefined ? {} : { domains: input.domains as never }),
          ...(list(input.keys) === undefined
            ? {}
            : {
                keys: (input.keys as unknown[]).filter((k): k is string => typeof k === 'string'),
              }),
          ...(list(input.subjects) === undefined ? {} : { subjects: input.subjects as never }),
          ...(typeof input.query === 'string' ? { query: input.query.slice(0, 500) } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        }),
      );
    }),
  );

  app.post(
    `${base}/capture`,
    withPermission('knowledge.capture', dependencies, async (c, tenant) => {
      const input = await body(c);
      if (input === undefined || typeof input.text !== 'string') {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, () => brain.capture(tenant, input.text as string));
    }),
  );

  app.post(
    `${base}/documents`,
    withPermission('knowledge.propose', dependencies, async (c, tenant) => {
      const input = await body(c);
      if (input === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, () => brain.ingestDocument(tenant, { name: input.name, text: input.text }));
    }),
  );

  // Feeds Company Brain from what MelonOffice already holds; safe to repeat (unchanged facts
  // record nothing).
  app.post(
    `${base}/sync`,
    withPermission('knowledge.propose', dependencies, (c, tenant) =>
      answer(c, () => syncCompanyBrain(brain, sources, tenant)),
    ),
  );
}

/** The organization, its business profile and MelonOffice's own records, into Company Brain. */
export async function syncCompanyBrain(
  brain: Pick<CompanyBrainService, 'ingest'>,
  sources: BrainSources,
  tenant: TenantContext,
) {
  const organizationId = tenant.organizationId;
  const organization = await sources.organizations.findOrganization(organizationId);
  let changed = 0;
  const count = (r: { outcomes: readonly { outcome: string }[] }) => {
    changed += r.outcomes.filter((o) => o.outcome !== 'unchanged').length;
  };
  if (organization !== undefined && tenant.actor === 'user') {
    const { source, facts } = organizationKnowledge(organization);
    count(await brain.ingest(tenant, source, facts));
  }
  const profile = await sources.businessProfiles?.find(organizationId);
  if (profile !== undefined && tenant.actor === 'user') {
    const { source, facts } = profileKnowledge(profile);
    count(await brain.ingest(tenant, source, facts));
  }
  if (sources.departments !== undefined) {
    const departments = await sources.departments.list(organizationId);
    const specialists = (await sources.specialists?.list(organizationId)) ?? [];
    const connections = (await sources.connections?.list(organizationId)) ?? [];
    const { source, facts } = operationalKnowledge({
      departments: departments
        .filter((d) => d.status === 'active')
        .map((d) => (d.origin.kind === 'catalog' ? d.origin.typeId : d.origin.name)),
      activeAgents: specialists.filter((s) => s.status === 'active').length,
      channels: connections,
    });
    count(await brain.ingest(tenant, source, facts));
  }
  if (sources.contacts !== undefined) {
    const { source, facts } = customerKnowledge(await sources.contacts.counts(organizationId));
    count(await brain.ingest(tenant, source, facts));
  }
  if (sources.opportunities !== undefined) {
    const { source, facts } = pipelineKnowledge(
      await sources.opportunities.summary(organizationId),
    );
    count(await brain.ingest(tenant, source, facts));
  }
  return { changed };
}

/** Who recorded it, as the reader understands it; never another person's id. */
function recorderView(recorder: KnowledgeRecorder, viewer: UserId): string {
  if (recorder.type === 'system') return 'system';
  if (recorder.type === 'runtime') return 'agent';
  if (recorder.via === 'gia') return 'gia';
  return recorder.userId === viewer ? 'you' : 'member';
}

export function toKnowledgeView(item: KnowledgeView, viewer: UserId) {
  return {
    id: item.id,
    domain: item.domain,
    key: item.key,
    subject: item.subject ?? null,
    label: item.label ?? null,
    value: item.value,
    verification: item.verification,
    status: item.status,
    sensitivity: item.sensitivity,
    critical: item.critical,
    needsConfirmation: item.needsConfirmation,
    source: {
      type: item.provenance.sourceType,
      id: item.provenance.sourceId ?? null,
      reference: item.provenance.sourceReference ?? null,
      recordedBy: recorderView(item.provenance.recordedBy, viewer),
      confidence: item.provenance.confidence ?? null,
    },
    relations: item.relations,
    effectiveFrom: item.effectiveFrom,
    effectiveUntil: item.effectiveUntil ?? null,
    revision: item.revision,
    updatedAt: item.updatedAt,
    openConflictId: item.openConflictId ?? null,
  };
}

function toVersionView(version: KnowledgeVersion, viewer: UserId) {
  return {
    revision: version.revision,
    operation: version.operation,
    value: version.value,
    verification: version.verification,
    status: version.status,
    source: version.provenance.sourceType,
    changedAt: version.changedAt,
    changedBy: recorderView(version.changedBy, viewer),
    reason: version.reason ?? null,
  };
}

function toConflictView(conflict: KnowledgeConflict, viewer: UserId) {
  const claim = (c: KnowledgeConflict['current']) => ({
    value: c.value,
    verification: c.verification,
    source: c.provenance.sourceType,
    recordedBy: recorderView(c.provenance.recordedBy, viewer),
  });
  return {
    id: conflict.id,
    itemId: conflict.itemId,
    domain: conflict.domain,
    key: conflict.key,
    subject: conflict.subject ?? null,
    label: conflict.label ?? null,
    current: claim(conflict.current),
    candidate: claim(conflict.candidate),
    createdAt: conflict.createdAt,
  };
}
