import { openWallet } from '@melonoffice/credits';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type {
  ExecutionId,
  InitialBilling,
  Organization,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { ExecutionError } from './errors.js';
import { InMemoryExecutionRepository } from './repository.js';
import { createExecutionService, type ExecutionRequest } from './service.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
/** Tenancy needs billing to create an organization; executions never read it. */
const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const REQUEST: ExecutionRequest = {
  mode: 'execute',
  input: { type: 'task', id: 'task-1' },
  versionSnapshot: { schemaVersion: 1, components: [{ kind: 'role', id: 'r1', version: '1' }] },
  nodes: [{ id: 'work', type: 'agent', label: 'Work' }],
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExecutionError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function world(roles?: Record<string, readonly string[]>) {
  const audit = new InMemoryAuditStore();
  const repository = new InMemoryExecutionRepository(audit);
  const tenancy = new InMemoryTenancyStore(() => NOW);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const service = createExecutionService({
    repository,
    organizations: tenancy,
    authorization: createAuthorizationService(roles as never),
    audit: createAuditService(audit, () => NOW),
    now: () => NOW,
    requestId: 'req-1',
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const giaA = await resolveTenant(actAsGia(as(ALICE)), a.organization.id, tenancy);
  const runtimeA = await resolveRuntimeTenant(ALICE, a.organization.id, tenancy);
  const events = () => audit.events().filter((e) => e.action.startsWith('execution.'));
  return {
    audit,
    repository,
    tenancy,
    service,
    a,
    b,
    tenantA,
    tenantB,
    giaA,
    runtimeA,
    events,
  };
}

describe('execution service', () => {
  it('creates an execution for the tenant organization and user, and audits it', async () => {
    const { service, tenantA, a, events } = await world();
    const execution = await service.create(tenantA, REQUEST);
    expect(execution).toMatchObject({
      organizationId: a.organization.id,
      userId: ALICE,
      status: 'pending',
      requestId: 'req-1',
    });
    expect(await service.get(tenantA, execution.id)).toEqual(execution);
    expect(events()).toEqual([
      expect.objectContaining({
        action: 'execution.created',
        result: 'success',
        actor: { type: 'user', userId: ALICE, via: 'direct' },
        organizationId: a.organization.id,
        target: { type: 'execution', id: execution.id },
        requestId: 'req-1',
      }),
    ]);
  });

  it('ignores any organization, user or status the request carries', async () => {
    const { service, tenantA, tenantB } = await world();
    const execution = await service.create(tenantA, {
      ...REQUEST,
      organizationId: tenantB.organizationId,
      userId: BOB,
      status: 'completed',
      revision: 99,
    } as never);
    expect(execution).toMatchObject({
      organizationId: tenantA.organizationId,
      userId: ALICE,
      status: 'pending',
      revision: 1,
    });
  });

  it('audits every status change with from, to and the cause, never payloads', async () => {
    const { service, tenantA, runtimeA, events } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.start(tenantA, id);
    await service.runtimeChangeStatus(runtimeA, id, {
      from: 'running',
      to: 'failed',
      failure: { code: 'provider_timeout' },
    });
    const changes = events().filter((e) => e.action === 'execution.state_changed');
    expect(changes.map((e) => [e.transition, e.reason])).toEqual([
      [{ from: 'pending', to: 'running' }, 'user_started'],
      [{ from: 'running', to: 'failed' }, 'provider_timeout'],
    ]);
    for (const event of events()) {
      expect(event.target).toEqual({ type: 'execution', id });
      expect(JSON.stringify(event)).not.toMatch(/task-1|input|nodes|token|authorization/i);
    }
  });

  it('does not audit adding nodes, which lives in the execution; audits every node change (ADR-0031)', async () => {
    const { service, tenantA, runtimeA, events } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.addNodes(tenantA, id, [
      { id: 'check', type: 'verification', label: 'Check', dependsOn: ['work'] },
    ]);
    expect(events()).toHaveLength(1);
    await service.start(tenantA, id);
    const moved = await service.runtimeChangeNode(runtimeA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    expect(moved.currentNodeId).toBe('work');
    expect(moved.revision).toBe(4);
    expect(events().at(-1)).toMatchObject({
      action: 'execution.node_changed',
      result: 'success',
      actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
      organizationId: tenantA.organizationId,
      target: { type: 'execution', id },
      nodeId: 'work',
      transition: { from: 'pending', to: 'running' },
      requestId: 'req-1',
    });
  });

  it('records a cancellation with who and why, and refuses everything after it', async () => {
    const { service, tenantA, runtimeA, events } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.start(tenantA, id);
    const cancelled = await service.cancel(tenantA, id, 'director_request');
    expect(cancelled.cancellation).toEqual({
      at: NOW.toISOString(),
      by: ALICE,
      reason: 'director_request',
    });
    expect(cancelled.nodes[0]?.status).toBe('cancelled');
    expect(events().at(-1)).toMatchObject({
      transition: { from: 'running', to: 'cancelled' },
      reason: 'director_request',
    });
    for (const to of ['running', 'retrying', 'verifying', 'completed'] as const) {
      expect(
        await codeOf(service.runtimeChangeStatus(runtimeA, id, { from: 'cancelled', to })),
      ).toBe('execution_already_terminal');
    }
    expect(
      await codeOf(
        service.runtimeChangeNode(runtimeA, id, {
          nodeId: 'work',
          from: 'cancelled',
          to: 'running',
        }),
      ),
    ).toBe('execution_already_terminal');
    expect((await service.get(tenantA, id)).status).toBe('cancelled');
  });
});

describe('concurrency', () => {
  it('never lets a change overwrite a concurrent cancellation', async () => {
    const { service, tenantA, runtimeA } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.start(tenantA, id);
    await service.runtimeChangeNode(runtimeA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    await service.runtimeChangeNode(runtimeA, id, {
      nodeId: 'work',
      from: 'running',
      to: 'completed',
    });
    const results = await Promise.all([
      codeOf(service.runtimeChangeStatus(runtimeA, id, { from: 'running', to: 'verifying' })),
      codeOf(service.cancel(tenantA, id, 'director_request')),
    ]);
    // The person's cancellation always wins (ADR-0029): it re-reads and cancels whatever state it
    // finds, while the runtime's change is refused once it finds the execution cancelled.
    expect(results[1]).toBe('accepted');
    expect(['accepted', 'execution_concurrency_conflict', 'execution_already_terminal']).toContain(
      results[0],
    );
    const final = await service.get(tenantA, id);
    expect(final.status).toBe('cancelled');
    expect(final.cancellation?.by).toBe(ALICE);
  });

  it('refuses a write built on an older revision', async () => {
    const { repository, service, tenantA } = await world();
    const execution = await service.create(tenantA, REQUEST);
    await service.start(tenantA, execution.id);
    await expect(
      repository.update(tenantA.organizationId, execution.id, () => ({
        execution: { ...execution, status: 'planning', revision: 2 },
        events: [],
      })),
    ).rejects.toMatchObject({ code: 'execution_concurrency_conflict' });
    expect((await service.get(tenantA, execution.id)).status).toBe('running');
  });
});

describe('atomicity', () => {
  it('stores nothing when its audit event cannot be stored', async () => {
    const { audit, repository, service, tenantA } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    const original = audit.appendNow.bind(audit);
    audit.appendNow = () => {
      throw new Error('audit unavailable');
    };
    await expect(service.start(tenantA, id)).rejects.toThrow('audit unavailable');
    await expect(service.create(tenantA, REQUEST)).rejects.toThrow('audit unavailable');
    audit.appendNow = original;
    const stored = await repository.find(tenantA.organizationId, id);
    expect(stored).toMatchObject({ status: 'pending', revision: 1 });
  });
});

describe('tenancy', () => {
  it("answers another organization's execution exactly like a missing one", async () => {
    const { service, tenantA, tenantB } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    for (const target of [id, '99999999-9999-4999-8999-999999999999', 'not-an-id', '']) {
      expect(await codeOf(service.get(tenantB, target))).toBe('execution_not_found');
    }
    expect(
      await codeOf(service.changeStatus(tenantB, id, { from: 'pending', to: 'running' })),
    ).toBe('execution_not_found');
    expect((await service.get(tenantA, id)).status).toBe('pending');
  });

  it('refuses a context that was not resolved by tenancy', async () => {
    const { service, tenantA, tenantB } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    const forged = { ...tenantB, organizationId: tenantA.organizationId } as TenantContext;
    expect(await codeOf(service.get(forged, id))).toBe('unresolved_tenant');
    expect(await codeOf(service.create(forged, REQUEST))).toBe('unresolved_tenant');
  });

  it('refuses an organization suspended after the tenant was resolved', async () => {
    const { service, tenancy, tenantA, a } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    tenancy.put({ ...a.organization, status: 'suspended' });
    expect(await codeOf(service.get(tenantA, id))).toBe('organization_inactive');
    expect(
      await codeOf(service.changeStatus(tenantA, id, { from: 'pending', to: 'running' })),
    ).toBe('organization_inactive');
  });

  it('refuses a stored record that is not valid', async () => {
    const { repository, service, tenantA } = await world();
    const execution = await service.create(tenantA, REQUEST);
    repository.put({ ...execution, id: execution.id as ExecutionId, status: 'bogus' } as never);
    await expect(
      service.changeStatus(tenantA, execution.id, { from: 'bogus', to: 'running' } as never),
    ).rejects.toThrow();
  });

  it('gives GIA exactly what the user gets, recorded as via GIA', async () => {
    const { service, tenancy, tenantA, a, events } = await world();
    const gia = await resolveTenant(actAsGia(as(ALICE)), a.organization.id, tenancy);
    const { id } = await service.create(gia, REQUEST);
    expect(await service.get(tenantA, id)).toEqual(await service.get(gia, id));
    expect(events().at(-1)?.actor).toEqual({ type: 'user', userId: ALICE, via: 'gia' });
  });
});

/** Runs the only node of REQUEST to completion, as the runtime would. */
async function finishWork(w: Awaited<ReturnType<typeof world>>, id: string) {
  await w.service.runtimeChangeNode(w.runtimeA, id, {
    nodeId: 'work',
    from: 'pending',
    to: 'running',
  });
  await w.service.runtimeChangeNode(w.runtimeA, id, {
    nodeId: 'work',
    from: 'running',
    to: 'completed',
  });
}

const EVIDENCE = { type: 'check', id: 'evidence-1' };
const passing = (nodeId = 'work') => ({
  correlationId: 'req-verify-1',
  nodes: [
    {
      nodeId,
      policy: 'output_schema',
      checks: [{ code: 'schema_valid', result: 'passed', evidence: EVIDENCE }],
    },
  ],
});

describe('X6a: start (ADR-0029)', () => {
  it('5. the owner, acting directly, starts a pending execution, and it is audited', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    const started = await w.service.start(w.tenantA, id);
    expect(started).toMatchObject({ status: 'running', startedAt: NOW.toISOString() });
    expect(w.events().at(-1)).toMatchObject({
      action: 'execution.state_changed',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      transition: { from: 'pending', to: 'running' },
      reason: 'user_started',
    });
  });

  it('6. a user without execution.start, GIA and the runtime cannot start', async () => {
    const w = await world({ owner: ROLES.owner.filter((p) => p !== 'execution.start') });
    const { id } = await w.service.create(w.tenantA, REQUEST);
    expect(await codeOf(w.service.start(w.tenantA, id))).toBe('permission_denied');
    const full = await world();
    const other = await full.service.create(full.tenantA, REQUEST);
    expect(await codeOf(full.service.start(full.giaA, other.id))).toBe('actor_not_allowed');
    expect(await codeOf(full.service.start(full.runtimeA, other.id))).toBe('actor_not_allowed');
    expect(w.events().filter((e) => e.action === 'execution.start_denied')).toEqual([
      expect.objectContaining({ result: 'denied', reason: 'permission_denied' }),
    ]);
    expect(
      full
        .events()
        .filter((e) => e.action === 'execution.start_denied')
        .map((e) => e.reason),
    ).toEqual(['gia_cannot_start', 'runtime_cannot_start']);
    expect((await w.service.get(w.tenantA, id)).status).toBe('pending');
    expect((await full.service.get(full.tenantA, other.id)).status).toBe('pending');
  });

  it("7. a forged organization never starts another organization's execution", async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    const forged = { ...w.tenantB, organizationId: w.tenantA.organizationId } as TenantContext;
    expect(await codeOf(w.service.start(forged, id))).toBe('unresolved_tenant');
    expect(await codeOf(w.service.start(w.tenantB, id))).toBe('execution_not_found');
    expect(await codeOf(w.service.cancel(w.tenantB, id, 'director_request'))).toBe(
      'execution_not_found',
    );
    expect((await w.service.get(w.tenantA, id)).status).toBe('pending');
  });

  it('8. a forged execution id is unknown, like a missing one', async () => {
    const w = await world();
    for (const id of ['99999999-9999-4999-8999-999999999999', 'not-an-id', '', '../x']) {
      expect(await codeOf(w.service.start(w.tenantA, id))).toBe('execution_not_found');
      expect(await codeOf(w.service.cancel(w.tenantA, id, 'director_request'))).toBe(
        'execution_not_found',
      );
    }
  });

  it('9. a second start changes nothing and returns the running execution', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    const first = await w.service.start(w.tenantA, id);
    const second = await w.service.start(w.tenantA, id);
    expect(second).toEqual(first);
    expect(w.events().filter((e) => e.transition?.to === 'running')).toHaveLength(1);
  });

  it('10. concurrent starts run the execution once', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    const results = await Promise.all([
      w.service.start(w.tenantA, id),
      w.service.start(w.tenantA, id),
      w.service.start(w.tenantA, id),
    ]);
    expect(results.every((r) => r.status === 'running' && r.revision === 2)).toBe(true);
    expect(w.events().filter((e) => e.transition?.to === 'running')).toHaveLength(1);
  });

  it('never starts a planning execution, a cancelled one, or one moved into running otherwise', async () => {
    const w = await world();
    const plan = await w.service.create(w.tenantA, { ...REQUEST, mode: 'plan' });
    expect(await codeOf(w.service.start(w.tenantA, plan.id))).toBe('invalid_execution_transition');
    const { id } = await w.service.create(w.tenantA, REQUEST);
    // A person moves running work only through start and cancel (ADR-0031), and the runtime
    // cannot move work into running without start.
    expect(
      await codeOf(w.service.changeStatus(w.tenantA, id, { from: 'pending', to: 'running' })),
    ).toBe('actor_not_allowed');
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'pending', to: 'running' }),
      ),
    ).toBe('execution_not_started');
    await w.service.cancel(w.tenantA, id, 'director_request');
    expect(await codeOf(w.service.start(w.tenantA, id))).toBe('execution_already_terminal');
  });

  it('never starts a child whose parent has ended', async () => {
    const w = await world();
    const parent = await w.service.create(w.tenantA, REQUEST);
    const child = await w.service.create(w.tenantA, {
      ...REQUEST,
      parentExecutionId: parent.id,
    });
    await w.service.cancel(w.tenantA, parent.id, 'director_request');
    expect(await codeOf(w.service.start(w.tenantA, child.id))).toBe('execution_parent_ended');
  });
});

