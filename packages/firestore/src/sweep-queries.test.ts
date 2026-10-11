import type { IsoTimestamp } from '@melonoffice/domain';
import { FieldPath, type Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { FirestorePlanRepository, PLANS } from './plans.js';
import { FirestoreWorkflowScheduleRepository } from './workflow-schedules.js';

/**
 * The sweeps' queries, checked by their shape (ADR-0187, decisions 5, 6, 8 and 9). The emulator does not
 * enforce indexes, so it cannot show that a query needs a composite one. Each sweep query has one equality
 * and the document id as its order, which the automatic single-field index serves. A change that adds a
 * filter or another order fails here, before DEV's first sweep does.
 */

interface RecordedQuery {
  readonly collection: string;
  readonly where: unknown[][];
  readonly orderBy: unknown[][];
}

interface QueryBuilder {
  where(...args: unknown[]): QueryBuilder;
  orderBy(...args: unknown[]): QueryBuilder;
  startAfter(...args: unknown[]): QueryBuilder;
  limit(count: number): QueryBuilder;
  get(): Promise<{ readonly docs: readonly unknown[]; readonly size: number }>;
}

/** A stand-in for the database: it records each query it is asked, and every query returns no document. */
function recordingDatabase(queries: RecordedQuery[]): Firestore {
  const database = {
    collection(name: string): QueryBuilder {
      const recorded: RecordedQuery = { collection: name, where: [], orderBy: [] };
      queries.push(recorded);
      const builder: QueryBuilder = {
        where: (...args) => {
          recorded.where.push(args);
          return builder;
        },
        orderBy: (...args) => {
          recorded.orderBy.push(args);
          return builder;
        },
        startAfter: () => builder,
        limit: () => builder,
        get: async () => ({ docs: [], size: 0 }),
      };
      return builder;
    },
  };
  return database as unknown as Firestore;
}

describe('The sweeps’ queries have one equality and the document id as their order (ADR-0187)', () => {
  it('the plans a sweep reads are one equality on the delegation state or its failure, in id order', async () => {
    const queries: RecordedQuery[] = [];
    const repository = new FirestorePlanRepository(recordingDatabase(queries));
    await repository.creatingPage({ limit: 50 });
    await repository.abandonedPage({ limit: 50 });
    expect(queries.map((query) => query.collection)).toEqual([PLANS, PLANS]);
    expect(queries.map((query) => query.where)).toEqual([
      [['delegationState', '==', 'creating']],
      [['delegationFailure', '==', 'delegation_abandoned']],
    ]);
    expect(queries.map((query) => query.orderBy)).toEqual([
      [[FieldPath.documentId()]],
      [[FieldPath.documentId()]],
    ]);
  });

  it('the schedules a sweep reads are one equality on the last claim, in id order', async () => {
    const queries: RecordedQuery[] = [];
    const repository = new FirestoreWorkflowScheduleRepository(recordingDatabase(queries));
    await repository.lapsedOff('2026-10-10T12:00:00.000Z' as IsoTimestamp, 50);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.where).toEqual([['last.outcome', '==', 'claimed']]);
    expect(queries[0]?.orderBy).toEqual([[FieldPath.documentId()]]);
  });
});
