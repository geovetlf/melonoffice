import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The review of an organization's agents over HTTP (G-1, ADR-0131): read-only, only the reader's
 * own organization, and what the reader may not read is not reviewed but named as skipped.
 */

interface Finding {
  readonly code: string;
  readonly severity: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly recommendation: string;
}
interface Body {
  readonly [key: string]: unknown;
  readonly error?: string;
  readonly organization?: { readonly id: string };
  readonly findings?: readonly Finding[];
  readonly skipped?: readonly string[];
  readonly reviewed?: {
    readonly agents: number;
    readonly workflows: number;
    readonly plans: number;
  };
}

describe.each(STORES)('agent audit with storage in %s', (_name, createStores) => {
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
    const create = async (displayName: string, token = 'token-alice', org = orgA) =>
      (
        await call(token, 'POST', `${base(org)}/specialists`, {
          templateId: 'commercial',
          displayName,
        })
      ).body.id as string;
    const audit = (token = 'token-alice', org = orgA) =>
      call(token, 'GET', `${base(org)}/agents/audit`);
    return { ...ctx, stores, call, orgA, orgB, base, create, audit };
  }

  it('reviews the organization’s agents, workflows and plans, and changes nothing', async () => {
    const t = await setup();
    const lucia = await t.create('Lucía');
    const before = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/specialists/${lucia}`);
    const { status, body } = await t.audit();
    expect(status).toBe(200);
    expect(body.reviewed).toEqual({ agents: 1, workflows: 0, plans: 0 });
    expect(body.skipped).toEqual([]);
    for (const finding of body.findings ?? []) {
      expect(finding.subject).toMatchObject({ type: 'agent', id: lucia });
      expect(['info', 'warning', 'critical']).toContain(finding.severity);
    }
    const after = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/specialists/${lucia}`);
    expect(after.body).toEqual(before.body);
  });

  it('reviews only the reader’s own organization', async () => {
    const t = await setup();
    await t.create('Lucía');
    await t.create('Bea', 'token-bob', t.orgB);
    await t.create('Beto', 'token-bob', t.orgB);
    expect((await t.audit()).body.reviewed?.agents).toBe(1);
    expect((await t.audit('token-bob', t.orgB)).body.reviewed?.agents).toBe(2);
    const foreign = await t.audit('token-alice', t.orgB);
    expect(foreign.status).toBe(403);
    expect(foreign.body.findings).toBeUndefined();
  });

  it('needs specialist.read', async () => {
    const t = await setup({ without: ['specialist.read'] });
    expect((await t.audit()).status).toBe(403);
  });

  it('skips what the reader may not read, and says so', async () => {
    const t = await setup({ without: ['knowledge.read', 'workflow.read', 'plan.read'] });
    await t.create('Lucía');
    const { status, body } = await t.audit();
    expect(status).toBe(200);
    expect(body.skipped).toEqual(['company_brain', 'workflows', 'plans']);
    expect(body.reviewed).toEqual({ agents: 1, workflows: 0, plans: 0 });
  });
});