describe('CV-6B: delegated start (ADR-0043)', () => {
  it("the runtime starts its own person's pending work, audited as a delegated start", async () => {
    const w = await world();
    const { id } = await w.service.create(w.runtimeA, REQUEST);
    const started = await w.service.runtimeStart(w.runtimeA, id);
    expect(started).toMatchObject({ status: 'running', startedAt: NOW.toISOString() });
    expect(w.events().at(-1)).toMatchObject({
      action: 'execution.state_changed',
      transition: { from: 'pending', to: 'running' },
      reason: 'delegated_start',
    });
    // Idempotent, as a person's start.
    expect(await w.service.runtimeStart(w.runtimeA, id)).toEqual(started);
  });

  it('only the runtime, only while its person holds execution.start, only in its organization', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    expect(await codeOf(w.service.runtimeStart(w.tenantA, id))).toBe('actor_not_allowed');
    expect(await codeOf(w.service.runtimeStart(w.giaA, id))).toBe('actor_not_allowed');
    const runtimeB = await resolveRuntimeTenant(BOB, w.b.organization.id, w.tenancy);
    expect(await codeOf(w.service.runtimeStart(runtimeB, id))).toBe('execution_not_found');
    const denied = await world({ owner: ROLES.owner.filter((p) => p !== 'execution.start') });
    const other = await denied.service.create(denied.runtimeA, REQUEST);
    expect(await codeOf(denied.service.runtimeStart(denied.runtimeA, other.id))).toBe(
      'permission_denied',
    );
    expect(
      w
        .events()
        .filter((e) => e.action === 'execution.start_denied')
        .map((e) => e.reason),
    ).toEqual(['runtime_only', 'runtime_only']);
    expect((await w.service.get(w.tenantA, id)).status).toBe('pending');
  });
});

