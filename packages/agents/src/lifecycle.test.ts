import { InMemoryAuditStore } from '@melonoffice/audit';
import { openWallet } from '@melonoffice/credits';
import type {
  Execution,
  ExecutionId,
  InitialBilling,
  Organization,
  SpecialistId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { InMemoryExecutionRepository } from '@melonoffice/execution';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgentWorkStop } from './lifecycle.js';

/** What stopping an agent does to its work in progress (AE-4, ADR-0115). */

let ORG = '';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
const AGENT = '33333333-3333-4333-8333-333333333333' as SpecialistId;
const OTHER_AGENT = '66666666-6666-4666-8666-666666666666' as SpecialistId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

let tenant: TenantContext;

beforeAll(async () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const tenancy = new InMemoryTenancyStore(() => now, new InMemoryAuditStore());
  const billing = (organization: Organization): InitialBilling => {
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
  const as = { actor: 'user', userId: ALICE, emailVerified: true } as const;
  const { organization } = await createOrganization(as, { name: 'A' }, tenancy, {
    billing,
    credits: openWallet,
  });
  ORG = organization.id;
  tenant = await resolveTenant(as, ORG, tenancy);
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as ExecutionId;

/** A stored execution as the repository keeps it; only the fields the index reads matter. */
const execution = (
  n: number,
  status: Execution['status'],
  over: Partial<Execution> = {},
): Execution =>
  ({
    id: id(n),
    organizationId: ORG,
    specialistId: AGENT,
    status,
    nodes: [],
    revision: 1,
    ...over,
  }) as unknown as Execution;

function store(executions: readonly Execution[]) {
  const repository = new InMemoryExecutionRepository();
  for (const e of executions) repository.put(e);
  return repository;
}

describe('stopping an agent (AE-4)', () => {
  it('finds only the open executions of that agent in that organization', async () => {
    const repository = store([
      execution(1, 'running'),
      execution(2, 'waiting_approval'),
      execution(3, 'pending'),
      execution(4, 'completed'),
      execution(5, 'failed'),
      execution(6, 'cancelled'),
      execution(7, 'running', { specialistId: OTHER_AGENT }),
      execution(8, 'running', { organizationId: OTHER_ORG } as never),
    ]);
    expect(await repository.openOfSpecialist(ORG as never, AGENT, 10)).toEqual({
      ids: [id(1), id(2), id(3)],
      more: false,
    });
    expect(await repository.openOfSpecialist(ORG as never, AGENT, 2)).toEqual({
      ids: [id(1), id(2)],
      more: true,
    });
  });

  it('cancels each with the reason, as the person, and withdraws the approval it waited on', async () => {
    const repository = store([
      execution(1, 'running'),
      execution(2, 'waiting_approval', {
        nodes: [{ id: 'schedule', approvalId: 'approval-1' }] as never,
      }),
    ]);
    const cancelled: { id: string; reason: string; by: unknown }[] = [];
    const withdrawn: { id: string; reason: string }[] = [];
    const stop = createAgentWorkStop({
      open: repository,
      executions: {
        async cancel(t, executionId, reason) {
          cancelled.push({ id: executionId, reason, by: t });
          return (await repository.find(ORG as never, executionId as ExecutionId)) as never;
        },
      },
      approvals: {
        async cancel(_t, approvalId, reason) {
          withdrawn.push({ id: approvalId, reason });
        },
      },
    });
    expect(await stop.stop(tenant, AGENT, 'agent_paused')).toEqual({ cancelled: 2, more: false });
    expect(cancelled.map((c) => [c.id, c.reason])).toEqual([
      [id(1), 'agent_paused'],
      [id(2), 'agent_paused'],
    ]);
    expect(cancelled.every((c) => c.by === tenant)).toBe(true);
    expect(withdrawn).toEqual([{ id: 'approval-1', reason: 'agent_paused' }]);
  });

  it('never throws: a failed cancellation is logged and the rest go on', async () => {
    const repository = store([execution(1, 'running'), execution(2, 'running')]);
    const warnings: string[] = [];
    const stop = createAgentWorkStop({
      open: repository,
      executions: {
        async cancel(_t, executionId) {
          if (executionId === id(1)) throw new Error('execution_not_cancellable');
          return (await repository.find(ORG as never, executionId as ExecutionId)) as never;
        },
      },
      approvals: {
        async cancel() {
          throw new Error('approval_not_pending');
        },
      },
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(await stop.stop(tenant, AGENT, 'agent_disabled')).toEqual({
      cancelled: 1,
      more: false,
    });
    expect(warnings).toEqual(['agent work not cancelled']);
    const broken = createAgentWorkStop({
      open: {
        openOfSpecialist: async () => {
          throw new Error('store down');
        },
      },
      executions: { cancel: async () => undefined as never },
    });
    expect(await broken.stop(tenant, AGENT, 'agent_disabled')).toEqual({
      cancelled: 0,
      more: true,
    });
  });

  it('cancels at most its limit and says there is more', async () => {
    const repository = store([1, 2, 3, 4, 5].map((n) => execution(n, 'running')));
    const seen: string[] = [];
    const stop = createAgentWorkStop({
      open: repository,
      limit: 3,
      executions: {
        async cancel(_t, executionId) {
          seen.push(executionId);
          return (await repository.find(ORG as never, executionId as ExecutionId)) as never;
        },
      },
    });
    expect(await stop.stop(tenant, AGENT, 'agent_archived')).toEqual({ cancelled: 3, more: true });
    expect(seen).toHaveLength(3);
  });

  it('does nothing for a tenant that is not resolved', async () => {
    const stop = createAgentWorkStop({
      open: store([execution(1, 'running')]),
      executions: {
        cancel: async () => {
          throw new Error('never called');
        },
      },
    });
    expect(await stop.stop({ actor: 'anonymous' } as never, AGENT, 'agent_paused')).toEqual({
      cancelled: 0,
      more: false,
    });
  });
});
