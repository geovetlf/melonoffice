import { createApprovalService } from '@melonoffice/approvals';
import { departmentIdOf } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  Execution,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService } from '@melonoffice/execution';
import { createToolGate } from '@melonoffice/guardrails';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  newSpecialist,
} from '@melonoffice/specialists';
import { resolveTenant, type TenantContext } from '@melonoffice/tenancy';
import { createToolRegistry, type ToolExecutor } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
const MISSING = '99999999-9999-4999-8999-999999999999';
const INPUT = { subject: 'Weekly summary' };

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

/** Test fixtures only: the real catalogue is empty until tools arrive with their phase. */
const tool = (id: string, overrides: Partial<ToolVersion> = {}): ToolDefinition =>
  ({
    id,
    status: 'active',
    versions: [
      {
        toolId: id,
        version: 1,
        nameKey: `tools.${id}.name`,
        descriptionKey: `tools.${id}.description`,
        category: 'test',
        action: 'send',
        mutating: true,
        inputSchema: {
          type: 'object',
          properties: { subject: { type: 'string', maxLength: 200 } },
          required: ['subject'],
        },
        outputSchema: { type: 'object', properties: { sent: { type: 'boolean' } } },
        permissions: ['organization.read'],
        credentials: [{ provider: 'mail_provider', scopes: ['mail.send'] }],
        riskLevel: 'high',
        approvalPolicy: 'approval_required',
        approvalTtlSeconds: 600,
        timeoutMs: 1000,
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        provider: { kind: 'internal', id: 'fixture' },
        environments: ['dev'],
        ...overrides,
      },
    ],
  }) as unknown as ToolDefinition;

const REGISTRY = createToolRegistry([
  tool('send_email'),
  tool('lookup', { riskLevel: 'low', approvalPolicy: 'auto', mutating: false }),
]);