describe('X6a: cancellation (ADR-0029)', () => {
  it('11. only the owner, acting directly, cancels', async () => {
    const w = await world({ owner: ROLES.owner.filter((p) => p !== 'execution.cancel') });
    const { id } = await w.service.create(w.tenantA, REQUEST);
    expect(await codeOf(w.service.cancel(w.tenantA, id, 'director_request'))).toBe(
      'permission_denied',
    );
    expect(await codeOf(w.service.cancel(w.giaA, id, 'director_request'))).toBe(
      'actor_not_allowed',
    );
    expect(await codeOf(w.service.cancel(w.runtimeA, id, 'director_request'))).toBe(
      'actor_not_allowed',
    );
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, {
          from: 'pending',
          to: 'cancelled',
          reason: 'director_request',
        }),
      ),
    ).toBe('actor_not_allowed');
    expect(
      w
        .events()
        .filter((e) => e.action === 'execution.cancel_denied')
        .map((e) => e.reason),
    ).toEqual(['permission_denied', 'gia_cannot_cancel', 'runtime_cannot_cancel']);
    expect((await w.service.get(w.tenantA, id)).status).toBe('pending');
    const owner = await world();
    const other = await owner.service.create(owner.tenantA, REQUEST);
    const cancelled = await owner.service.cancel(owner.tenantA, other.id, 'director_request');
    expect(cancelled.cancellation).toEqual({
      at: NOW.toISOString(),
      by: ALICE,
      reason: 'director_request',
    });
    // Cancelling again changes nothing; a completed or failed execution cannot be cancelled.
    expect(await owner.service.cancel(owner.tenantA, other.id, 'director_request')).toEqual(
      cancelled,
    );
  });

  it('13. a cancelled execution never revives: late results are refused and discarded', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    const cancelled = await w.service.cancel(w.tenantA, id, 'director_request');
    expect(cancelled.nodes[0]?.status).toBe('cancelled');
    // The work that was running reports late: nothing it says is kept.
    for (const late of [
      () =>
        w.service.runtimeChangeNode(w.runtimeA, id, {
          nodeId: 'work',
          from: 'running',
          to: 'completed',
          output: { type: 'document', id: 'late' },
        }),
      () =>
        w.service.runtimeChangeNode(w.runtimeA, id, {
          nodeId: 'work',
          from: 'cancelled',
          to: 'running',
        }),
      () => w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'cancelled', to: 'running' }),
      () => w.service.recordVerification(w.runtimeA, id, passing()),
      () => w.service.retryNode(w.runtimeA, id, 'work'),
      () => w.service.markOutcomeUnknown(w.runtimeA, id, 'work'),
      () => w.service.start(w.tenantA, id),
    ]) {
      expect(await codeOf(late())).toBe('execution_already_terminal');
    }
    expect(await w.service.get(w.tenantA, id)).toEqual(cancelled);
  });
});

