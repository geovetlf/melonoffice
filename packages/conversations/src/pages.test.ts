import type { OrganizationId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { ConversationError } from './errors.js';
import { decodeCursor, encodeCursor, nextCursorOf, pageLimit, pageOf } from './pages.js';

const ORG_A = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ORG_B = '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const id = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;

interface Row {
  readonly id: string;
  readonly at: string;
  readonly keep: boolean;
}

// Ten rows; rows 3 to 6 share one time, so only the id orders them.
const ROWS: Row[] = Array.from({ length: 10 }, (_, i) => ({
  id: id(i),
  at: i >= 3 && i <= 6 ? '2026-09-28T12:00:00.000Z' : `2026-09-${String(10 + i)}T12:00:00.000Z`,
  keep: i !== 8,
}));

const walk = (order: 'newest_first' | 'soonest_first', limit: number) => {
  const seen: Row[] = [];
  let after: { at: string; id: string } | undefined;
  for (let n = 0; n < 20; n += 1) {
    const page = pageOf(ROWS, {
      matches: (r) => r.keep,
      position: (r) => ({ at: r.at, id: r.id }),
      order,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    seen.push(...page.items);
    const last = page.items.at(-1);
    if (!page.hasMore || last === undefined) return { seen, pages: n + 1 };
    after = { at: last.at, id: last.id };
  }
  throw new Error('never ends');
};

const refused = (work: () => unknown, field: string) => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationError);
    expect(error).toMatchObject({ code: 'invalid_request', detail: field });
    return;
  }
  throw new Error('not refused');
};

describe('pages (ADR-0061)', () => {
  it('walks every kept row once, in a stable order, ties broken by id', () => {
    for (const order of ['newest_first', 'soonest_first'] as const) {
      for (const limit of [1, 2, 3, 9, 10]) {
        const { seen, pages } = walk(order, limit);
        expect(seen.map((r) => r.id)).toHaveLength(9);
        expect(new Set(seen.map((r) => r.id)).size).toBe(9);
        expect(pages).toBe(Math.ceil(9 / limit));
        const sorted = seen.toSorted((a, b) =>
          a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at),
        );
        expect(seen).toEqual(order === 'soonest_first' ? sorted : sorted.toReversed());
      }
    }
  });

  it('says hasMore only when a row follows, and an empty list is one empty page', () => {
    const exact = pageOf(ROWS, {
      matches: (r) => r.keep,
      position: (r) => ({ at: r.at, id: r.id }),
      order: 'newest_first',
      limit: 9,
    });
    expect(exact.hasMore).toBe(false);
    const empty = pageOf([] as Row[], {
      matches: () => true,
      position: (r) => ({ at: r.at, id: r.id }),
      order: 'newest_first',
      limit: 5,
    });
    expect(empty).toEqual({ items: [], hasMore: false });
    expect(nextCursorOf(exact, (r) => ({ at: r.at, id: r.id }), ORG_A, 'contacts', {})).toBeNull();
  });

  it('reads a cursor back only for the same organization, list and filter', () => {
    const position = { at: '2026-09-28T12:00:00.000Z', id: id(4) };
    const filter = { stage: 'lead' };
    const cursor = encodeCursor(ORG_A, 'contacts', filter, position);
    expect(decodeCursor(cursor, ORG_A, 'contacts', { stage: 'lead' })).toEqual(position);
    expect(decodeCursor(undefined, ORG_A, 'contacts', filter)).toBeUndefined();
    // The filter's keys in another order are the same filter; an absent value is no value.
    const two = encodeCursor(ORG_A, 'opportunities', { status: 'open', ownerId: id(1) }, position);
    expect(
      decodeCursor(two, ORG_A, 'opportunities', {
        ownerId: id(1),
        status: 'open',
        stageId: undefined,
      }),
    ).toEqual(position);
    refused(() => decodeCursor(cursor, ORG_B, 'contacts', filter), 'cursor');
    refused(() => decodeCursor(cursor, ORG_A, 'opportunities', filter), 'cursor');
    refused(() => decodeCursor(cursor, ORG_A, 'contacts', { stage: 'customer' }), 'cursor');
    refused(() => decodeCursor(cursor, ORG_A, 'contacts', {}), 'cursor');
    const body = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>;
    const forge = (change: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...body, ...change })).toString('base64url');
    for (const bad of [
      forge({ o: ORG_B }),
      forge({ i: 'not-an-id' }),
      forge({ a: 'yesterday' }),
      forge({ v: 2 }),
      'garbage',
      '',
      42,
      'x'.repeat(600),
    ]) {
      refused(() => decodeCursor(bad, ORG_A, 'contacts', filter), 'cursor');
    }
  });

  it('takes a page size within each list’s bounds', () => {
    expect(pageLimit('contacts', undefined)).toBe(50);
    expect(pageLimit('contacts', '200')).toBe(200);
    expect(pageLimit('opportunities', 500)).toBe(500);
    for (const bad of [0, '0', 201, '201', 2.5, '2.5', 'ten', -1]) {
      refused(() => pageLimit('contacts', bad), 'limit');
    }
  });
});
