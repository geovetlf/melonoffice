import type { ExecutionId, OrganizationId } from '@melonoffice/domain';
import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Agent Engine AE-4 over HTTP (ADR-0115): pausing or disabling an agent stops its work in
 * progress, activation names what is missing, and the agents' list comes one page at a time.
 * Every case runs on memory and, in CI, on the Firestore emulator.
 */

interface Body {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly error?: string;
  readonly field?: string | null;
  readonly status?: string;
  readonly organization?: { readonly id: string };
  readonly specialists?: readonly { readonly id: string; readonly displayName: string }[];
  readonly nextCursor?: string | null;
  readonly problems?: readonly Record<string, string>[];
}

describe.each(STORES)('agent lifecycle with storage in %s', (_name, createStores) => {
  async function setup(options: { readonly without?: readonly Permission[] } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.without === undefined
        ? undefined
        : createAuthorizationService({
            ...ROLES,
            owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
          }),
    );
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(token, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    const orgOf = async (token: string, name: string) =>
      (await call(token, 'POST', '/v1/organizations', { name })).body.organization?.id as string;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}`;
    const create = async (
      displayName = 'Lucía',
      templateId = 'commercial',
      token = 'token-alice',
      org = orgA,
    ) =>
      (await call(token, 'POST', `${base(org)}/specialists`, { templateId, displayName })).body
        .id as string;
    const activate = (id: string, token = 'token-alice', org = orgA) =>
      call(token, 'POST', `${base(org)}/specialists/${id}/status`, { from: 'draft', to: 'active' });
    const task = async (id: string, token = 'token-alice', org = orgA) =>
      (
        await call(token, 'POST', `${base(org)}/specialists/${id}/tasks`, {
          request: 'Resume las oportunidades abiertas',
        })
      ).body.id as string;
    const execution = (org: string, id: string) =>
      stores.executions.find(org as OrganizationId, id as ExecutionId);
    return { ...ctx, stores, call, orgA, orgB, base, create, activate, task, execution };
  }

  describe('stopping an agent (AE-4.1)', () => {
    it('pausing cancels its tasks in progress, says why, and spares every other agent', async () => {
      const t = await setup();
      const lucia = await t.create('Lucía');
      const pedro = await t.create('Pedro');
      await t.activate(lucia);
      await t.activate(pedro);
      const first = await t.task(lucia);
      const second = await t.task(lucia);
      const others = await t.task(pedro);
      // Bob's agent in his own organization.
      const bobAgent = await t.create('Bea', 'commercial', 'token-bob', t.orgB);
      await t.activate(bobAgent, 'token-bob', t.orgB);
      const bobs = await t.task(bobAgent, 'token-bob', t.orgB);

      const paused = await t.call(
        'token-alice',
        'POST',
        `${t.base(t.orgA)}/specialists/${lucia}/status`,
        { from: 'active', to: 'paused', reason: 'Vacaciones del equipo' },
      );
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('paused');
      expect(paused.body.lastStatusChange).toMatchObject({
        from: 'active',
        to: 'paused',
        reason: 'Vacaciones del equipo',
      });

      for (const id of [first, second]) {
        const stopped = await t.execution(t.orgA, id);
        expect(stopped?.status).toBe('cancelled');
        expect(stopped?.cancellation?.reason).toBe('agent_paused');
        const read = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/agent-tasks/${id}`);
        expect(read.body.status).toBe('cancelled');
      }
      expect((await t.execution(t.orgA, others))?.status).toBe('running');
      expect((await t.execution(t.orgB, bobs))?.status).toBe('running');

      // A paused agent takes no new task; active again, it does.
      const refused = await t.call(
        'token-alice',
        'POST',
        `${t.base(t.orgA)}/specialists/${lucia}/tasks`,
        { request: 'Otra' },
      );
      expect(refused.status).toBe(409);
      await t.call('token-alice', 'POST', `${t.base(t.orgA)}/specialists/${lucia}/status`, {
        from: 'paused',
        to: 'active',
      });
      expect((await t.execution(t.orgA, await t.task(lucia)))?.status).toBe('running');
    });

    it('disabling needs a reason, keeps it, and cancels its tasks in progress', async () => {
      const t = await setup();
      const lucia = await t.create();
      await t.activate(lucia);
      const running = await t.task(lucia);
      const path = `${t.base(t.orgA)}/specialists/${lucia}/status`;
      const bare = await t.call('token-alice', 'POST', path, { from: 'active', to: 'disabled' });
      expect(bare).toEqual({ status: 400, body: { error: 'invalid_specialist', field: 'reason' } });
      expect((await t.execution(t.orgA, running))?.status).toBe('running');

      const disabled = await t.call('token-alice', 'POST', path, {
        from: 'active',
        to: 'disabled',
        reason: 'Respuestas fuera de tono',
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body.lastStatusChange).toMatchObject({ reason: 'Respuestas fuera de tono' });
      expect((await t.execution(t.orgA, running))?.cancellation?.reason).toBe('agent_disabled');
      const read = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/specialists/${lucia}`);
      expect(read.body.status).toBe('disabled');
    });

    it("never reaches another organization's agent", async () => {
      const t = await setup();
      const lucia = await t.create();
      await t.activate(lucia);
      const running = await t.task(lucia);
      const theirs = await t.call(
        'token-bob',
        'POST',
        `${t.base(t.orgB)}/specialists/${lucia}/status`,
        { from: 'active', to: 'paused' },
      );
      expect(theirs.status).toBe(404);
      expect((await t.execution(t.orgA, running))?.status).toBe('running');
    });
  });

  describe('activation readiness (AE-4.2)', () => {
    it('refuses to activate an agent that needs access the person lacks, naming it', async () => {
      const t = await setup({ without: ['opportunity.read'] });
      const lucia = await t.create();
      const refused = await t.activate(lucia);
      expect(refused).toEqual({
        status: 409,
        body: {
          error: 'specialist_not_ready',
          problems: [{ kind: 'permission_not_held', permission: 'opportunity.read' }],
        },
      });
      const read = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/specialists/${lucia}`);
      expect(read.body.status).toBe('draft');
    });

    it('activates an agent that has what it needs', async () => {
      const t = await setup();
      const lucia = await t.create();
      expect((await t.activate(lucia)).status).toBe(200);
    });
  });

  describe('pagination (AE-4.3)', () => {
    it('answers one page at a time, with filters, and the whole list only without parameters', async () => {
      const t = await setup();
      const names = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elena'];
      const ids: string[] = [];
      for (const name of names) ids.push(await t.create(name, 'operations'));
      await t.activate(ids[0] as string);
      await t.activate(ids[1] as string);
      await t.create('Bea', 'operations', 'token-bob', t.orgB);
      const list = `${t.base(t.orgA)}/specialists`;

      const whole = await t.call('token-alice', 'GET', list);
      expect(whole.body.specialists).toHaveLength(5);
      expect(whole.body).not.toHaveProperty('nextCursor');

      const seen: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = await t.call(
          'token-alice',
          'GET',
          `${list}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(page.status).toBe(200);
        expect((page.body.specialists ?? []).length).toBeLessThanOrEqual(2);
        seen.push(...(page.body.specialists ?? []).map((s) => s.id));
        cursor = page.body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(pages).toBe(3);
      expect([...seen].sort()).toEqual([...ids].sort());

      const active = await t.call('token-alice', 'GET', `${list}?status=active`);
      expect(active.body.specialists?.map((s) => s.displayName).sort()).toEqual(['Ana', 'Bruno']);
      const search = await t.call('token-alice', 'GET', `${list}?q=ELENA`);
      expect(search.body.specialists?.map((s) => s.displayName)).toEqual(['Elena']);
      expect(search.body.nextCursor).toBeNull();
      const skill = await t.call('token-alice', 'GET', `${list}?skill=operations_tracking`);
      expect(skill.body.specialists).toHaveLength(5);
    });

    it("refuses malformed parameters and never lists another organization's agents", async () => {
      const t = await setup();
      await t.create('Ana', 'operations');
      const list = `${t.base(t.orgA)}/specialists`;
      for (const [query, field] of [
        ['limit=0', 'limit'],
        ['limit=1000', 'limit'],
        ['status=sleeping', 'status'],
        ['cursor=nope', 'cursor'],
        ['skill=Not%20A%20Skill', 'skill'],
        [`departmentId=${t.orgB}_operations`, 'departmentId'],
      ] as const) {
        expect(await t.call('token-alice', 'GET', `${list}?${query}`)).toEqual({
          status: 400,
          body: { error: 'invalid_specialist', field },
        });
      }
      const bobs = await t.call('token-bob', 'GET', `${t.base(t.orgB)}/specialists?limit=10`);
      expect(bobs.body.specialists).toEqual([]);
      const forbidden = await t.call('token-bob', 'GET', `${list}?limit=10`);
      expect(forbidden.status).toBe(403);
    });
  });
});