describe('X6a: verification invariant (ADR-0029)', () => {
  it('14. never verifying or completed while a node is pending or running', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' }),
      ),
    ).toBe('invalid_execution_transition');
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' }),
      ),
    ).toBe('invalid_execution_transition');
    expect((await w.service.get(w.tenantA, id)).status).toBe('running');
  });

  it('15. never completed with a failed or cancelled node', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'work',
      from: 'running',
      to: 'failed',
      error: { code: 'provider_error' },
    });
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' }),
      ),
    ).toBe('invalid_execution_transition');
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'completed' }),
      ),
    ).toBe('invalid_execution_transition');
  });

  it('16. verifying → completed needs recorded evidence that passed, recorded by the runtime', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await finishWork(w, id);
    await w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' });
    const complete = () =>
      codeOf(w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'verifying', to: 'completed' }));
    expect(await complete()).toBe('verification_required');
    // Only deterministic policies, only complete evidence, only the runtime.
    for (const policy of ['human_review', 'specialist_review']) {
      const input = passing();
      const bad = { ...input, nodes: [{ ...input.nodes[0], policy }] };
      expect(await codeOf(w.service.recordVerification(w.runtimeA, id, bad as never))).toBe(
        'verification_policy_not_available',
      );
    }
    const noEvidence = {
      correlationId: 'req-verify-1',
      nodes: [{ nodeId: 'work', policy: 'checks', checks: [{ code: 'x', result: 'passed' }] }],
    };
    expect(await codeOf(w.service.recordVerification(w.runtimeA, id, noEvidence as never))).toBe(
      'invalid_execution',
    );
    expect(
      await codeOf(w.service.recordVerification(w.runtimeA, id, { ...passing(), nodes: [] })),
    ).toBe('invalid_execution');
    expect(await codeOf(w.service.recordVerification(w.tenantA, id, passing()))).toBe(
      'actor_not_allowed',
    );
    expect(await complete()).toBe('verification_required');
    const verified = await w.service.recordVerification(w.runtimeA, id, passing());
    expect(verified.verification).toEqual({
      schemaVersion: 1,
      executionId: id,
      result: 'passed',
      verifiedAt: NOW.toISOString(),
      correlationId: 'req-verify-1',
      nodes: [
        {
          nodeId: 'work',
          policy: 'output_schema',
          result: 'passed',
          checks: [{ code: 'schema_valid', result: 'passed', evidence: EVIDENCE }],
        },
      ],
    });
    expect(await complete()).toBe('accepted');
  });

  it('a failed check is recorded as evidence and never completes', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await finishWork(w, id);
    await w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' });
    const input = passing();
    const failing = {
      ...input,
      nodes: [
        {
          ...input.nodes[0],
          checks: [
            { code: 'schema_valid', result: 'passed', evidence: EVIDENCE },
            { code: 'sources_cited', result: 'failed', evidence: EVIDENCE },
          ],
        },
      ],
    };
    const recorded = await w.service.recordVerification(w.runtimeA, id, failing as never);
    expect(recorded.verification?.result).toBe('failed');
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'verifying', to: 'completed' }),
      ),
    ).toBe('verification_required');
    // Written once per pass: a second verifier cannot replace the evidence.
    expect(await codeOf(w.service.recordVerification(w.runtimeA, id, passing()))).toBe(
      'execution_concurrency_conflict',
    );
    expect(w.events().at(-1)).toMatchObject({
      action: 'execution.verification_recorded',
      reason: 'verification_failed',
    });
  });
});

