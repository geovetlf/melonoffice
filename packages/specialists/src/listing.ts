import { isDepartmentId } from '@melonoffice/departments';
import type {
  AgentAutonomy,
  DepartmentId,
  OrganizationId,
  Specialist,
  SpecialistId,
} from '@melonoffice/domain';
import { SpecialistError } from './errors.js';
import { isSpecialistStatus } from './lifecycle.js';
import { autonomyOf, DEFAULT_AGENT_AUTONOMY, isAgentAutonomy, isSpecialistId } from './model.js';
import {
  SpecialistIndexUnavailable,
  type SpecialistPageRequest,
  type SpecialistRepository,
} from './repository.js';

/**
 * The organization's agents one page at a time (AE-4, ADR-0115), for organizations with hundreds
 * or thousands of them. Status and department narrow the query in the store; a skill and an
 * autonomy level other than the default narrow it through an index (ADR-0118); a name search
 * narrows what the store returns, reading at most `AGENT_SCAN_MAX` records per request and
 * handing back a cursor where it stopped, so no request reads every agent. Order is the agent's
 * id: stable while agents are added, renamed or change status.
 */

export const AGENT_PAGE_SIZE = Object.freeze({ page: 25, max: 100 });
/** The most records one request reads to fill a page when a search or a skill narrows it. */
export const AGENT_SCAN_MAX = 500;
export const MAX_AGENT_QUERY_LENGTH = 100;

export interface AgentListQuery {
  readonly limit: number;
  readonly after?: SpecialistId;
  readonly status?: SpecialistPageRequest['status'];
  readonly departmentId?: DepartmentId;
  /** Words in the agent's name, any case and accents. */
  readonly q?: string;
  /** An agent that has this skill, at any version. */
  readonly skill?: string;
  /** An agent at this level of autonomy (AE-4.4), the default included. */
  readonly autonomy?: AgentAutonomy;
}

export interface AgentListPage {
  readonly items: readonly Specialist[];
  /** Where the next page starts, or null at the end. */
  readonly nextCursor: string | null;
}

const bad = (field: string): never => {
  throw new SpecialistError('invalid_specialist', field);
};

const SKILL = /^[a-z][a-z0-9_]{0,63}$/;

export const encodeAgentCursor = (after: SpecialistId): string =>
  Buffer.from(JSON.stringify({ a: after })).toString('base64url');

export function decodeAgentCursor(value: string): SpecialistId {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const after = (parsed as { a?: unknown }).a;
    if (isSpecialistId(after)) return after;
  } catch {
    // Falls through: any malformed cursor is the same error.
  }
  return bad('cursor');
}

/** Folds case and accents, so "Mónica" matches "monica". */
export const foldText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en');

/**
 * Checks a list request's query parameters (all optional strings) and returns the query, scoped
 * to `organizationId`: a department of another organization is refused like a malformed one.
 */
export function checkAgentListQuery(
  params: Readonly<Record<string, string | undefined>>,
  organizationId: OrganizationId,
): AgentListQuery {
  const { limit, cursor, status, departmentId, q, skill, autonomy } = params;
  let size: number = AGENT_PAGE_SIZE.page;
  if (limit !== undefined) {
    size = Number(limit);
    if (!/^\d{1,3}$/.test(limit) || size < 1 || size > AGENT_PAGE_SIZE.max) bad('limit');
  }
  if (status !== undefined && !isSpecialistStatus(status)) bad('status');
  if (
    departmentId !== undefined &&
    (!isDepartmentId(departmentId) || !departmentId.startsWith(`${organizationId}_`))
  ) {
    bad('departmentId');
  }
  const text = q?.normalize('NFC').trim();
  if (text !== undefined && [...text].length > MAX_AGENT_QUERY_LENGTH) bad('q');
  if (skill !== undefined && !SKILL.test(skill)) bad('skill');
  if (autonomy !== undefined && !isAgentAutonomy(autonomy)) bad('autonomy');
  return Object.freeze({
    limit: size,
    ...(cursor === undefined || cursor === '' ? {} : { after: decodeAgentCursor(cursor) }),
    ...(status === undefined ? {} : { status: status as AgentListQuery['status'] }),
    ...(departmentId === undefined ? {} : { departmentId: departmentId as DepartmentId }),
    ...(text === undefined || text === '' ? {} : { q: text }),
    ...(skill === undefined ? {} : { skill }),
    ...(autonomy === undefined ? {} : { autonomy: autonomy as AgentAutonomy }),
  });
}

/** The most skill versions one store query names (Firestore's `array-contains-any` limit). */
export const SKILL_VERSIONS_QUERIED = 30;

