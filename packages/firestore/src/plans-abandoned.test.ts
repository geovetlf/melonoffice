import type { IsoTimestamp, OrganizationId, Plan, PlanId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { FirestorePlanRepository, PLANS, toPlanDocument } from './plans.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * The store's query for the recovery of abandoned plans, read on the emulator (ADR-0187, decision 8): the
 * plans the runtime abandoned are found by their failure alone, in id order, across organizations, a page
 * at a time. The emulator does not enforce indexes, so DEV's first sweep is the check that the same query
 * runs there without a composite one.
 */
const AT = '2026-10-10T12:00:00.000Z' as IsoTimestamp;
const USER = '11111111-1111-4111-8111-111111111111' as UserId;
const ORG_A = '22222222-2222-4222-8222-222222222222' as OrganizationId;
const ORG_B = '33333333-3333-4333-8333-333333333333' as OrganizationId;

/** A plan id ordered by its number, as the store orders documents. */
const idOf = (n: number): PlanId =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as PlanId;

/** A plan as the store reads it: only the fields the query and its reader use. */
function planOf(
  n: number,
  organizationId: OrganizationId,
  delegation: { readonly state?: string; readonly failure?: string } = {},
): Plan {
  return {
    id: idOf(n),
    organizationId,
    executionId: idOf(n),
    // A failed delegation's plan is `failed`, and a `ready` one needs no decision: the reader checks both.
    status: delegation.state === 'failed' ? 'failed' : 'ready',
    version: 1,
    delegations: [],
    ...(delegation.state === undefined ? {} : { delegationState: delegation.state }),
    ...(delegation.failure === undefined ? {} : { delegationFailure: delegation.failure }),
    revision: 1,
    createdAt: AT,
    createdBy: USER,
    updatedAt: AT,
  } as unknown as Plan;
}

describe.runIf(emulatorHost)('FirestorePlanRepository.abandonedPage (emulator)', () => {
  const abandoned = { state: 'failed', failure: 'delegation_abandoned' };
  // Abandoned by the runtime: 1, 3, 5, 7, 9 (two organizations). Any other delegation: 2, 4, 6, 8.
  const seed = async (db: ReturnType<typeof emulatorFirestore>) => {
    const plans = [
      planOf(1, ORG_A, abandoned),
      planOf(2, ORG_A, { state: 'failed', failure: 'delegation_conflict' }),
      planOf(3, ORG_B, abandoned),
      planOf(4, ORG_B, { state: 'creating' }),
      planOf(5, ORG_A, abandoned),
      planOf(6, ORG_A),
      planOf(7, ORG_B, abandoned),
      planOf(8, ORG_B, { state: 'completed' }),
      planOf(9, ORG_A, abandoned),
    ];
    for (const plan of plans) await db.collection(PLANS).doc(plan.id).set(toPlanDocument(plan));
  };

  it('lists only the plans the runtime abandoned, across organizations, in id order', async () => {
    const db = emulatorFirestore();
    await seed(db);
    const page = await new FirestorePlanRepository(db).abandonedPage({ limit: 10 });
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
      repository.abandonedPage(after === undefined ? { limit: 2 } : { limit: 2, after });
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
    // Abandoned, but with no organization: it cannot be a plan, so the sweep never closes anything for it.
    await db.collection(PLANS).doc(idOf(10)).set({
      delegationState: 'failed',
      delegationFailure: 'delegation_abandoned',
      status: 'failed',
    });
    const page = await new FirestorePlanRepository(db).abandonedPage({ limit: 10 });
    expect(page.plans.map((p) => p.id)).toEqual([idOf(1), idOf(3), idOf(5), idOf(7), idOf(9)]);
  });
});