describe('X6a: attempts (ADR-0029)', () => {
  const GRAPH: ExecutionRequest = {
    ...REQUEST,
    nodes: [
      { id: 'decide', type: 'condition', label: 'Decide' },
      { id: 'think', type: 'agent', label: 'Think' },
    ],
  };

  async function failed(code: string, nodeId: 'decide' | 'think') {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, GRAPH);
    await w.service.start(w.tenantA, id);
    await w.service.runtimeChangeNode(w.runtimeA, id, { nodeId, from: 'pending', to: 'running' });
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId,
      from: 'running',
      to: 'failed',
      error: { code },
    });
    return { w, id };
  }

  it('A. a node with no external effect is retried once, never twice', async () => {
    const { w, id } = await failed('check_failed', 'decide');
    const retried = await w.service.retryNode(w.runtimeA, id, 'decide');
    expect(retried.nodes[0]).toMatchObject({ id: 'decide', status: 'pending', attempt: 2 });
    expect(retried.nodes[0]).not.toHaveProperty('error');
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'decide',
      from: 'pending',
      to: 'running',
    });
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'decide',
      from: 'running',
      to: 'failed',
      error: { code: 'check_failed' },
    });
    expect(await codeOf(w.service.retryNode(w.runtimeA, id, 'decide'))).toBe('retry_not_allowed');
    expect(w.events().filter((e) => e.action === 'execution.node_retried')).toEqual([
      expect.objectContaining({
        reason: 'effect_free',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
      }),
    ]);
  });

  it('B. a node with an external effect and no idempotency key is never retried', async () => {
    const { w, id } = await failed('provider_error', 'think');
    expect(await codeOf(w.service.retryNode(w.runtimeA, id, 'think'))).toBe('retry_not_allowed');
  });

  it('only the runtime retries, and two concurrent retries make one attempt', async () => {
    const { w, id } = await failed('check_failed', 'decide');
    expect(await codeOf(w.service.retryNode(w.tenantA, id, 'decide'))).toBe('actor_not_allowed');
    const results = await Promise.all([
      codeOf(w.service.retryNode(w.runtimeA, id, 'decide')),
      codeOf(w.service.retryNode(w.runtimeA, id, 'decide')),
    ]);
    expect(results.sort()).toEqual(['accepted', 'execution_concurrency_conflict']);
    expect((await w.service.get(w.tenantA, id)).nodes[0]?.attempt).toBe(2);
  });

  it('18. an unknown outcome (lost worker, timeout) is never re-run', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, GRAPH);
    await w.service.start(w.tenantA, id);
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'decide',
      from: 'pending',
      to: 'running',
    });
    // The worker never reported back: the runtime records that nobody knows what happened.
    expect(await codeOf(w.service.markOutcomeUnknown(w.tenantA, id, 'decide'))).toBe(
      'actor_not_allowed',
    );
    const unknown = await w.service.markOutcomeUnknown(w.runtimeA, id, 'decide');
    expect(unknown.nodes[0]).toMatchObject({
      status: 'failed',
      error: { code: 'outcome_unknown' },
    });
    expect(await codeOf(w.service.retryNode(w.runtimeA, id, 'decide'))).toBe('retry_not_allowed');
    const timedOut = await failed('timeout', 'decide');
    expect(
      await codeOf(timedOut.w.service.retryNode(timedOut.w.runtimeA, timedOut.id, 'decide')),
    ).toBe('retry_not_allowed');
  });
});

