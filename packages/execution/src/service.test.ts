import { InMemoryAuditStore } from '@melonoffice/audit';
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
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
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

async function world() {
  const audit = new InMemoryAuditStore();
  const repository = new InMemoryExecutionRepository(audit);
  const tenancy = new InMemoryTenancyStore(() => NOW);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, { billing: BILLING });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, { billing: BILLING });
  const service = createExecutionService({
    repository,
    organizations: tenancy,
    now: () => NOW,
    requestId: 'req-1',
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const events = () => audit.events().filter((e) => e.action.startsWith('execution.'));
  return { audit, repository, tenancy, service, a, b, tenantA, tenantB, events };
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
    const { service, tenantA, events } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.changeStatus(tenantA, id, { from: 'pending', to: 'running' });
    await service.changeStatus(tenantA, id, {
      from: 'running',
      to: 'failed',
      failure: { code: 'provider_timeout' },
    });
    const changes = events().filter((e) => e.action === 'execution.state_changed');
    expect(changes.map((e) => [e.transition, e.reason])).toEqual([
      [{ from: 'pending', to: 'running' }, undefined],
      [{ from: 'running', to: 'failed' }, 'provider_timeout'],
    ]);
    for (const event of events()) {
      expect(event.target).toEqual({ type: 'execution', id });
      expect(JSON.stringify(event)).not.toMatch(/task-1|input|nodes|token|authorization/i);
    }
  });

  it('does not audit graph changes, which live in the execution', async () => {
    const { service, tenantA, events } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.addNodes(tenantA, id, [
      { id: 'check', type: 'verification', label: 'Check', dependsOn: ['work'] },
    ]);
    const moved = await service.changeNode(tenantA, id, {
      nodeId: 'work',
      from: 'pending',
      to: 'running',
    });
    expect(moved.currentNodeId).toBe('work');
    expect(moved.revision).toBe(3);
    expect(events()).toHaveLength(1);
  });

  it('records a cancellation with who and why, and refuses everything after it', async () => {
    const { service, tenantA, events } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.changeStatus(tenantA, id, { from: 'pending', to: 'running' });
    const cancelled = await service.changeStatus(tenantA, id, {
      from: 'running',
      to: 'cancelled',
      reason: 'director_request',
    });
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
      expect(await codeOf(service.changeStatus(tenantA, id, { from: 'cancelled', to }))).toBe(
        'execution_already_terminal',
      );
    }
    expect(
      await codeOf(
        service.changeNode(tenantA, id, { nodeId: 'work', from: 'cancelled', to: 'running' }),
      ),
    ).toBe('execution_already_terminal');
    expect((await service.get(tenantA, id)).status).toBe('cancelled');
  });
});

describe('concurrency', () => {
  it('never lets a change overwrite a concurrent cancellation', async () => {
    const { service, tenantA } = await world();
    const { id } = await service.create(tenantA, REQUEST);
    await service.changeStatus(tenantA, id, { from: 'pending', to: 'running' });
    const results = await Promise.all([
      codeOf(service.changeStatus(tenantA, id, { from: 'running', to: 'verifying' })),
      codeOf(
        service.changeStatus(tenantA, id, {
          from: 'running',
          to: 'cancelled',
          reason: 'director_request',
        }),
      ),
    ]);
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'execution_concurrency_conflict')).toHaveLength(1);
    const final = await service.get(tenantA, id);
    expect(final.revision).toBe(3);
    expect(['verifying', 'cancelled']).toContain(final.status);
  });

  it('refuses a write built on an older revision', async () => {
    const { repository, service, tenantA } = await world();
    const execution = await service.create(tenantA, REQUEST);
    await service.changeStatus(tenantA, execution.id, { from: 'pending', to: 'running' });
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
    await expect(
      service.changeStatus(tenantA, id, { from: 'pending', to: 'running' }),
    ).rejects.toThrow('audit unavailable');
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
