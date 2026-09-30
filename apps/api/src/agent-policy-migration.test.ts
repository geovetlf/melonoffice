import { AGENT_TASK_POLICY_REF, CONVERSATION_AGENT_POLICY_REF } from '@melonoffice/ai-vertex';
import { DEFAULT_DEPARTMENT_CATALOGUE, departmentIdOf } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistPolicies,
  SpecialistStatus,
  UserId,
} from '@melonoffice/domain';
import { HARNESS_CONVERSATION_POLICY_REF, HARNESS_TASK_POLICY_REF } from '@melonoffice/harness';
import { applySpecialistStatus, newSpecialist } from '@melonoffice/specialists';
import { describe, expect, it } from 'vitest';
import { migrateAgentPolicies } from './agent-policy-migration.js';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The agent policy migration (ADR-0100): every existing agent through the Melon Agent Harness,
 * as a new configuration version, with nothing else changed and nothing deleted.
 */

const AT = '2026-09-29T12:00:00.000Z' as IsoTimestamp;

/** Outcomes come in organization id order, which the test does not choose. */
const byOrganization = <T extends { readonly organizationId: string }>(list: readonly T[]) =>
  [...list].sort((a, b) => (a.organizationId < b.organizationId ? -1 : 1));
const NOW = new Date('2026-09-30T10:00:00.000Z');

describe.each(STORES)('agent policy migration with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const ctx = setupApp(stores);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
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

    const seed = async (
      org: OrganizationId,
      policies: SpecialistPolicies,
      status: SpecialistStatus = 'active',
    ): Promise<Specialist> => {
      const department = await stores.departments.find(
        org,
        departmentIdOf(org, 'sales' as DepartmentTypeId),
      );
      if (department === undefined) throw new Error('no sales department');
      const write = newSpecialist(
        {
          organizationId: org,
          displayName: 'Lucía',
          configuration: {
            departmentId: department.id,
            mainRoleId: 'commercial_agent',
            roleVersion: 1,
            purpose: 'Follow up on customers',
            capabilities: [],
            skills: [],
            tools: [],
            permissions: ['organization.read'],
            policies,
          },
        },
        department,
        aliceId,
        AT,
      );
      await stores.specialists.create(write);
      let current = write.specialist;
      const path: SpecialistStatus[] =
        status === 'draft' ? [] : status === 'active' ? ['active'] : ['active', status];
      for (const to of path) {
        current = await stores.specialists.update(org, current.identity.id, (s) =>
          applySpecialistStatus(s, { from: s.status, to }, AT),
        );
      }
      return current;
    };
    const run = (apply: boolean, organizationId?: OrganizationId) =>
      migrateAgentPolicies({
        catalogue: DEFAULT_DEPARTMENT_CATALOGUE,
        store: stores.departmentMigration,
        users: stores.users,
        approvedBy: aliceId,
        apply,
        now: () => NOW,
        ...(organizationId === undefined ? {} : { organizationId }),
      });
    const find = (org: OrganizationId, s: Specialist) =>
      stores.specialists.find(org, s.identity.id);
    const events = async () =>
      (await stores.auditEvents()).filter((e) => e.action === 'specialist.model_policy_changed');
    return { stores, aliceId, orgA, orgB, seed, run, find, events };
  }

  it('a dry run reports the agents it would move, and writes nothing', async () => {
    const t = await setup();
    const task = await t.seed(t.orgA, { model: AGENT_TASK_POLICY_REF });
    expect(byOrganization(await t.run(false))).toEqual(
      byOrganization([
        { organizationId: t.orgA, status: 'planned', agentsMoved: 1 },
        { organizationId: t.orgB, status: 'unchanged' },
      ]),
    );
    expect(await t.find(t.orgA, task)).toEqual(task);
    expect(await t.events()).toEqual([]);
  });

  it('moves every agent that is not archived to the Harness policy, as a new version, once', async () => {
    const t = await setup();
    const task = await t.seed(t.orgA, { model: AGENT_TASK_POLICY_REF });
    const draft = await t.seed(t.orgA, { model: AGENT_TASK_POLICY_REF }, 'draft');
    const paused = await t.seed(t.orgA, { model: AGENT_TASK_POLICY_REF }, 'paused');
    const conversation = await t.seed(t.orgB, { model: CONVERSATION_AGENT_POLICY_REF });
    const archived = await t.seed(t.orgA, { model: AGENT_TASK_POLICY_REF }, 'archived');
    const already = await t.seed(t.orgA, { model: HARNESS_TASK_POLICY_REF });

    expect(byOrganization(await t.run(true))).toEqual(
      byOrganization([
        { organizationId: t.orgA, status: 'migrated', agentsMoved: 3 },
        { organizationId: t.orgB, status: 'migrated', agentsMoved: 1 },
      ]),
    );
    for (const [org, before, to] of [
      [t.orgA, task, HARNESS_TASK_POLICY_REF],
      [t.orgA, draft, HARNESS_TASK_POLICY_REF],
      [t.orgA, paused, HARNESS_TASK_POLICY_REF],
      [t.orgB, conversation, HARNESS_CONVERSATION_POLICY_REF],
    ] as const) {
      // Same identity, status and everything else; only the model policy, as a new version.
      expect(await t.find(org, before)).toMatchObject({
        identity: before.identity,
        status: before.status,
        version: before.version + 1,
        configuration: { ...before.configuration, policies: { model: to } },
      });
      // The earlier version is still there, unchanged.
      const earlier = await t.stores.specialists.findVersion(
        org,
        before.identity.id,
        before.version,
      );
      expect(earlier?.configuration.policies).toEqual(before.configuration.policies);
    }
    // History and agents already on the Harness stay as they are.
    expect(await t.find(t.orgA, archived)).toEqual(archived);
    expect(await t.find(t.orgA, already)).toEqual(already);

    const events = await t.events();
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event).toMatchObject({
        result: 'success',
        actor: { type: 'user', userId: t.aliceId },
        reason: 'harness_policy_migration',
      });
      expect(event.reference).toMatch(/^policy:(agent_task|conversation_agent):2$/);
    }
    // Again: nothing left to move.
    expect(byOrganization(await t.run(true))).toEqual(
      byOrganization([
        { organizationId: t.orgA, status: 'unchanged' },
        { organizationId: t.orgB, status: 'unchanged' },
      ]),
    );
    expect(await t.events()).toHaveLength(4);
  });

  it('refuses an approver who is not a MelonOffice user, and a malformed organization', async () => {
    const t = await setup();
    await expect(
      migrateAgentPolicies({
        catalogue: DEFAULT_DEPARTMENT_CATALOGUE,
        store: t.stores.departmentMigration,
        users: t.stores.users,
        approvedBy: '99999999-9999-4999-8999-999999999999',
        apply: true,
      }),
    ).rejects.toMatchObject({ code: 'approver_not_found' });
    await expect(
      migrateAgentPolicies({
        catalogue: DEFAULT_DEPARTMENT_CATALOGUE,
        store: t.stores.departmentMigration,
        users: t.stores.users,
        approvedBy: t.aliceId,
        apply: false,
        organizationId: '../x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
