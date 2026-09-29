import { createHash } from 'node:crypto';
import type {
  Contact,
  ContactId,
  ContactStage,
  FollowUp,
  FollowUpStatus,
  Opportunity,
  OpportunityId,
  OpportunityStatus,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { ConversationError } from './errors.js';
import { isUuid } from './model.js';

/**
 * Pages of Comercial's lists (ADR-0061): contacts, opportunities and follow-ups are read one page
 * at a time, in a stable order, from a position the previous page handed out. Firestore reads only
 * that page; nothing is loaded to be cut afterwards.
 *
 * A cursor is only a position: the last record's sort time and id, plus which organization, list
 * and filter it came from. It grants nothing. Every page is read in the organization of the
 * person asking, with that person's permissions, and a cursor made for another organization,
 * list or filter is refused (`invalid_request`, field `cursor`), never followed.
 */

/** Which page of a list a caller asks for: the first without a cursor; `limit` records at most. */
export interface PageInput {
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

/** Where the previous page stopped: the last record's sort time and id. */
export interface PagePosition {
  readonly at: string;
  readonly id: string;
}

export interface PageRequest<F> {
  readonly filter: F;
  /** How many records the page holds, at most. */
  readonly limit: number;
  /** Absent: the first page. */
  readonly after?: PagePosition;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Whether a record follows the last one of this page, under the same filter and order. */
  readonly hasMore: boolean;
}

/** Marked contacts (a commercial stage), never archived ones; newest change first. */
export interface ContactPageFilter {
  readonly stage?: ContactStage;
  readonly ownerId?: UserId;
}

/** Newest change first. */
export interface OpportunityPageFilter {
  readonly status?: OpportunityStatus;
  readonly stageId?: string;
  readonly ownerId?: UserId;
  readonly contactId?: ContactId;
}

/** Soonest first. `statuses` absent: every status. */
export interface FollowUpPageFilter {
  readonly statuses?: readonly FollowUpStatus[];
  readonly contactId?: ContactId;
  readonly opportunityId?: OpportunityId;
  readonly assignedTo?: UserId;
}

/** The lists that page, and each one's order. */
export type PagedList = 'contacts' | 'opportunities' | 'follow_ups';

const newestFirst = (a: PagePosition, b: PagePosition) =>
  a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;
const soonestFirst = (a: PagePosition, b: PagePosition) => -newestFirst(a, b);

export const contactPosition = (c: Contact): PagePosition => ({ at: c.updatedAt, id: c.id });
export const opportunityPosition = (o: Opportunity): PagePosition => ({
  at: o.updatedAt,
  id: o.id,
});
export const followUpPosition = (f: FollowUp): PagePosition => ({ at: f.scheduledAt, id: f.id });

export const matchesContactPage = (c: Contact, f: ContactPageFilter): boolean =>
  c.status === 'active' &&
  c.commercial !== undefined &&
  (f.stage === undefined || c.commercial.stage === f.stage) &&
  (f.ownerId === undefined || c.commercial.ownerId === f.ownerId);

export const matchesOpportunityPage = (o: Opportunity, f: OpportunityPageFilter): boolean =>
  (f.status === undefined || o.status === f.status) &&
  (f.stageId === undefined || o.stageId === f.stageId) &&
  (f.ownerId === undefined || o.ownerId === f.ownerId) &&
  (f.contactId === undefined || o.contactId === f.contactId);

export const matchesFollowUpPage = (x: FollowUp, f: FollowUpPageFilter): boolean =>
  (f.statuses === undefined || f.statuses.includes(x.status)) &&
  (f.contactId === undefined || x.contactId === f.contactId) &&
  (f.opportunityId === undefined || x.opportunityId === f.opportunityId) &&
  (f.assignedTo === undefined || x.assignedTo === f.assignedTo);

/**
 * One page of records already in memory, in the list's order: the in-memory repository's pages,
 * and Firestore's while a composite index is still being built. Same order, same positions.
 */
export function pageOf<T>(
  records: readonly T[],
  options: {
    readonly matches: (record: T) => boolean;
    readonly position: (record: T) => PagePosition;
    readonly order: 'newest_first' | 'soonest_first';
    readonly limit: number;
    readonly after?: PagePosition;
  },
): Page<T> {
  const compare = options.order === 'newest_first' ? newestFirst : soonestFirst;
  const { after } = options;
  const sorted = records
    .filter(options.matches)
    .toSorted((a, b) => compare(options.position(a), options.position(b)))
    .filter((r) => after === undefined || compare(options.position(r), after) > 0);
  return Object.freeze({
    items: Object.freeze(sorted.slice(0, options.limit)),
    hasMore: sorted.length > options.limit,
  });
}

/** Page sizes: `page` when none is asked; `max` the most one page holds. */
export const PAGE_SIZES = Object.freeze({
  contacts: Object.freeze({ page: 50, max: 200 }),
  opportunities: Object.freeze({ page: 50, max: 500 }),
  follow_ups: Object.freeze({ page: 50, max: 500 }),
} satisfies Record<PagedList, { page: number; max: number }>);

/** How many records a page asked for holds: `invalid_request` `limit` when out of range. */
export function pageLimit(list: PagedList, value: unknown): number {
  if (value === undefined) return PAGE_SIZES[list].page;
  const n = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > PAGE_SIZES[list].max) {
    throw new ConversationError('invalid_request', 'limit');
  }
  return n;
}

/** The same filter always gives the same fingerprint, whatever the order of its keys. */
function fingerprint(filter: object): string {
  const canonical = JSON.stringify(
    Object.entries(filter)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

interface CursorBody {
  readonly v: 1;
  readonly o: string;
  readonly l: PagedList;
  readonly f: string;
  readonly a: string;
  readonly i: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** The cursor of the page after `last`: opaque to the client, readable only for the same list. */
export function encodeCursor(
  organizationId: OrganizationId,
  list: PagedList,
  filter: object,
  last: PagePosition,
): string {
  const body: CursorBody = {
    v: 1,
    o: organizationId,
    l: list,
    f: fingerprint(filter),
    a: last.at,
    i: last.id,
  };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

/**
 * The position a cursor names, only when it was made for this organization, this list and this
 * filter; `invalid_request` `cursor` otherwise. Nothing in it is trusted beyond a position.
 */
export function decodeCursor(
  cursor: unknown,
  organizationId: OrganizationId,
  list: PagedList,
  filter: object,
): PagePosition | undefined {
  if (cursor === undefined) return undefined;
  const refuse = (): never => {
    throw new ConversationError('invalid_request', 'cursor');
  };
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) refuse();
  let body: Partial<CursorBody>;
  try {
    body = JSON.parse(
      Buffer.from(cursor as string, 'base64url').toString('utf8'),
    ) as Partial<CursorBody>;
  } catch {
    return refuse();
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    body.v !== 1 ||
    body.o !== organizationId ||
    body.l !== list ||
    body.f !== fingerprint(filter) ||
    typeof body.a !== 'string' ||
    !ISO.test(body.a) ||
    Number.isNaN(Date.parse(body.a)) ||
    !isUuid(body.i)
  ) {
    return refuse();
  }
  return Object.freeze({ at: body.a as string, id: body.i as string });
}

/** The cursor of the next page, or null on the last one. */
export function nextCursorOf<T>(
  page: Page<T>,
  position: (record: T) => PagePosition,
  organizationId: OrganizationId,
  list: PagedList,
  filter: object,
): string | null {
  const last = page.items.at(-1);
  return page.hasMore && last !== undefined
    ? encodeCursor(organizationId, list, filter, position(last))
    : null;
}
