import type { ExecutionService } from '@melonoffice/execution';
import { executionIdFor } from '@melonoffice/execution';
import type { Plan } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { createDelegation, delegationKey, type Delegation } from './delegation.js';
import { isPlanningError } from './errors.js';
import type { PlanRepository } from './repository.js';
import { ALICE, must, proposal, specialistStep, toolStep, world } from './testkit.js';

/**
 * Delegation recovery (ADR-0028): a delegation that fails at any point is resumed by delegating
 * again, and concurrent attempts converge. Whatever happens, one plan gets one delegation set
 * and one child per specialist step, never two.
 */

class Injected extends Error {}

/** Where a fault can be injected: the operation and which call of it (1-based). */
interface Fault {
  readonly op: 'create' | 'addNodes' | 'running' | 'planUpdate';
  readonly call: number;
}

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isPlanningError(error)) return error.code;
    if (error instanceof Injected) return 'injected';
    throw error;
  }
  return 'accepted';
};

async function setup() {
  const w = await world();
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, { toolIds: ['lookup'] });
  const marketer = await w.seed(w.orgA, ALICE, { type: 'marketing', role: 'campaign_manager' });
  const analyst = await w.seed(w.orgA, ALICE, { type: 'finance', role: 'financial_analyst' });
  const execution = await w.planning(w.tenantA, owner);
  const outcome = await w.plans.propose(w.tenantA, {
    executionId: execution.id,
    proposal: proposal([
      specialistStep('research', researcher),
      toolStep('search', 'research', 'lookup'),
      specialistStep('campaign', marketer, { dependsOn: ['research'] }),
      specialistStep('budget', analyst, { dependsOn: ['research'] }),
    ]),
    source: {
      kind: 'planner',
      model: { provider: 'alpha', id: 'alpha-large', version: 'v' },
      policy: { id: 'default_model', version: 1 },
    },
  });
  if (outcome.status !== 'planned') throw new Error(`refused: ${outcome.reason}`);
  const plan = outcome.plan;
  const expectedIds = ['research', 'campaign', 'budget'].map((step) =>
    executionIdFor(w.orgA, delegationKey(plan.id, step)),
  );

  /** A delegation whose dependencies fail once, at `fault`. */
  function faulty(fault: Fault): Delegation {
    const counts = new Map<Fault['op'], number>();
    const hit = (op: Fault['op']) => {
      const n = (counts.get(op) ?? 0) + 1;
      counts.set(op, n);
      if (fault.op === op && fault.call === n) throw new Injected(op);
    };
    const executions: Pick<ExecutionService, 'get' | 'create' | 'addNodes' | 'changeStatus'> = {
      get: (tenant, id) => w.executions.get(tenant, id),
      create: async (tenant, request) => {
        hit('create');
        return w.executions.create(tenant, request);
      },
      addNodes: async (tenant, id, nodes) => {
        hit('addNodes');
        return w.executions.addNodes(tenant, id, nodes);
      },
      changeStatus: async (tenant, id, change) => {
        if (change.to === 'running') hit('running');
        return w.executions.changeStatus(tenant, id, change);
      },
    };
    const plans: PlanRepository = {
      find: (org, id) => w.planRepository.find(org, id),
      findVersion: (org, id, v) => w.planRepository.findVersion(org, id, v),
      list: (org, limit) => w.planRepository.list(org, limit),
      page: (org, request) => w.planRepository.page(org, request),
      create: (write) => w.planRepository.create(write),
      update: async (org, id, change) => {
        hit('planUpdate');
        return w.planRepository.update(org, id, change);
      },
    };
    return createDelegation({
      plans,
      executions,
      specialists: w.specialists,
      organizations: w.tenancy,
      authorization: w.authorization,
    });
  }

  const stored = async (): Promise<Plan> => must(await w.planRepository.find(w.orgA, plan.id));
  /** Every execution ever created for this organization, by its audit record. */
  const created = () => w.events('execution.created').map((e) => e.target?.id);
  const children = () => created().filter((id) => id !== execution.id);

  /** The one consistent end state, whatever happened before. */
  async function expectDelegated(): Promise<void> {
    const p = await stored();
    expect(p.status).toBe('executing');
    expect(p.delegationState).toBe('completed');
    expect(p.delegations).toEqual([
      { stepId: 'research', executionId: expectedIds[0] },
      { stepId: 'campaign', executionId: expectedIds[1] },
      { stepId: 'budget', executionId: expectedIds[2] },
    ]);
    // One child per specialist step: created once each, never twice.
    expect(children().sort()).toEqual([...expectedIds].sort());
    for (const id of expectedIds) {
      const child = await w.executions.get(w.tenantA, must(id));
      expect(child.status).toBe('pending');
      expect(child.parentExecutionId).toBe(execution.id);
    }
    const parent = await w.executions.get(w.tenantA, execution.id);
    expect(parent.status).toBe('running');
    expect(parent.nodes.map((n) => n.id)).toEqual(['research', 'campaign', 'budget']);
    // Recorded once, by the attempt that made the plan `executing`.
    expect(w.events('delegation.created').map((e) => e.target?.id)).toEqual(expectedIds);
    expect(w.events('plan.state_changed')).toEqual([
      expect.objectContaining({ transition: { from: 'ready', to: 'executing' } }),
    ]);
  }

  return {
    ...w,
    plan,
    execution,
    marketer,
    expectedIds,
    faulty,
    stored,
    children,
    expectDelegated,
  };
}

