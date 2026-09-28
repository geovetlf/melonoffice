import { applySpecialistStatus, newSpecialist } from '@melonoffice/specialists';
import { DEFAULT_DEPARTMENT_CATALOGUE, departmentIdOf } from '@melonoffice/departments';
import type {
  Department,
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistStatus,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { migrateDepartmentCatalogue } from './department-migration.js';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The department catalogue migration (ADR-0047): organizations created with the seven D-11
 * departments keep everything, Design & Video is archived and its agents move to Marketing.
 */

const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
const NOW = new Date('2026-09-28T10:00:00.000Z');
const MISSING = '99999999-9999-4999-8999-999999999999';

const dep = (org: OrganizationId, type: string) => departmentIdOf(org, type as DepartmentTypeId);

describe.each(STORES)(
  'department catalogue migration with storage in %s',
  (_name, createStores) => {
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

      /** A department of the retired type, as every organization created before ADR-0047 has. */
      const legacyDesign = async (org: OrganizationId, status: Department['status'] = 'active') => {
        const department: Department = {
          id: dep(org, 'design_video'),
          organizationId: org,
          origin: {
            kind: 'catalog',
            typeId: 'design_video' as DepartmentTypeId,
            typeVersion: 1,
          },
          status,
          revision: 1,
          createdAt: AT,
          updatedAt: AT,
        };
        await stores.putStructure(department);
        return department;
      };

      /** A specialist in a department, created the way the operator seed does, then moved to `status`. */
      const seed = async (
        org: OrganizationId,
        department: Department,
        status: SpecialistStatus,
      ): Promise<Specialist> => {
        const write = newSpecialist(
          {
            organizationId: org,
            displayName: 'Lucía',
            configuration: {
              departmentId: department.id,
              mainRoleId: 'designer',
              roleVersion: 1,
              purpose: 'Design pieces',
              capabilities: ['layout'],
              skills: [],
              tools: [],
              permissions: ['organization.read'],
              policies: {},
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
        migrateDepartmentCatalogue({
          catalogue: DEFAULT_DEPARTMENT_CATALOGUE,
          store: stores.departmentMigration,
          users: stores.users,
          approvedBy: aliceId,
          apply,
          now: () => NOW,
          ...(organizationId === undefined ? {} : { organizationId }),
        });
      const find = (org: OrganizationId, type: string) =>
        stores.departments.find(org, dep(org, type));
      const specialist = async (org: OrganizationId, s: Specialist) =>
        stores.specialists.find(org, s.identity.id);
      const migrationEvents = async () =>
        (await stores.auditEvents()).filter(
          (e) => e.action === 'department.archived' || e.action === 'specialist.department_changed',
        );
      return {
        ...ctx,
        stores,
        aliceId,
        orgA,
        orgB,
        legacyDesign,
        seed,
        run,
        find,
        specialist,
        migrationEvents,
      };
    }

    it('new organizations get the six departments and nothing to migrate', async () => {
      const t = await setup();
      const departments = await t.stores.departments.list(t.orgA);
      expect(
        departments.map((d) => (d.origin.kind === 'catalog' ? d.origin.typeId : '')).sort(),
      ).toEqual(['finance', 'leadership', 'marketing', 'operations', 'research', 'sales']);
      expect(await t.run(true)).toEqual([]);
      expect(await t.migrationEvents()).toEqual([]);
    });

    it('a dry run reports what it would change, and writes nothing', async () => {
      const t = await setup();
      const design = await t.legacyDesign(t.orgA);
      const lucia = await t.seed(t.orgA, design, 'active');
      expect(await t.run(false)).toEqual([
        {
          organizationId: t.orgA,
          status: 'planned',
          archived: [design.id],
          specialistsMoved: 1,
        },
      ]);
      expect((await t.find(t.orgA, 'design_video'))?.status).toBe('active');
      expect((await t.specialist(t.orgA, lucia))?.configuration.departmentId).toBe(design.id);
      expect(await t.migrationEvents()).toEqual([]);
    });

    it('archives Design & Video, moves its agents to Marketing as new versions, and deletes nothing', async () => {
      const t = await setup();
      const design = await t.legacyDesign(t.orgA);
      const active = await t.seed(t.orgA, design, 'active');
      const draft = await t.seed(t.orgA, design, 'draft');
      const paused = await t.seed(t.orgA, design, 'paused');
      const archived = await t.seed(t.orgA, design, 'archived');

      expect(await t.run(true)).toEqual([
        { organizationId: t.orgA, status: 'migrated', archived: [design.id], specialistsMoved: 3 },
      ]);

      // The department is kept, archived, one revision later: history, never deleted.
      const after = await t.find(t.orgA, 'design_video');
      expect(after).toMatchObject({ status: 'archived', revision: 2, createdAt: AT });
      const marketing = dep(t.orgA, 'marketing');
      for (const before of [active, draft, paused]) {
        const moved = await t.specialist(t.orgA, before);
        // Same identity and status; the move is a new configuration version.
        expect(moved).toMatchObject({
          identity: before.identity,
          status: before.status,
          version: before.version + 1,
          configuration: { ...before.configuration, departmentId: marketing },
        });
        // The version it had before is still there, unchanged.
        const earlier = await t.stores.specialists.findVersion(
          t.orgA,
          before.identity.id,
          before.version,
        );
        expect(earlier?.configuration.departmentId).toBe(design.id);
        const next = await t.stores.specialists.findVersion(
          t.orgA,
          before.identity.id,
          before.version + 1,
        );
        expect(next).toMatchObject({
          createdBy: t.aliceId,
          configuration: { departmentId: marketing },
        });
      }
      // An archived specialist is history: it stays where it was.
      expect(await t.specialist(t.orgA, archived)).toEqual(archived);

      const events = await t.migrationEvents();
      expect(events.map((e) => e.action).sort()).toEqual([
        'department.archived',
        'specialist.department_changed',
        'specialist.department_changed',
        'specialist.department_changed',
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          organizationId: t.orgA,
          result: 'success',
          actor: { type: 'user', userId: t.aliceId, via: 'direct' },
          reason: 'department_type_retired',
        });
      }
      expect(events.find((e) => e.action === 'department.archived')).toMatchObject({
        target: { type: 'department', id: design.id },
        reference: `merged_into:${marketing}`,
      });
    });

    it('is idempotent: a second run changes nothing and records nothing', async () => {
      const t = await setup();
      const design = await t.legacyDesign(t.orgA);
      await t.seed(t.orgA, design, 'active');
      await t.run(true);
      const events = (await t.migrationEvents()).length;
      expect(await t.run(true)).toEqual([{ organizationId: t.orgA, status: 'unchanged' }]);
      expect(await t.migrationEvents()).toHaveLength(events);
    });

    it('keeps organizations apart: each is migrated with its own records only', async () => {
      const t = await setup();
      const designA = await t.legacyDesign(t.orgA);
      const designB = await t.legacyDesign(t.orgB);
      const inA = await t.seed(t.orgA, designA, 'active');
      const inB = await t.seed(t.orgB, designB, 'active');

      // Limited to A: B is not touched.
      expect(await t.run(true, t.orgA)).toEqual([
        { organizationId: t.orgA, status: 'migrated', archived: [designA.id], specialistsMoved: 1 },
      ]);
      expect((await t.find(t.orgB, 'design_video'))?.status).toBe('active');
      expect((await t.specialist(t.orgB, inB))?.configuration.departmentId).toBe(designB.id);
      // A's agent moved to A's Marketing, never to another organization's.
      expect((await t.specialist(t.orgA, inA))?.configuration.departmentId).toBe(
        dep(t.orgA, 'marketing'),
      );

      expect(await t.run(true)).toEqual(
        [
          { organizationId: t.orgA, status: 'unchanged' },
          {
            organizationId: t.orgB,
            status: 'migrated',
            archived: [designB.id],
            specialistsMoved: 1,
          },
        ].sort((a, b) => (a.organizationId < b.organizationId ? -1 : 1)),
      );
      expect((await t.specialist(t.orgB, inB))?.configuration.departmentId).toBe(
        dep(t.orgB, 'marketing'),
      );
      for (const event of await t.migrationEvents()) {
        const org =
          event.target?.id.startsWith(t.orgA) || event.reference?.includes(t.orgA)
            ? t.orgA
            : t.orgB;
        expect(event.organizationId).toBe(org);
      }
    });

    it('leaves an organization whose Marketing is not active untouched, for a person to decide', async () => {
      const t = await setup();
      const design = await t.legacyDesign(t.orgA);
      const lucia = await t.seed(t.orgA, design, 'active');
      const marketing = await t.find(t.orgA, 'marketing');
      if (marketing === undefined) throw new Error('no marketing');
      await t.stores.putStructure({ ...marketing, status: 'paused', revision: 2 });

      expect(await t.run(true)).toEqual([
        {
          organizationId: t.orgA,
          status: 'skipped',
          reason: 'merge_target_unavailable',
          department: design.id,
        },
      ]);
      expect((await t.find(t.orgA, 'design_video'))?.status).toBe('active');
      expect(await t.specialist(t.orgA, lucia)).toEqual(lucia);
      expect(await t.migrationEvents()).toEqual([]);
    });

    it('moves the agents of an already archived Design & Video without archiving it again', async () => {
      const t = await setup();
      const design = await t.legacyDesign(t.orgA, 'active');
      const lucia = await t.seed(t.orgA, design, 'paused');
      await t.stores.putStructure({ ...design, status: 'archived', revision: 2 });
      expect(await t.run(true)).toEqual([
        { organizationId: t.orgA, status: 'migrated', archived: [], specialistsMoved: 1 },
      ]);
      expect((await t.find(t.orgA, 'design_video'))?.revision).toBe(2);
      expect((await t.specialist(t.orgA, lucia))?.configuration.departmentId).toBe(
        dep(t.orgA, 'marketing'),
      );
    });

    it('shows an archived Design & Video by its name, and the web leaves it out', async () => {
      const t = await setup();
      await t.legacyDesign(t.orgA);
      await t.run(true);
      const response = await t.app.request(
        `/v1/organizations/${t.orgA}/departments`,
        t.as('token-alice'),
      );
      const { departments } = (await response.json()) as {
        departments: { typeId: string; status: string; nameKey: string | null }[];
      };
      expect(departments.find((d) => d.typeId === 'design_video')).toMatchObject({
        status: 'archived',
        nameKey: 'department.design_video.name',
      });
      expect(departments.filter((d) => d.status === 'active')).toHaveLength(6);
    });

    it('needs a MelonOffice user to approve it', async () => {
      const t = await setup();
      await t.legacyDesign(t.orgA);
      const refused = (approvedBy: unknown) =>
        migrateDepartmentCatalogue({
          catalogue: DEFAULT_DEPARTMENT_CATALOGUE,
          store: t.stores.departmentMigration,
          users: t.stores.users,
          approvedBy,
          apply: true,
        }).catch((e: { code?: string }) => e.code);
      expect(await refused(undefined)).toBe('invalid_input');
      expect(await refused('not-a-user')).toBe('invalid_input');
      expect(await refused(MISSING)).toBe('approver_not_found');
      expect((await t.find(t.orgA, 'design_video'))?.status).toBe('active');
    });
  },
);