describe('X6a: actors (ADR-0029)', () => {
  it('19. the runtime is audited as a system actor, with the user who started the work', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await finishWork(w, id);
    await w.service.runtimeChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' });
    await w.service.recordVerification(w.runtimeA, id, passing());
    const runtime = w.events().filter((e) => e.actor.type === 'system');
    expect(runtime.map((e) => e.action)).toEqual([
      'execution.node_changed',
      'execution.node_changed',
      'execution.state_changed',
      'execution.verification_recorded',
    ]);
    for (const event of runtime) {
      expect(event).toMatchObject({
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        organizationId: w.a.organization.id,
        target: { type: 'execution', id },
      });
    }
  });

  it('20. a person and the runtime are never mistaken for each other', async () => {
    const w = await world();
    expect(w.tenantA.actor).toBe('user');
    expect(w.giaA.actor).toBe('gia');
    expect(w.runtimeA.actor).toBe('runtime');
    // Same user, same organization: still three different actors in the audit trail.
    expect(new Set([w.tenantA, w.giaA, w.runtimeA].map((t) => t.userId))).toEqual(new Set([ALICE]));
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await codeOf(w.service.start(w.runtimeA, id));
    const actors = w.events().map((e) => JSON.stringify(e.actor));
    expect(new Set(actors)).toEqual(
      new Set([
        JSON.stringify({ type: 'user', userId: ALICE, via: 'direct' }),
        JSON.stringify({ type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' }),
      ]),
    );
  });
});

describe('X6c N1: only the runtime drives running work (ADR-0031)', () => {
  const STATUSES = ['verifying', 'completed', 'failed', 'retrying', 'waiting_approval'] as const;

  it('refuses a user or GIA changing the status or a node of an execution that runs', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    for (const tenant of [w.tenantA, w.giaA]) {
      for (const to of STATUSES) {
        expect(
          await codeOf(
            w.service.changeStatus(tenant, id, {
              from: 'running',
              to,
              ...(to === 'failed' ? { failure: { code: 'forced' } } : {}),
            }),
          ),
        ).toBe('actor_not_allowed');
        expect(
          await codeOf(w.service.runtimeChangeStatus(tenant, id, { from: 'running', to })),
        ).toBe('actor_not_allowed');
      }
      expect(
        await codeOf(
          w.service.runtimeChangeNode(tenant, id, {
            nodeId: 'work',
            from: 'pending',
            to: 'running',
          }),
        ),
      ).toBe('actor_not_allowed');
      expect(await codeOf(w.service.retryNode(tenant, id, 'work'))).toBe('actor_not_allowed');
      expect(await codeOf(w.service.markOutcomeUnknown(tenant, id, 'work'))).toBe(
        'actor_not_allowed',
      );
    }
    // A person still cancels through the owner-only cancel of X6a.
    expect(
      await codeOf(
        w.service.changeStatus(w.tenantA, id, {
          from: 'running',
          to: 'cancelled',
          reason: 'director_request',
        }),
      ),
    ).toBe('actor_not_allowed');
    const stored = await w.service.get(w.tenantA, id);
    expect(stored).toMatchObject({ status: 'running', revision: 2 });
    expect(stored.nodes[0]?.status).toBe('pending');
    expect(w.events().filter((e) => e.action === 'execution.node_changed')).toHaveLength(0);
  });

  it('refuses a context that only claims to be the runtime', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    const claimed = { ...w.tenantA, actor: 'runtime' } as TenantContext;
    const copied = { ...w.runtimeA } as TenantContext;
    for (const forged of [claimed, copied]) {
      expect(
        await codeOf(
          w.service.runtimeChangeNode(forged, id, {
            nodeId: 'work',
            from: 'pending',
            to: 'running',
          }),
        ),
      ).toBe('unresolved_tenant');
      expect(
        await codeOf(
          w.service.runtimeChangeStatus(forged, id, {
            from: 'running',
            to: 'failed',
            failure: { code: 'forced' },
          }),
        ),
      ).toBe('unresolved_tenant');
    }
    expect((await w.service.get(w.tenantA, id)).status).toBe('running');
  });

  it('keeps the runtime out of the planning lifecycle and away from cancelling', async () => {
    const w = await world();
    const plan = await w.service.create(w.tenantA, { ...REQUEST, mode: 'plan' });
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, plan.id, { from: 'pending', to: 'planning' }),
      ),
    ).toBe('actor_not_allowed');
    expect(
      await codeOf(
        w.service.changeStatus(w.runtimeA, plan.id, { from: 'pending', to: 'planning' }),
      ),
    ).toBe('actor_not_allowed');
    // The planning lifecycle stays the planner's, acting for the user.
    expect(
      (await w.service.changeStatus(w.tenantA, plan.id, { from: 'pending', to: 'planning' }))
        .status,
    ).toBe('planning');
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    expect(
      await codeOf(
        w.service.runtimeChangeStatus(w.runtimeA, id, {
          from: 'running',
          to: 'cancelled',
          reason: 'director_request',
        }),
      ),
    ).toBe('actor_not_allowed');
  });

  it('lets only the runtime move a planning execution, through the plan methods only (WF-1)', async () => {
    const w = await world();
    const plan = await w.service.create(w.tenantA, { ...REQUEST, mode: 'plan' });
    await w.service.changeStatus(w.tenantA, plan.id, { from: 'pending', to: 'planning' });
    await w.service.changeStatus(w.tenantA, plan.id, { from: 'planning', to: 'running' });
    const node = { nodeId: 'work', from: 'pending', to: 'running' } as const;
    // The work methods never touch a plan, the plan methods never touch work.
    expect(await codeOf(w.service.runtimeChangeNode(w.runtimeA, plan.id, node))).toBe(
      'actor_not_allowed',
    );
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    expect(await codeOf(w.service.runtimePlanChangeNode(w.runtimeA, id, node))).toBe(
      'actor_not_allowed',
    );
    expect(
      await codeOf(
        w.service.runtimePlanChangeStatus(w.runtimeA, id, { from: 'running', to: 'verifying' }),
      ),
    ).toBe('actor_not_allowed');
    // Only the runtime: never a person or GIA, and never to cancel.
    for (const tenant of [w.tenantA, w.giaA]) {
      expect(await codeOf(w.service.runtimePlanChangeNode(tenant, plan.id, node))).toBe(
        'actor_not_allowed',
      );
    }
    expect(
      await codeOf(
        w.service.runtimePlanChangeStatus(w.runtimeA, plan.id, {
          from: 'running',
          to: 'cancelled',
          reason: 'director_request',
        }),
      ),
    ).toBe('actor_not_allowed');
    // The same model rules as any execution: no verifying with a node unfinished.
    expect(
      await codeOf(
        w.service.runtimePlanChangeStatus(w.runtimeA, plan.id, {
          from: 'running',
          to: 'verifying',
        }),
      ),
    ).toBe('invalid_execution_transition');
    const moved = await w.service.runtimePlanChangeNode(w.runtimeA, plan.id, node);
    expect(moved.nodes[0]?.status).toBe('running');
    expect(w.events().at(-1)).toMatchObject({
      action: 'execution.node_changed',
      nodeId: 'work',
      transition: { from: 'pending', to: 'running' },
    });
  });

  it('attaches a tool step’s approval to a plan step that has not started, once (ADR-0151)', async () => {
    const w = await world();
    const parent = await w.service.create(w.tenantA, { ...REQUEST, mode: 'plan' });
    const nodes = [
      { id: 'work', type: 'agent', label: 'Work' },
      {
        id: 'look',
        type: 'tool',
        label: 'Look',
        dependsOn: ['work'],
        tool: { id: 'lookup', version: 1 },
      },
    ] as const;
    const step = (id: string) =>
      w.service.create(w.tenantA, {
        ...REQUEST,
        input: { type: 'plan_step', id },
        parentExecutionId: parent.id,
        nodes: [...nodes],
      });
    const child = await step('p:work');
    const approval = '00000000-0000-4000-8000-000000000001';
    const attached = await w.service.attachPlanStepApproval(w.runtimeA, child.id, 'look', approval);
    expect(attached.nodes.find((n) => n.id === 'look')?.approvalId).toBe(approval);
    expect(w.events().at(-1)).toMatchObject({
      action: 'execution.approval_attached',
      nodeId: 'look',
      reference: approval,
    });
    // Again: nothing changes, nothing more is recorded.
    const count = w.events().length;
    expect(await w.service.attachPlanStepApproval(w.tenantA, child.id, 'look', approval)).toEqual(
      attached,
    );
    expect(w.events()).toHaveLength(count);
    // Another approval, an agent node, GIA, another organization: refused.
    const other = '00000000-0000-4000-8000-000000000002';
    expect(
      await codeOf(w.service.attachPlanStepApproval(w.runtimeA, child.id, 'look', other)),
    ).toBe('execution_concurrency_conflict');
    const fresh = await step('p:other');
    expect(
      await codeOf(w.service.attachPlanStepApproval(w.runtimeA, fresh.id, 'work', other)),
    ).toBe('invalid_execution');
    expect(await codeOf(w.service.attachPlanStepApproval(w.giaA, fresh.id, 'look', other))).toBe(
      'actor_not_allowed',
    );
    expect(await codeOf(w.service.attachPlanStepApproval(w.tenantB, fresh.id, 'look', other))).toBe(
      'execution_not_found',
    );
    // Not a plan step, or one already started: refused.
    const plain = await w.service.create(w.tenantA, { ...REQUEST, nodes: [...nodes] });
    expect(
      await codeOf(w.service.attachPlanStepApproval(w.runtimeA, plain.id, 'look', other)),
    ).toBe('actor_not_allowed');
    await w.service.start(w.tenantA, fresh.id);
    expect(
      await codeOf(w.service.attachPlanStepApproval(w.runtimeA, fresh.id, 'look', other)),
    ).toBe('actor_not_allowed');
  });

  it('lets a person withdraw work that never started, and nothing else', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    const withdrawn = await w.service.changeStatus(w.tenantA, id, {
      from: 'pending',
      to: 'cancelled',
      reason: 'delegation_failed',
    });
    expect(withdrawn.status).toBe('cancelled');
  });
});