/**
 * The store filter that narrows `query` through an index (ADR-0118), or undefined when none
 * does. A skill is asked as each of its versions 1 to 30; an autonomy level other than the
 * default is asked as stored. The default level is not stored on older agents, so it is read.
 */
export function indexedAgentFilter(
  query: Pick<AgentListQuery, 'skill' | 'autonomy'>,
): Pick<SpecialistPageRequest, 'skillRefs' | 'autonomy'> | undefined {
  if (query.skill !== undefined) {
    const id = query.skill;
    return {
      skillRefs: Array.from({ length: SKILL_VERSIONS_QUERIED }, (_, i) => ({ id, version: i + 1 })),
    };
  }
  if (query.autonomy !== undefined && query.autonomy !== DEFAULT_AGENT_AUTONOMY) {
    return { autonomy: query.autonomy };
  }
  return undefined;
}

/**
 * One page of the organization's agents for `query`. Reads at most `AGENT_SCAN_MAX` records.
 * A skill or an autonomy level is asked of the store through its index, so a page fills from
 * matching agents only; without the index the store refuses and the same request reads as
 * before. Either way the order and the cursor are the agent's id, so a cursor from one way
 * goes on in the other, and every filter is checked again on what the store returns.
 */
export async function pageOfAgents(
  repository: Pick<SpecialistRepository, 'page'>,
  organizationId: OrganizationId,
  query: AgentListQuery,
): Promise<AgentListPage> {
  try {
    return await readAgents(repository, organizationId, query, indexedAgentFilter(query));
  } catch (error) {
    if (!(error instanceof SpecialistIndexUnavailable)) throw error;
    return readAgents(repository, organizationId, query, undefined);
  }
}

async function readAgents(
  repository: Pick<SpecialistRepository, 'page'>,
  organizationId: OrganizationId,
  query: AgentListQuery,
  indexed: Pick<SpecialistPageRequest, 'skillRefs' | 'autonomy'> | undefined,
): Promise<AgentListPage> {
  const { limit, status, departmentId, q, skill, autonomy } = query;
  const words = q === undefined ? [] : foldText(q).split(/\s+/).filter(Boolean);
  const matches = (s: Specialist) =>
    s.organizationId === organizationId &&
    (status === undefined || s.status === status) &&
    (departmentId === undefined || s.configuration.departmentId === departmentId) &&
    (skill === undefined || s.configuration.skills.some((r) => r.id === skill)) &&
    (autonomy === undefined || autonomyOf(s.configuration) === autonomy) &&
    words.every((w) => foldText(s.identity.displayName).includes(w));
  // Narrowed is anything checked here rather than by the store: then it reads in batches.
  const narrowed =
    indexed === undefined
      ? words.length > 0 || skill !== undefined || autonomy !== undefined
      : words.length > 0 ||
        status !== undefined ||
        departmentId !== undefined ||
        (indexed.skillRefs !== undefined && autonomy !== undefined);
  // Through an index the store filters by skill or autonomy only: the composite indexes do not
  // hold status or department, so those are checked here, like the name.
  const storeFilter: Omit<SpecialistPageRequest, 'limit' | 'after'> =
    indexed !== undefined
      ? indexed
      : {
          ...(status === undefined ? {} : { status }),
          ...(departmentId === undefined ? {} : { departmentId }),
        };
  const items: Specialist[] = [];
  let after = query.after;
  let scanned = 0;
  for (;;) {
    // Unnarrowed, the store's page is the answer; narrowed, read in batches until it is full.
    const batch = narrowed ? Math.min(100, AGENT_SCAN_MAX - scanned) : limit;
    const page = await repository.page(organizationId, {
      limit: batch,
      ...(after === undefined ? {} : { after }),
      ...storeFilter,
    });
    scanned += page.items.length;
    for (const specialist of page.items) {
      after = specialist.identity.id;
      if (!matches(specialist)) continue;
      items.push(specialist);
      if (items.length === limit) {
        const last = page.items.indexOf(specialist) === page.items.length - 1;
        return {
          items: Object.freeze(items),
          nextCursor: last && !page.hasMore ? null : encodeAgentCursor(after),
        };
      }
    }
    if (!page.hasMore) return { items: Object.freeze(items), nextCursor: null };
    // A narrowed request stops reading at its limit and says where to go on.
    if (scanned >= AGENT_SCAN_MAX || after === undefined) {
      return {
        items: Object.freeze(items),
        nextCursor: after === undefined ? null : encodeAgentCursor(after),
      };
    }
  }
}
