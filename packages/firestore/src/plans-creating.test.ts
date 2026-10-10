import type { IsoTimestamp, OrganizationId, Plan, PlanId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { FirestorePlanRepository, PLANS, toPlanDocument } from './plans.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * The store's query for the permission sweep, read on the emulator (ADR-0187, decision 6): the plans
 * whose delegation is `creating` are found by that state alone, in id order, across organizations,
 * a page at a time. The emulator does not enforce indexes, so DEV's first sweep is the check that
 * the same query runs there without a composite one.
 */
const AT = '2026-10-10T12:00:00.000Z' as IsoTimestamp;
const USER = '11111111-1111-4111-8111-111111111111' as UserId;
const ORG_A = '22222222-2222-4222-8222-222222222222' as OrganizationId;
const ORG_B = '33333333-3333-4333-8333-333333333333' as OrganizationId;

/** A plan id ordered by its number, as the store orders documents. */
const idOf = (n: number): PlanId =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as PlanId;

/** A plan as the store reads it: only the fields the query and its reader use. */
function planOf(n: number, organizationId: OrganizationId, delegationState?: string): Plan {
  return {
    id: idOf(n),
    organizationId,
    executionId: idOf(n),
    // `ready` needs no decision: an approved plan must carry one, and the reader checks it.
    status: 'ready',
    version: 1,
    delegations: [],
    ...(delegationState === undefined ? {} : { delegationState }),
    revision: 1,
    createdAt: AT,
    createdBy: USER,
    updatedAt: AT,
  } as unknown as Plan;
}

describe.runIf(emulatorHost)('FirestorePlanRepository.creatingPage (emulator)', () => {
  // Creating: 1, 3, 5, 7, 9 (two organizations). Settled or never delegated: 2, 4, 6, 8.
  const seed = async (db: ReturnType<typeof emulatorFirestore>) => {
    const plans = [
      planOf(1, ORG_A, 'creating'),
      planOf(2, ORG_A, 'created'),
      planOf(3, ORG_B, 'creating'),
      planOf(4, ORG_B, 'failed'),
      planOf(5, ORG_A, 'creating'),
      planOf(6, ORG_A),
      planOf(7, ORG_B, 'creating'),
      planOf(8, ORG_B, 'completed'),
      planOf(9, ORG_A, 'creating'),
    ];
    for (const plan of plans) await db.collection(PLANS).doc(plan.id).set(toPlanDocument(plan));
  };

  it('lists only the plans whose delegation is creating, across organizations, in id order', async () => {
    const db = emulatorFirestore();
    await seed(db);
    const page = await new FirestorePlanRepository(db).creatingPage({ limit: 10 });
    expect(page.plans.map((p) => p.id)).toEqual([idOf(1), idOf(3), idOf(5), idOf(7), idOf(9)]);
    expect(page.plans.map((p) => p.organizationId)).toEqual([ORG_A, ORG_B, ORG_A, ORG_B, ORG_A]);
    // Fewer than a full page: nothing comes after it.
    expect(page.next).toBeUndefined();
  });

  it('pages by id from the last id of the previous page, and reaches every plan once', async () => {
    const db = emulatorFirestore();
    await seed(db);
    const repository = new FirestorePlanRepository(db);
    // The page after `after`, or the first one when there is no cursor yet.
    const pageAfter = (after: PlanId | undefined) =>
      repository.creatingPage(after === undefined ? { limit: 2 } : { limit: 2, after });
    const first = await pageAfter(undefined);
    expect(first.plans.map((p) => p.id)).toEqual([idOf(1), idOf(3)]);
    expect(first.next).toBe(idOf(3));
    const second = await pageAfter(first.next);
    expect(second.plans.map((p) => p.id)).toEqual([idOf(5), idOf(7)]);
    expect(second.next).toBe(idOf(7));
    const third = await pageAfter(second.next);
    expect(third.plans.map((p) => p.id)).toEqual([idOf(9)]);
    // A page that is not full ends the walk.
    expect(third.next).toBeUndefined();
  });

  it('a record that does not read as a plan is skipped, and the rest of its page is still read', async () => {
    const db = emulatorFirestore();
    await seed(db);
    // Creating, but with no organization: it cannot be a plan, so it is never released.
    await db
      .collection(PLANS)
      .doc(idOf(10))
      .set({ delegationState: 'creating', status: 'approved' });
    const page = await new FirestorePlanRepository(db).creatingPage({ limit: 10 });
    expect(page.plans.map((p) => p.id)).toEqual([idOf(1), idOf(3), idOf(5), idOf(7), idOf(9)]);
  });
});
