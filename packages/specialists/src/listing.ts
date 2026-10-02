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
import { autonomyOf, isAgentAutonomy, isSpecialistId } from './model.js';
import type { SpecialistRepository, SpecialistPageRequest } from './repository.js';

/**
 * The organization's agents one page at a time (AE-4, ADR-0115), for organizations with hundreds
 * or thousands of them. Status and department narrow the query in the store; a name search and a
 * skill narrow what the store returns, reading at most `AGENT_SCAN_MAX` records per request and
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

/** One page of the organization's agents for `query`. Reads at most `AGENT_SCAN_MAX` records. */
export async function pageOfAgents(
  repository: Pick<SpecialistRepository, 'page'>,
  organizationId: OrganizationId,
  query: AgentListQuery,
): Promise<AgentListPage> {
  const { limit, status, departmentId, q, skill, autonomy } = query;
  const words = q === undefined ? [] : foldText(q).split(/\s+/).filter(Boolean);
  const matches = (s: Specialist) =>
    (skill === undefined || s.configuration.skills.some((r) => r.id === skill)) &&
    (autonomy === undefined || autonomyOf(s.configuration) === autonomy) &&
    words.every((w) => foldText(s.identity.displayName).includes(w));
  const narrowed = words.length > 0 || skill !== undefined || autonomy !== undefined;
  const items: Specialist[] = [];
  let after = query.after;
  let scanned = 0;
  for (;;) {
    // Unnarrowed, the store's page is the answer; narrowed, read in batches until it is full.
    const batch = narrowed ? Math.min(100, AGENT_SCAN_MAX - scanned) : limit;
    const page = await repository.page(organizationId, {
      limit: batch,
      ...(after === undefined ? {} : { after }),
      ...(status === undefined ? {} : { status }),
      ...(departmentId === undefined ? {} : { departmentId }),
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