describe('delegation identity', () => {
  it('names each child by organization, plan and step, deterministically', async () => {
    const w = await setup();
    expect(new Set(w.expectedIds).size).toBe(3);
    expect(executionIdFor(w.orgA, delegationKey(w.plan.id, 'research'))).toBe(w.expectedIds[0]);
    expect(executionIdFor(w.orgB, delegationKey(w.plan.id, 'research'))).not.toBe(w.expectedIds[0]);
    const { children } = await w.delegation.delegate(w.tenantA, w.plan.id);
    expect(children.map((c) => c.id)).toEqual(w.expectedIds);
  });
});

describe('delegation recovery', () => {
  it('failure before the first child: the claim is recorded, nothing is created, a retry finishes', async () => {
    const w = await setup();
    expect(await codeOf(w.faulty({ op: 'create', call: 1 }).delegate(w.tenantA, w.plan.id))).toBe(
      'injected',
    );
    const p = await w.stored();
    expect(p.delegationState).toBe('creating');
    expect(p.status).toBe('ready');
    expect(p.delegations.map((d) => d.executionId)).toEqual(w.expectedIds);
    expect(w.children()).toEqual([]);
    expect(w.events('delegation.created')).toHaveLength(0);
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('failure after the first child: the retry reuses it and creates the rest', async () => {
    const w = await setup();
    expect(await codeOf(w.faulty({ op: 'create', call: 2 }).delegate(w.tenantA, w.plan.id))).toBe(
      'injected',
    );
    expect(w.children()).toEqual([w.expectedIds[0]]);
    expect((await w.stored()).delegationState).toBe('creating');
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('failure after every child but before the plan update: the retry creates nothing new', async () => {
    const w = await setup();
    // Plan update 1 is the claim; 2 marks the plan `executing`.
    expect(
      await codeOf(w.faulty({ op: 'planUpdate', call: 2 }).delegate(w.tenantA, w.plan.id)),
    ).toBe('injected');
    expect(w.children().sort()).toEqual([...w.expectedIds].sort());
    const p = await w.stored();
    expect(p.delegationState).toBe('creating');
    expect(p.status).toBe('ready');
    expect(w.events('delegation.created')).toHaveLength(0);
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('failure after the plan update but before the parent status: the retry only moves the parent', async () => {
    const w = await setup();
    expect(await codeOf(w.faulty({ op: 'running', call: 1 }).delegate(w.tenantA, w.plan.id))).toBe(
      'injected',
    );
    const p = await w.stored();
    expect(p.delegationState).toBe('created');
    expect(p.status).toBe('executing');
    expect((await w.executions.get(w.tenantA, w.execution.id)).status).toBe('planning');
    expect(w.events('delegation.created')).toHaveLength(3);
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('failure after the parent status but before completion: the retry only completes', async () => {
    const w = await setup();
    expect(
      await codeOf(w.faulty({ op: 'planUpdate', call: 3 }).delegate(w.tenantA, w.plan.id)),
    ).toBe('injected');
    expect((await w.stored()).delegationState).toBe('created');
    expect((await w.executions.get(w.tenantA, w.execution.id)).status).toBe('running');
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('failure while adding the plan graph: the retry adds it once', async () => {
    const w = await setup();
    expect(await codeOf(w.faulty({ op: 'addNodes', call: 1 }).delegate(w.tenantA, w.plan.id))).toBe(
      'injected',
    );
    expect((await w.executions.get(w.tenantA, w.execution.id)).nodes).toHaveLength(0);
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('survives a failure at every point in turn, retried each time until done', async () => {
    const w = await setup();
    const faults: Fault[] = [
      { op: 'planUpdate', call: 1 },
      { op: 'addNodes', call: 1 },
      { op: 'create', call: 1 },
      { op: 'create', call: 2 },
      { op: 'create', call: 1 },
      { op: 'planUpdate', call: 2 },
      { op: 'running', call: 1 },
      { op: 'planUpdate', call: 1 },
    ];
    for (const fault of faults) {
      expect(await codeOf(w.faulty(fault).delegate(w.tenantA, w.plan.id))).toMatch(
        /^(injected|accepted)$/,
      );
    }
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });

  it('delegating a completed delegation again changes nothing', async () => {
    const w = await setup();
    const first = await w.delegation.delegate(w.tenantA, w.plan.id);
    const second = await w.delegation.delegate(w.tenantA, w.plan.id);
    expect(second.children.map((c) => c.id)).toEqual(first.children.map((c) => c.id));
    expect(second.plan.revision).toBe(first.plan.revision);
    await w.expectDelegated();
  });

  it('a delegation being created cannot be cancelled half-way', async () => {
    const w = await setup();
    await codeOf(w.faulty({ op: 'create', call: 2 }).delegate(w.tenantA, w.plan.id));
    expect(await codeOf(w.plans.cancel(w.tenantA, w.plan.id, 'user_cancelled'))).toBe(
      'delegation_in_progress',
    );
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });
});

describe('delegation concurrency', () => {
  it('concurrent attempts converge on one delegation set and one child per step', async () => {
    const w = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => w.delegation.delegate(w.tenantA, w.plan.id)),
    );
    for (const r of results) expect(r.children.map((c) => c.id)).toEqual(w.expectedIds);
    await w.expectDelegated();
  });

  it('concurrent retries of a half-made delegation converge too', async () => {
    const w = await setup();
    await codeOf(w.faulty({ op: 'create', call: 2 }).delegate(w.tenantA, w.plan.id));
    await Promise.all(Array.from({ length: 4 }, () => w.delegation.delegate(w.tenantA, w.plan.id)));
    await w.expectDelegated();
  });

  it('a child that the store already holds is reused, never created twice', async () => {
    const w = await setup();
    await codeOf(w.faulty({ op: 'create', call: 3 }).delegate(w.tenantA, w.plan.id));
    const before = w.children();
    expect(before).toHaveLength(2);
    // The store itself refuses a second child with the same id.
    const first = await w.executions.get(w.tenantA, must(w.expectedIds[0]));
    await expect(
      w.executions.create(w.tenantA, {
        mode: 'execute',
        input: first.input,
        versionSnapshot: first.versionSnapshot,
        parentExecutionId: w.execution.id,
        specialistId: first.specialistId as string,
        specialistVersion: first.specialistVersion as number,
        departmentId: first.departmentId as string,
        idempotencyKey: delegationKey(w.plan.id, 'research'),
      }),
    ).rejects.toThrow();
    await w.delegation.delegate(w.tenantA, w.plan.id);
    await w.expectDelegated();
  });
});

describe('delegation failure', () => {
  it('fails the plan and cancels the children made when a specialist stops being eligible mid-way', async () => {
    const w = await setup();
    await codeOf(w.faulty({ op: 'create', call: 2 }).delegate(w.tenantA, w.plan.id));
    await w.pause(w.orgA, w.marketer);
    expect(await codeOf(w.delegation.delegate(w.tenantA, w.plan.id))).toBe('delegation_failed');
    const p = await w.stored();
    expect(p.status).toBe('failed');
    expect(p.delegationState).toBe('failed');
    expect(p.delegationFailure).toBe('specialist_not_eligible');
    const first = await w.executions.get(w.tenantA, must(w.expectedIds[0]));
    expect(first.status).toBe('cancelled');
    expect(first.cancellation?.reason).toBe('delegation_failed');
    expect((await w.executions.get(w.tenantA, w.execution.id)).status).toBe('failed');
    expect(w.events('plan.state_changed')).toEqual([
      expect.objectContaining({
        transition: { from: 'ready', to: 'failed' },
        reason: 'specialist_not_eligible',
      }),
    ]);
    // Final: delegating again creates nothing and says the same.
    expect(await codeOf(w.delegation.delegate(w.tenantA, w.plan.id))).toBe('delegation_failed');
    expect(w.children()).toEqual([w.expectedIds[0]]);
    expect(w.events('delegation.created')).toHaveLength(0);
  });

  it('refuses another organization at every state', async () => {
    const w = await setup();
    await codeOf(w.faulty({ op: 'create', call: 2 }).delegate(w.tenantA, w.plan.id));
    expect(await codeOf(w.delegation.delegate(w.tenantB, w.plan.id))).toBe('plan_not_found');
    expect(w.children()).toEqual([w.expectedIds[0]]);
  });
});

describe('X6a: cooperative cancellation (ADR-0029)', () => {
  it('12. cancelling the planning execution cancels the plan and every child it delegated', async () => {
    const w = await setup();
    const { children } = await w.delegation.delegate(w.tenantA, w.plan.id);
    // One child already started by its owner, the others still pending.
    await w.executions.start(w.tenantA, must(children[0]).id);
    const cancelled = await w.executions.cancel(w.tenantA, w.execution.id, 'director_request');
    expect(cancelled.status).toBe('cancelled');
    for (const child of children) {
      const now = await w.executions.get(w.tenantA, child.id);
      expect(now.status).toBe('cancelled');
      expect(now.cancellation).toMatchObject({ by: ALICE, reason: 'parent_cancelled' });
    }
    expect((await w.stored()).status).toBe('cancelled');
    expect(w.events('plan.state_changed').at(-1)).toMatchObject({
      transition: { from: 'executing', to: 'cancelled' },
      reason: 'director_request',
    });
    const cascaded = w
      .events('execution.state_changed')
      .filter((e) => e.reason === 'parent_cancelled')
      .map((e) => e.target?.id);
    expect(cascaded.sort()).toEqual([...w.expectedIds].sort());
    // Nothing of it starts again, and cancelling twice changes nothing.
    for (const child of children) {
      await expect(w.executions.start(w.tenantA, child.id)).rejects.toMatchObject({
        code: 'execution_already_terminal',
      });
    }
    const before = w.events('execution.state_changed').length;
    await w.executions.cancel(w.tenantA, w.execution.id, 'director_request');
    expect(w.events('execution.state_changed')).toHaveLength(before);
  });

  it('a delegation cancelled half-way makes nothing more, and what it made stays cancelled', async () => {
    const w = await setup();
    // The delegation stops after its first child, then the owner cancels the planning execution:
    // the child that exists is cancelled; the ones not made yet have nothing to cancel.
    expect(await codeOf(w.faulty({ op: 'create', call: 2 }).delegate(w.tenantA, w.plan.id))).toBe(
      'injected',
    );
    expect(w.children()).toHaveLength(1);
    await w.executions.cancel(w.tenantA, w.execution.id, 'director_request');
    const first = must(w.expectedIds[0]);
    expect((await w.executions.get(w.tenantA, first)).status).toBe('cancelled');
    // Delegating again cannot go on under a cancelled parent: no child is added.
    expect(await codeOf(w.delegation.delegate(w.tenantA, w.plan.id))).not.toBe('accepted');
    expect(w.children()).toEqual([first]);
    expect((await w.stored()).delegationState).not.toBe('completed');
  });
});
