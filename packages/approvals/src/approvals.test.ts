import { openWallet } from '@melonoffice/credits';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  Approval,
  ApprovalOperation,
  ExecutionId,
  ExecutionNodeId,
  InitialBilling,
  Organization,
  OrganizationId,
  SpecialistId,
  SubscriptionId,
  ToolId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { digestOf } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { ApprovalError } from './errors.js';
import {
  APPROVAL_TRANSITIONS,
  bindingDigestOf,
  checkApprovalUse,
  checkStoredApproval,
  decide,
  newApproval,
} from './model.js';
import { InMemoryApprovalRepository } from './repository.js';
import { createApprovalService } from './service.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const EXECUTION = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as ExecutionId;
const SPECIALIST = '33333333-3333-4333-8333-333333333333' as SpecialistId;

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

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

const operation = (
  organizationId: OrganizationId,
  overrides: Partial<ApprovalOperation> = {},
): ApprovalOperation => ({
  organizationId,
  executionId: EXECUTION,
  nodeId: 'send' as ExecutionNodeId,
  specialistId: SPECIALIST,
  specialistVersion: 1,
  toolId: 'send_email' as ToolId,
  toolVersion: 1,
  action: 'send',
  inputDigest: digestOf({ to: 'team' }),
  ...overrides,
});