describe('X6c N2: every node change is audited in its own write (ADR-0031)', () => {
  it('records who, where, which node, from and to, and the failure code, never payloads', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    await w.service.runtimeChangeNode(w.runtimeA, id, {
      nodeId: 'work',
      from: 'running',
      to: 'failed',
      error: { code: 'tool_failure' },
    });
    const changes = w.events().filter((e) => e.action === 'execution.node_changed');
    expect(changes.map((e) => [e.nodeId, e.transition, e.reason])).toEqual([
      ['work', { from: 'pending', to: 'running' }, undefined],
      ['work', { from: 'running', to: 'failed' }, 'tool_failure'],
    ]);
    for (const change of changes) {
      expect(change).toMatchObject({
        result: 'success',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        organizationId: w.a.organization.id,
        target: { type: 'execution', id },
        requestId: 'req-1',
      });
      expect(typeof change.occurredAt).toBe('string');
      expect(JSON.stringify(change)).not.toMatch(/task-1|input|output|token|authorization/i);
    }
  });

  it('changes no node when its audit event cannot be stored', async () => {
    const w = await world();
    const { id } = await w.service.create(w.tenantA, REQUEST);
    await w.service.start(w.tenantA, id);
    const original = w.audit.appendNow.bind(w.audit);
    w.audit.appendNow = () => {
      throw new Error('audit unavailable');
    };
    await expect(
      w.service.runtimeChangeNode(w.runtimeA, id, {
        nodeId: 'work',
        from: 'pending',
        to: 'running',
      }),
    ).rejects.toThrow('audit unavailable');
    await expect(
      w.service.runtimeChangeStatus(w.runtimeA, id, {
        from: 'running',
        to: 'failed',
        failure: { code: 'forced' },
      }),
    ).rejects.toThrow('audit unavailable');
    w.audit.appendNow = original;
    const stored = await w.service.get(w.tenantA, id);
    expect(stored).toMatchObject({ status: 'running', revision: 2 });
    expect(stored.nodes[0]?.status).toBe('pending');
  });
});
