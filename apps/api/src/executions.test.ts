import type { OrganizationId, UserId } from '@melonoffice/domain';
import {
  createExecutionService,
  type ExecutionRequest,
  type ExecutionService,
} from '@melonoffice/execution';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import { resolveTenant, type TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

interface View {
  organization: { id: string };
}

const MISSING = '99999999-9999-4999-8999-999999999999';
const REQUEST: ExecutionRequest = {
  mode: 'delegate',
  input: { type: 'task', id: 'task-42' },
  versionSnapshot: {
    schemaVersion: 1,
    components: [
      { kind: 'specialist', id: 'spec-research', version: '3' },
      { kind: 'role', id: 'researcher', version: '2' },
      { kind: 'skill', id: 'web_research', version: '5' },
    ],
  },
  nodes: [
    {
      id: 'research',
      type: 'agent',
      label: 'Research the market',
      owner: { kind: 'specialist', id: 'spec-research', version: '3' },
    },
    { id: 'verify', type: 'verification', label: 'Check sources', dependsOn: ['research'] },
  ],
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
}

describe.each(STORES)('executions with storage in %s', (_name, createStores) => {
  async function setup(options: { authorization?: AuthorizationService } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(stores, options.authorization);
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
        ).json()) as View
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'A');
    const orgB = await create('token-bob', 'B');
    const request = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const read = (token: string, org: string, id: string, init: RequestInit = {}) =>
      request(token, `/v1/organizations/${org}/executions/${encodeURIComponent(id)}`, init);
    // Executions are created and moved server side, through the service, on a resolved tenant.
    const service: ExecutionService = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      requestId: 'req-test',
    });
    const tenantOf = (userId: UserId, org: OrganizationId): Promise<TenantContext> =>
      resolveTenant({ actor: 'user', userId, emailVerified: true }, org, stores.tenancy);
    const tenantA = await tenantOf(aliceId, orgA);
    const tenantB = await tenantOf(bobId, orgB);
    const events = async (prefix: string) =>
      (await stores.auditEvents()).filter((e) => e.action.startsWith(prefix));
    return {
      ...ctx,
      stores,
      aliceId,
      bobId,
      orgA,
      orgB,
      request,
      read,
      service,
      tenantOf,
      tenantA,
      tenantB,
      events,
    };
  }

  describe('persistence', () => {
    it('stores and reads an execution with its graph and snapshot', async () => {
      const { service, tenantA, stores, orgA } = await setup();
      const created = await service.create(tenantA, REQUEST);
      expect(await stores.executions.find(orgA, created.id)).toEqual(created);
      expect(await service.get(tenantA, created.id)).toEqual(created);
    });

    it('keeps executions apart by organization, and answers a missing one', async () => {
      const { service, tenantA, tenantB, stores, orgA, orgB } = await setup();
      const created = await service.create(tenantA, REQUEST);
      expect(await stores.executions.find(orgB, created.id)).toBeUndefined();
      expect(await codeOf(service.get(tenantB, created.id))).toBe('execution_not_found');
      expect(await codeOf(service.get(tenantA, MISSING))).toBe('execution_not_found');
      expect(await stores.executions.find(orgA, MISSING as never)).toBeUndefined();
    });

    it('refuses to change an execution through another organization', async () => {
      const { service, tenantA, tenantB, stores, orgB } = await setup();
      const created = await service.create(tenantA, REQUEST);
      expect(
        await codeOf(
          stores.executions.update(orgB, created.id, (current) => ({
            execution: { ...current, revision: current.revision + 1 },
            events: [],
          })),
        ),
      ).toBe('execution_not_found');
      expect(
        await codeOf(service.changeStatus(tenantB, created.id, { from: 'pending', to: 'running' })),
      ).toBe('execution_not_found');
      expect((await service.get(tenantA, created.id)).status).toBe('pending');
    });

    it(
      'lets only one of two concurrent transitions win: verifying never overwrites cancelled',
      { timeout: 30_000 },
      async () => {
        const { service, tenantA, events } = await setup();
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
        expect(results.sort()).toEqual(['accepted', 'execution_concurrency_conflict']);
        const final = await service.get(tenantA, id);
        expect(final.revision).toBe(3);
        const changes = (await events('execution.state_changed')).map((e) => e.transition?.to);
        expect(changes).toEqual(['running', final.status]);
      },
    );

    it('writes nothing when the transition fails partway', async () => {
      const { service, tenantA, stores, orgA, events } = await setup();
      const created = await service.create(tenantA, REQUEST);
      await expect(
        stores.executions.update(orgA, created.id, (current) => {
          void current;
          throw new Error('storage unavailable');
        }),
      ).rejects.toThrow('storage unavailable');
      expect(await stores.executions.find(orgA, created.id)).toEqual(created);
      expect(await events('execution.state_changed')).toEqual([]);
    });

    it('keeps cancelled terminal in storage too', async () => {
      const { service, tenantA } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      await service.changeStatus(tenantA, id, {
        from: 'pending',
        to: 'cancelled',
        reason: 'director_request',
      });
      for (const to of ['running', 'retrying', 'verifying', 'completed'] as const) {
        expect(await codeOf(service.changeStatus(tenantA, id, { from: 'cancelled', to }))).toBe(
          'execution_already_terminal',
        );
      }
      const stored = await service.get(tenantA, id);
      expect(stored.status).toBe('cancelled');
      expect(stored.nodes.every((n) => n.status === 'cancelled')).toBe(true);
    });
  });

  describe('GET /v1/organizations/:organizationId/executions/:executionId', () => {
    it('shows the owner a safe view of their execution', async () => {
      const { read, service, tenantA, orgA, aliceId } = await setup();
      const created = await service.create(tenantA, REQUEST);
      const { status, body } = await read('token-alice', orgA, created.id);
      expect(status).toBe(200);
      expect(body).toEqual({
        id: created.id,
        organizationId: orgA,
        userId: aliceId,
        mode: 'delegate',
        status: 'pending',
        input: { type: 'task', id: 'task-42' },
        currentNodeId: null,
        parentExecutionId: null,
        workflowId: null,
        specialistId: null,
        specialistVersion: null,
        departmentId: null,
        versionSnapshot: REQUEST.versionSnapshot,
        nodes: [
          {
            id: 'research',
            type: 'agent',
            label: 'Research the market',
            status: 'pending',
            dependsOn: [],
            owner: { kind: 'specialist', id: 'spec-research', version: '3' },
            input: null,
            tool: null,
            approvalId: null,
            output: null,
            error: null,
            startedAt: null,
            completedAt: null,
          },
          expect.objectContaining({ id: 'verify', dependsOn: ['research'] }),
        ],
        result: null,
        failure: null,
        cancellation: null,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        startedAt: null,
        completedAt: null,
      });
      expect(JSON.stringify(body)).not.toMatch(/requestId|req-test|revision|token|authorization/i);
    });

    it("never shows another organization's execution, and never says whether it exists", async () => {
      const { read, service, tenantA, orgA, orgB } = await setup();
      const created = await service.create(tenantA, REQUEST);
      const foreign = await read('token-bob', orgB, created.id);
      const missing = await read('token-bob', orgB, MISSING);
      const malformed = await read('token-bob', orgB, 'not-an-id');
      for (const response of [foreign, missing, malformed]) {
        expect(response).toEqual({ status: 404, body: { error: 'execution_not_found' } });
      }
      expect(await read('token-bob', orgA, created.id)).toEqual({
        status: 403,
        body: { error: 'organization_forbidden' },
      });
      expect((await read('token-bob', orgA, MISSING)).status).toBe(403);
    });

    it('ignores organization ids in the query, headers and body', async () => {
      const { request, service, tenantA, tenantB, orgA, orgB } = await setup();
      const ofA = await service.create(tenantA, REQUEST);
      const ofB = await service.create(tenantB, REQUEST);
      const path = (org: string, id: string) => `/v1/organizations/${org}/executions/${id}`;
      const query = await request('token-bob', `${path(orgB, ofA.id)}?organizationId=${orgA}`, {
        headers: { 'x-organization-id': orgA, 'x-tenant-id': orgA },
      });
      expect(query).toEqual({ status: 404, body: { error: 'execution_not_found' } });
      const own = await request('token-bob', `${path(orgB, ofB.id)}?organizationId=${orgA}`, {
        headers: { 'x-organization-id': orgA },
      });
      expect(own.body).toEqual(expect.objectContaining({ id: ofB.id, organizationId: orgB }));
      const body = await request('token-alice', path(orgA, ofA.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgB, status: 'completed' }),
      });
      expect(body.status).toBe(404);
      expect((await service.get(tenantA, ofA.id)).status).toBe('pending');
    });

    it('offers clients no way to create, change or cancel an execution', async () => {
      const { request, service, tenantA, orgA } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      const init = (method: string): RequestInit => ({
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled', mode: 'execute' }),
      });
      for (const [method, path] of [
        ['POST', `/v1/organizations/${orgA}/executions`],
        ['POST', `/v1/organizations/${orgA}/executions/${id}`],
        ['PUT', `/v1/organizations/${orgA}/executions/${id}`],
        ['PATCH', `/v1/organizations/${orgA}/executions/${id}`],
        ['DELETE', `/v1/organizations/${orgA}/executions/${id}`],
        ['POST', `/v1/organizations/${orgA}/executions/${id}/cancel`],
        ['POST', '/v1/executions'],
      ] as const) {
        expect([404, 405]).toContain((await request('token-alice', path, init(method))).status);
      }
      expect((await service.get(tenantA, id)).status).toBe('pending');
    });

    it.each(['suspended', 'revoked'] as const)('refuses a %s membership', async (status) => {
      const { read, put, tenancy, orgA, aliceId, service, tenantA } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      const membership = await tenancy.findMembership(orgA, aliceId);
      if (membership === undefined) throw new Error('missing membership');
      await put({ ...membership, status });
      expect(await read('token-alice', orgA, id)).toEqual({
        status: 403,
        body: { error: 'organization_forbidden' },
      });
    });

    it('refuses no token, an invalid token and an expired token', async () => {
      const { app, orgA, service, tenantA } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      const path = `/v1/organizations/${orgA}/executions/${id}`;
      expect((await app.request(path)).status).toBe(401);
      for (const token of ['forged', 'token-expired']) {
        const response = await app.request(path, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(401);
      }
    });

    it('refuses a member whose role lacks execution.read, and audits it', async () => {
      const { read, orgA, events, service, tenantA } = await setup({
        authorization: createAuthorizationService({ owner: ['organization.read'] }),
      });
      const { id } = await service.create(tenantA, REQUEST);
      expect(await read('token-alice', orgA, id)).toEqual({
        status: 403,
        body: { error: 'permission_denied' },
      });
      expect(await events('authorization.check')).toContainEqual(
        expect.objectContaining({ permission: 'execution.read', reason: 'permission_denied' }),
      );
    });

    it('correlates the read in the logs by request and execution id', async () => {
      const { read, lines, service, tenantA, orgA } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      await read('token-alice', orgA, id, { headers: { 'x-request-id': 'req-read-1' } });
      const line = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.message === 'execution read');
      expect(line).toMatchObject({ requestId: 'req-read-1', executionId: id });
    });
  });

  describe('audit and reconstruction', () => {
    it('records created and state_changed with the execution id and no payloads', async () => {
      const { service, tenantA, aliceId, orgA, events } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      await service.changeStatus(tenantA, id, { from: 'pending', to: 'running' });
      const recorded = await events('execution.');
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'execution.created',
          result: 'success',
          actor: { type: 'user', userId: aliceId, via: 'direct' },
          organizationId: orgA,
          target: { type: 'execution', id },
          requestId: 'req-test',
        }),
        expect.objectContaining({
          action: 'execution.state_changed',
          target: { type: 'execution', id },
          transition: { from: 'pending', to: 'running' },
        }),
      ]);
      for (const event of recorded) {
        expect(JSON.stringify(event)).not.toMatch(
          /task-42|Research the market|web_research|token|bearer|authorization|secret/i,
        );
      }
    });

    it('rebuilds who, what, when, why, agent, plan and result from the records', async () => {
      const { service, tenantA, aliceId, events } = await setup();
      const { id } = await service.create(tenantA, REQUEST);
      await service.changeStatus(tenantA, id, { from: 'pending', to: 'running' });
      await service.changeNode(tenantA, id, { nodeId: 'research', from: 'pending', to: 'running' });
      await service.changeNode(tenantA, id, {
        nodeId: 'research',
        from: 'running',
        to: 'completed',
        output: { type: 'report', id: 'rep-1' },
      });
      await service.changeStatus(tenantA, id, { from: 'running', to: 'verifying' });
      await service.changeNode(tenantA, id, { nodeId: 'verify', from: 'pending', to: 'running' });
      await service.changeNode(tenantA, id, { nodeId: 'verify', from: 'running', to: 'completed' });
      await service.changeStatus(tenantA, id, {
        from: 'verifying',
        to: 'completed',
        result: { type: 'report', id: 'rep-1' },
      });
      const execution = await service.get(tenantA, id);
      const history = (await events('execution.')).filter((e) => e.target?.id === id);
      const story = {
        who: execution.userId,
        what: execution.input,
        when: [execution.createdAt, execution.startedAt, execution.completedAt],
        why: execution.mode,
        agent: execution.nodes.find((n) => n.type === 'agent')?.owner,
        plan: execution.nodes.map((n) => [n.id, n.status]),
        versions: execution.versionSnapshot.components.map((c) => `${c.kind}:${c.id}@${c.version}`),
        result: execution.result,
        verification: execution.nodes.find((n) => n.type === 'verification')?.status,
        path: history.map((e) => e.transition?.to ?? 'created'),
      };
      expect(story).toEqual({
        who: aliceId,
        what: { type: 'task', id: 'task-42' },
        when: [expect.any(String), expect.any(String), expect.any(String)],
        why: 'delegate',
        agent: { kind: 'specialist', id: 'spec-research', version: '3' },
        plan: [
          ['research', 'completed'],
          ['verify', 'completed'],
        ],
        versions: ['specialist:spec-research@3', 'role:researcher@2', 'skill:web_research@5'],
        result: { type: 'report', id: 'rep-1' },
        verification: 'completed',
        path: ['created', 'running', 'verifying', 'completed'],
      });
    });
  });
});