describe.each(STORES)('tools and approvals with storage in %s', (_name, createStores) => {
  async function setup(
    options: { roles?: Record<string, readonly string[]>; pastMinutes?: number } = {},
  ) {
    const stores: Stores = createStores();
    const authorization = createAuthorizationService((options.roles ?? ROLES) as never);
    const ctx = setupApp(stores, authorization, undefined, REGISTRY);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
    const create = async (token: string, name: string) =>
      (
        (await (
          await ctx.app.request(
            '/v1/organizations',
            ctx.as(token, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }),
          )
        ).json()) as { organization: { id: string } }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'A');
    const orgB = await create('token-bob', 'B');
    const call = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const tenantOf = (userId: UserId, org: OrganizationId) =>
      resolveTenant({ actor: 'user', userId, emailVerified: true }, org, stores.tenancy);

    // The server side, as a future planner or worker will use it: never reachable over HTTP.
    const specialists = createSpecialistService({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });
    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
    });
    // Approvals asked in the past, when a test needs one that has already run out.
    const now = () => new Date(Date.now() - (options.pastMinutes ?? 0) * 60_000);
    const calls: unknown[] = [];
    const executor: ToolExecutor = {
      async execute(context) {
        calls.push(context);
        return { status: 'success', output: { sent: true } };
      },
    };
    const gate = createToolGate({
      executions: stores.executions,
      organizations: stores.tenancy,
      specialists,
      departments: stores.departments,
      registry: REGISTRY,
      approvals: createApprovalService({
        repository: stores.approvals,
        organizations: stores.tenancy,
        authorization,
        audit: stores.audit,
        now,
      }),
      executors: { fixture: executor },
      authorization,
      audit: stores.audit,
      environment: 'dev',
      now,
    });

    async function seed(org: OrganizationId, by: UserId): Promise<Specialist> {
      const department = must(
        await stores.departments.find(org, departmentIdOf(org, 'operations' as DepartmentTypeId)),
      );
      const write = newSpecialist(
        {
          organizationId: org,
          displayName: 'Lucía',
          configuration: {
            departmentId: department.id,
            mainRoleId: 'operations_assistant',
            roleVersion: 1,
            capabilities: [],
            skills: [],
            tools: [
              { id: 'send_email', version: 1 },
              { id: 'lookup', version: 1 },
            ],
            permissions: ['organization.read'],
            policies: {},
          } as never,
        },
        department,
        by,
        AT,
      );
      await stores.specialists.create(write);
      return stores.specialists.update(org, write.specialist.identity.id, (s) =>
        applySpecialistStatus(s, { from: 'draft', to: 'active' }, AT),
      );
    }

    async function running(tenant: TenantContext, s: Specialist, toolId = 'send_email') {
      const execution = await executions.create(tenant, {
        mode: 'execute',
        input: { type: 'task', id: 'task-1' },
        specialistId: s.identity.id,
        specialistVersion: s.version,
        departmentId: s.configuration.departmentId,
        versionSnapshot: {
          schemaVersion: 1,
          components: [{ kind: 'specialist', id: s.identity.id, version: '1' }],
        },
        nodes: [{ id: 'n0', type: 'tool', label: 'Send', tool: { id: toolId, version: 1 } }],
      });
      return executions.changeStatus(tenant, execution.id, { from: 'pending', to: 'running' });
    }

    /** Alice's execution, stopped on a pending approval the gate asked for. */
    async function pending() {
      const tenant = await tenantOf(aliceId, orgA);
      const execution = await running(tenant, await seed(orgA, aliceId));
      const result = await gate.invoke(tenant, {
        executionId: execution.id,
        nodeId: 'n0',
        input: INPUT,
      });
      if (result.status !== 'requires_approval') throw new Error(`unexpected ${result.status}`);
      return { tenant, execution, approvalId: result.approvalId };
    }

    const executionOf = async (tenant: TenantContext, execution: Execution) =>
      executions.get(tenant, execution.id);

    return {
      ...ctx,
      stores,
      aliceId,
      bobId,
      orgA,
      orgB,
      call,
      tenantOf,
      gate,
      calls,
      seed,
      running,
      pending,
      executionOf,
    };
  }

  describe('tools', () => {
    it('lists the catalogue and one tool, without schemas, permissions or credentials', async () => {
      const { call, orgA } = await setup();
      const list = await call('token-alice', `/v1/organizations/${orgA}/tools`);
      expect(list.status).toBe(200);
      expect((list.body.tools as { id: string }[]).map((t) => t.id)).toEqual([
        'send_email',
        'lookup',
      ]);
      const one = await call('token-alice', `/v1/organizations/${orgA}/tools/send_email`);
      expect(one.body).toEqual({
        id: 'send_email',
        status: 'active',
        versions: [
          {
            version: 1,
            nameKey: 'tools.send_email.name',
            descriptionKey: 'tools.send_email.description',
            category: 'test',
            action: 'send',
            mutating: true,
            riskLevel: 'high',
            approvalPolicy: 'approval_required',
            environments: ['dev'],
          },
        ],
      });
      expect(JSON.stringify(one.body)).not.toMatch(/mail_provider|inputSchema|permissions/);
      expect((await call('token-alice', `/v1/organizations/${orgA}/tools/unknown`)).status).toBe(
        404,
      );
    });

    it('needs tool.read and membership', async () => {
      const { call, orgA } = await setup({ roles: { owner: ['organization.read'] } });
      expect(await call('token-alice', `/v1/organizations/${orgA}/tools`)).toEqual({
        status: 403,
        body: { error: 'permission_denied' },
      });
      expect((await call('token-bob', `/v1/organizations/${orgA}/tools`)).status).toBe(403);
    });

    it('has no route that runs a tool', async () => {
      const { call, orgA } = await setup();
      for (const path of ['tools/execute', 'tools/send_email/execute', 'tools/send_email/run']) {
        const response = await call('token-alice', `/v1/organizations/${orgA}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(INPUT),
        });
        expect(response.status).toBe(404);
      }
      expect(
        (await call('token-alice', `/v1/organizations/${orgA}/tools`, { method: 'POST' })).status,
      ).toBe(404);
    });
  });

  describe('approvals', () => {
    it('stores the approval the gate asked for, and shows it without its digests', async () => {
      const { call, orgA, pending } = await setup();
      const { approvalId, execution } = await pending();
      const list = await call('token-alice', `/v1/organizations/${orgA}/approvals`);
      expect(list.status).toBe(200);
      expect(list.body.approvals).toHaveLength(1);
      const one = await call('token-alice', `/v1/organizations/${orgA}/approvals/${approvalId}`);
      expect(one.body).toMatchObject({
        id: approvalId,
        status: 'pending',
        riskLevel: 'high',
        reason: 'approval_required',
        impact: 'changes_data',
        executionId: execution.id,
        nodeId: 'n0',
        tool: { id: 'send_email', version: 1 },
        action: 'send',
        decidedAt: null,
      });
      expect(JSON.stringify(one.body)).not.toMatch(/Digest|revision|Weekly summary/);
    });

    it('approves once over HTTP, and the gate then runs the tool exactly once', async () => {
      const { call, orgA, pending, gate, calls, executionOf, auditEvents } = await setup();
      const { tenant, execution, approvalId } = await pending();
      expect((await executionOf(tenant, execution)).status).toBe('waiting_approval');
      const path = `/v1/organizations/${orgA}/approvals/${approvalId}`;
      const approved = await call('token-alice', `${path}/approve`, { method: 'POST' });
      expect(approved.body).toMatchObject({ status: 'approved' });
      expect(await call('token-alice', `${path}/approve`, { method: 'POST' })).toEqual({
        status: 409,
        body: { error: 'approval_not_pending' },
      });
      expect(await call('token-alice', `${path}/reject`, { method: 'POST' })).toEqual({
        status: 409,
        body: { error: 'approval_not_pending' },
      });
      const invoke = () =>
        gate.invoke(tenant, { executionId: execution.id, nodeId: 'n0', input: INPUT });
      expect(await invoke()).toMatchObject({ status: 'success', output: { sent: true } });
      expect(await invoke()).toEqual({ status: 'denied', code: 'node_not_pending' });
      expect(calls).toHaveLength(1);
      const stored = await executionOf(tenant, execution);
      expect(stored.status).toBe('running');
      expect(stored.nodes[0]).toMatchObject({ status: 'completed', approvalId });
      const actions = (await auditEvents()).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'tool.approval_requested',
          'tool.approval_approved',
          'tool.authorization_checked',
          'tool.execution_requested',
          'tool.execution_completed',
          'tool.execution_denied',
        ]),
      );
      const completed = (await auditEvents()).find((e) => e.action === 'tool.execution_completed');
      expect(completed).toMatchObject({
        tool: { id: 'send_email', version: 1 },
        organizationId: orgA,
      });
    });

    it('rejects once, and the gate then refuses the tool', async () => {
      const { call, orgA, pending, gate, calls } = await setup();
      const { tenant, execution, approvalId } = await pending();
      const path = `/v1/organizations/${orgA}/approvals/${approvalId}`;
      expect((await call('token-alice', `${path}/reject`, { method: 'POST' })).body).toMatchObject({
        status: 'rejected',
      });
      expect((await call('token-alice', `${path}/approve`, { method: 'POST' })).status).toBe(409);
      expect(
        await gate.invoke(tenant, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
      ).toEqual({ status: 'denied', code: 'approval_rejected' });
      expect(calls).toHaveLength(0);
    });

    it('refuses to approve after expiry', async () => {
      const { call, orgA, pending } = await setup({ pastMinutes: 30 });
      const { approvalId } = await pending();
      const path = `/v1/organizations/${orgA}/approvals/${approvalId}`;
      expect(await call('token-alice', `${path}/approve`, { method: 'POST' })).toEqual({
        status: 409,
        body: { error: 'approval_expired' },
      });
      expect((await call('token-alice', path)).body).toMatchObject({ status: 'expired' });
    });

    it('needs approval.approve to decide, and approval.read to see', async () => {
      const { call, orgA, pending } = await setup({
        roles: {
          owner: ROLES.owner.filter((p) => p !== 'approval.approve' && p !== 'approval.read'),
        },
      });
      const { approvalId } = await pending();
      const path = `/v1/organizations/${orgA}/approvals/${approvalId}`;
      for (const [method, suffix] of [
        ['POST', '/approve'],
        ['POST', '/reject'],
        ['GET', ''],
      ] as const) {
        expect(await call('token-alice', `${path}${suffix}`, { method })).toEqual({
          status: 403,
          body: { error: 'permission_denied' },
        });
      }
    });

    it("answers another organization's approval exactly like a missing one", async () => {
      const { call, orgA, orgB, pending } = await setup();
      const { approvalId } = await pending();
      // Bob, in his own organization, names Alice's approval: not found, like any unknown id.
      for (const id of [approvalId, MISSING, 'not-a-uuid']) {
        const path = `/v1/organizations/${orgB}/approvals/${id}`;
        expect(await call('token-bob', path)).toEqual({
          status: 404,
          body: { error: 'approval_not_found' },
        });
        expect((await call('token-bob', `${path}/approve`, { method: 'POST' })).status).toBe(404);
      }
      // Bob in Alice's organization: tenancy refuses him before anything is read.
      expect(
        (
          await call('token-bob', `/v1/organizations/${orgA}/approvals/${approvalId}/approve`, {
            method: 'POST',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('token-alice', `/v1/organizations/${orgA}/approvals/${approvalId}`)).body,
      ).toMatchObject({ status: 'pending' });
    });

    it('18–20. ignores an organization in the body, query or headers', async () => {
      const { call, orgA, orgB, pending } = await setup();
      const { approvalId } = await pending();
      const response = await call(
        'token-bob',
        `/v1/organizations/${orgB}/approvals/${approvalId}/approve?organizationId=${orgA}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-organization-id': orgA,
            'x-tenant-id': orgA,
          },
          body: JSON.stringify({ organizationId: orgA, tenantId: orgA, approved: true }),
        },
      );
      expect(response).toEqual({ status: 404, body: { error: 'approval_not_found' } });
      const list = await call(
        'token-bob',
        `/v1/organizations/${orgB}/approvals?organizationId=${orgA}`,
        { headers: { 'x-organization-id': orgA } },
      );
      expect(list.body).toEqual({ approvals: [] });
      expect(
        (await call('token-alice', `/v1/organizations/${orgA}/approvals/${approvalId}`)).body,
      ).toMatchObject({ status: 'pending' });
    });

    it('runs a low-risk tool with no approval at all', async () => {
      const { seed, running, tenantOf, aliceId, orgA, gate, call } = await setup();
      const tenant = await tenantOf(aliceId, orgA);
      const execution = await running(tenant, await seed(orgA, aliceId), 'lookup');
      expect(
        (await gate.invoke(tenant, { executionId: execution.id, nodeId: 'n0', input: INPUT }))
          .status,
      ).toBe('success');
      expect((await call('token-alice', `/v1/organizations/${orgA}/approvals`)).body).toEqual({
        approvals: [],
      });
    });
  });
});