async function codeOf(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof ApprovalError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function world(roles?: Record<string, readonly string[]>) {
  let clock = T0;
  const now = () => clock;
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(now, audit);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  const repository = new InMemoryApprovalRepository(audit);
  const service = createApprovalService({
    repository,
    organizations: tenancy,
    authorization: createAuthorizationService(roles as never),
    audit: createAuditService(audit, now),
    now,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const giaA = await resolveTenant(as(ALICE, 'gia'), orgA, tenancy);
  const runtimeA = await resolveRuntimeTenant(ALICE, orgA, tenancy);
  const request = (overrides: Partial<ApprovalOperation> = {}) =>
    service.request(tenantA, {
      operation: operation(orgA, overrides),
      riskLevel: 'high',
      reason: 'approval_required',
      impact: 'changes_data',
      ttlSeconds: 600,
    });
  const events = async (action: string) => audit.events().filter((e) => e.action === action);
  return {
    audit,
    events,
    repository,
    service,
    orgA,
    orgB,
    tenantA,
    tenantB,
    giaA,
    runtimeA,
    request,
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

describe('approval model', () => {
  const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId;
  const pending = (): Approval =>
    newApproval(
      {
        operation: operation(orgA),
        requestedBy: ALICE,
        riskLevel: 'high',
        reason: 'approval_required',
        impact: 'changes_data',
        ttlSeconds: 600,
      },
      T0,
    );

  it('binds a new pending approval to one exact operation', () => {
    const approval = pending();
    expect(approval).toMatchObject({ status: 'pending', revision: 1, organizationId: orgA });
    expect(approval.bindingDigest).toBe(bindingDigestOf(operation(orgA)));
    expect(approval.expiresAt).toBe('2026-09-27T12:10:00.000Z');
    expect(checkStoredApproval(approval)).toBe(approval);
  });

  it('moves only from pending, and every other status is final', () => {
    for (const status of ['approved', 'rejected', 'expired', 'cancelled'] as const) {
      expect(APPROVAL_TRANSITIONS[status]).toEqual([]);
    }
    const approved = decide(pending(), 'approved', ALICE, T0);
    expect(approved).toMatchObject({ status: 'approved', decidedBy: ALICE, revision: 2 });
    expect(() => decide(approved, 'rejected', ALICE, T0)).toThrow('approval_not_pending');
  });

  it('expires only once its time has passed, and refuses decisions after it', () => {
    const late = new Date(T0.getTime() + 600_000);
    expect(() => decide(pending(), 'expired', undefined, T0)).toThrow('not_due');
    expect(() => decide(pending(), 'approved', ALICE, late)).toThrow('approval_expired');
    expect(decide(pending(), 'expired', undefined, late).status).toBe('expired');
  });

  it('covers exactly its operation: any other one is a mismatch', () => {
    const approved = decide(pending(), 'approved', ALICE, T0);
    expect(checkApprovalUse(approved, operation(orgA), T0)).toBeUndefined();
    const others: Partial<ApprovalOperation>[] = [
      { executionId: '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as ExecutionId },
      { nodeId: 'other' as ExecutionNodeId },
      { specialistVersion: 2 },
      { toolId: 'delete_file' as ToolId },
      { toolVersion: 2 },
      { action: 'delete' },
      { inputDigest: digestOf({ to: 'everyone' }) },
      { organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as OrganizationId },
    ];
    for (const other of others) {
      expect(checkApprovalUse(approved, operation(orgA, other), T0)).toBe('approval_mismatch');
    }
    expect(checkApprovalUse(pending(), operation(orgA), T0)).toBe('approval_pending');
    expect(checkApprovalUse(approved, operation(orgA), new Date(T0.getTime() + 600_000))).toBe(
      'approval_expired',
    );
  });

  it('refuses a stored approval whose binding was altered', () => {
    const approval = pending();
    const tampered = { ...approval, operation: { ...approval.operation, toolVersion: 2 } };
    expect(() => checkStoredApproval(tampered)).toThrow('bindingDigest');
    expect(checkApprovalUse(tampered, tampered.operation, T0)).toBe('approval_mismatch');
  });
});

describe('approval service', () => {
  it('approves once, with its audit event in the same write', async () => {
    const w = await world();
    const approval = await w.request();
    const approved = await w.service.approve(w.tenantA, approval.id);
    expect(approved).toMatchObject({ status: 'approved', decidedBy: ALICE });
    expect(await w.events('tool.approval_requested')).toHaveLength(1);
    expect(await w.events('tool.approval_approved')).toEqual([
      expect.objectContaining({
        result: 'success',
        organizationId: w.orgA,
        target: { type: 'approval', id: approval.id },
        tool: { id: 'send_email', version: 1 },
        transition: { from: 'pending', to: 'approved' },
      }),
    ]);
  });

  it('rejects once', async () => {
    const w = await world();
    const approval = await w.request();
    expect((await w.service.reject(w.tenantA, approval.id)).status).toBe('rejected');
    expect(await codeOf(w.service.reject(w.tenantA, approval.id))).toBe('approval_not_pending');
  });

  it('refuses a double approval and an approval after a rejection', async () => {
    const w = await world();
    const first = await w.request();
    await w.service.approve(w.tenantA, first.id);
    expect(await codeOf(w.service.approve(w.tenantA, first.id))).toBe('approval_not_pending');
    const second = await w.request();
    await w.service.reject(w.tenantA, second.id);
    expect(await codeOf(w.service.approve(w.tenantA, second.id))).toBe('approval_not_pending');
    expect((await w.service.get(w.tenantA, second.id)).status).toBe('rejected');
  });

  it('refuses to approve after expiry, and records the expiry', async () => {
    const w = await world();
    const approval = await w.request();
    w.advance(601);
    expect(await codeOf(w.service.approve(w.tenantA, approval.id))).toBe('approval_expired');
    expect((await w.service.get(w.tenantA, approval.id)).status).toBe('expired');
    expect(await w.events('tool.approval_expired')).toHaveLength(1);
  });

  it('refuses a user without approval.approve, and records the refusal', async () => {
    const w = await world({ owner: ['approval.read'] });
    const approval = await w.request();
    expect(await codeOf(w.service.approve(w.tenantA, approval.id))).toBe('approval_forbidden');
    expect(await w.events('tool.approval_approved')).toEqual([
      expect.objectContaining({ result: 'denied', reason: 'permission_denied' }),
    ]);
    expect((await w.service.get(w.tenantA, approval.id)).status).toBe('pending');
  });

  it('never lets GIA approve or reject, even for a user who may', async () => {
    const w = await world();
    const approval = await w.request();
    expect(await codeOf(w.service.approve(w.giaA, approval.id))).toBe('approval_forbidden');
    expect(await codeOf(w.service.reject(w.giaA, approval.id))).toBe('approval_forbidden');
    expect(await w.events('tool.approval_approved')).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'gia_cannot_decide',
        actor: { type: 'user', userId: ALICE, via: 'gia' },
      }),
    ]);
    expect((await w.service.get(w.tenantA, approval.id)).status).toBe('pending');
  });

  describe('X6a: no self-approval (ADR-0029)', () => {
    it('1. the runtime cannot approve, even for the user who started it', async () => {
      const w = await world();
      const approval = await w.request();
      expect(await codeOf(w.service.approve(w.runtimeA, approval.id))).toBe('approval_forbidden');
      expect(await w.events('tool.approval_approved')).toEqual([
        expect.objectContaining({
          result: 'denied',
          reason: 'runtime_cannot_decide',
          actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        }),
      ]);
      expect((await w.service.get(w.tenantA, approval.id)).status).toBe('pending');
    });

    it('2. the runtime cannot reject an approval', async () => {
      const w = await world();
      const approval = await w.request();
      expect(await codeOf(w.service.reject(w.runtimeA, approval.id))).toBe('approval_forbidden');
      expect(await w.events('tool.approval_rejected')).toEqual([
        expect.objectContaining({ result: 'denied', reason: 'runtime_cannot_decide' }),
      ]);
      expect((await w.service.get(w.tenantA, approval.id)).status).toBe('pending');
      // The user, acting directly, still decides.
      expect((await w.service.approve(w.tenantA, approval.id)).status).toBe('approved');
    });

    it('4. GIA cannot approve, and is told apart from the runtime', async () => {
      const w = await world();
      const approval = await w.request();
      await codeOf(w.service.approve(w.giaA, approval.id));
      await codeOf(w.service.approve(w.runtimeA, approval.id));
      expect((await w.events('tool.approval_approved')).map((e) => [e.reason, e.actor])).toEqual([
        ['gia_cannot_decide', { type: 'user', userId: ALICE, via: 'gia' }],
        [
          'runtime_cannot_decide',
          { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        ],
      ]);
      expect((await w.service.get(w.tenantA, approval.id)).status).toBe('pending');
    });
  });

  it("answers another organization's approval exactly like a missing one", async () => {
    const w = await world();
    const approval = await w.request();
    for (const work of [
      w.service.get(w.tenantB, approval.id),
      w.service.approve(w.tenantB, approval.id),
      w.service.reject(w.tenantB, approval.id),
      w.service.get(w.tenantA, 'not-a-uuid'),
      w.service.get(w.tenantA, '44444444-4444-4444-8444-444444444444'),
    ]) {
      expect(await codeOf(work)).toBe('approval_not_found');
    }
    expect(await w.service.list(w.tenantB)).toEqual([]);
    expect((await w.service.get(w.tenantA, approval.id)).status).toBe('pending');
  });

  it('refuses a request for another organization and an unresolved tenant', async () => {
    const w = await world();
    const forged = w.service.request(w.tenantA, {
      operation: operation(w.orgB),
      riskLevel: 'high',
      reason: 'approval_required',
      impact: 'changes_data',
      ttlSeconds: 600,
    });
    expect(await codeOf(forged)).toBe('invalid_approval');
    const unresolved = { ...w.tenantA } as typeof w.tenantA;
    expect(await codeOf(w.service.list(unresolved))).toBe('unresolved_tenant');
  });

  it('cancels and expires only pending approvals', async () => {
    const w = await world();
    const approval = await w.request();
    expect(await codeOf(w.service.expire(w.tenantA, approval.id))).toBe('approval_not_pending');
    const cancelled = await w.service.cancel(w.tenantA, approval.id, 'execution_ended');
    expect(cancelled.status).toBe('cancelled');
    expect(await codeOf(w.service.approve(w.tenantA, approval.id))).toBe('approval_not_pending');
    expect(await w.events('tool.approval_cancelled')).toEqual([
      expect.objectContaining({ reason: 'execution_ended' }),
    ]);
  });

  it('lists newest first, and stores nothing of the input but its digest', async () => {
    const w = await world();
    await w.request();
    w.advance(1);
    const second = await w.request({ nodeId: 'other' as ExecutionNodeId });
    const listed = await w.service.list(w.tenantA);
    expect(listed.map((a) => a.id)[0]).toBe(second.id);
    expect(JSON.stringify(listed)).not.toContain('team');
  });

  it('refuses a malformed stored record instead of repairing it', async () => {
    const w = await world();
    const approval = await w.request();
    w.repository.put({ ...approval, status: 'maybe' as never });
    expect(await codeOf(w.service.get(w.tenantA, approval.id))).toBe('invalid_approval');
  });
});
