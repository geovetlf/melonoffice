import { Query } from '@google-cloud/firestore';
import type {
  AgentAutonomy,
  DepartmentId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { pageOfAgents } from '@melonoffice/specialists';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestoreSpecialistRepository, SPECIALISTS, toSpecialistDocument } from './specialists.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * The search beyond 500 agents, Stage 1 (ADR-0118), on the emulator: a skill is asked with
 * `array-contains-any` over its stored `{id, version}` references and an autonomy level by
 * equality, in id order; a missing index falls back to the reading of AE-4.
 */

const ORG_A = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ORG_B = '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const AT = '2026-10-02T00:00:00.000Z' as IsoTimestamp;
const agentId = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}` as SpecialistId;

function agent(
  n: number,
  organizationId: OrganizationId,
  skills: readonly [string, number][],
  autonomy?: AgentAutonomy,
): Specialist {
  return {
    identity: {
      id: agentId(n),
      displayName: `Agent ${String(n)}`,
      createdAt: AT,
      createdBy: '11111111-1111-4111-8111-111111111111' as UserId,
    },
    organizationId,
    status: n % 2 === 0 ? 'active' : 'draft',
    version: 1,
    configuration: {
      departmentId: `${organizationId}_finance` as DepartmentId,
      mainRoleId: 'finance_analyst' as never,
      roleVersion: 1,
      capabilities: [],
      skills: skills.map(([id, version]) => ({ id: id as never, version })),
      tools: [],
      permissions: [],
      policies: {} as never,
      ...(autonomy === undefined ? {} : { autonomy }),
    },
    revision: 1,
    updatedAt: AT,
  };
}

afterEach(() => vi.restoreAllMocks());

describe.runIf(emulatorHost)('agent search through the index (ADR-0118, emulator)', () => {
  async function seed() {
    const db = emulatorFirestore();
    const rows = [
      ...Array.from({ length: 30 }, (_, i) =>
        agent(
          i + 1,
          ORG_A,
          // Every third agent has the skill, at version 1, 2 or 3; others have another one.
          (i + 1) % 3 === 0
            ? [
                ['finance_review', ((i + 1) % 9) / 3 + 1],
                ['other', 1],
              ]
            : [['other', 1]],
          (i + 1) % 5 === 0 ? 'propose' : undefined,
        ),
      ),
      agent(31, ORG_B, [['finance_review', 1]], 'propose'),
    ];
    await Promise.all(
      rows.map((s) => db.collection(SPECIALISTS).doc(s.identity.id).set(toSpecialistDocument(s))),
    );
    return db;
  }

  const walk = async (
    repository: FirestoreSpecialistRepository,
    organizationId: OrganizationId,
    query: { skill?: string; autonomy?: AgentAutonomy; status?: 'active' | 'draft' },
  ) => {
    const seen: string[] = [];
    let after: SpecialistId | undefined;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await pageOfAgents(repository, organizationId, {
        limit: 2,
        ...query,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map((s) => s.identity.id));
      if (page.nextCursor === null) return seen;
      after = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')).a;
    }
    throw new Error('runaway');
  };

  const ids = (ns: number[]) => ns.map(agentId);
  const SKILLED = ids([3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  const PROPOSE = ids([5, 10, 15, 20, 25, 30]);

  it('asks a skill at any version and an autonomy level of the store, in id order', async () => {
    const repository = new FirestoreSpecialistRepository(await seed());
    const asked: unknown[] = [];
    const page = repository.page.bind(repository);
    repository.page = async (organizationId, request) => {
      asked.push(request.skillRefs ?? request.autonomy ?? null);
      return page(organizationId, request);
    };
    expect(await walk(repository, ORG_A, { skill: 'finance_review' })).toEqual(SKILLED);
    expect(asked.every((a) => Array.isArray(a))).toBe(true);
    expect(await walk(repository, ORG_A, { autonomy: 'propose' })).toEqual(PROPOSE);
    // Combined: the store asks the skill; status and autonomy are checked on what it returns.
    expect(await walk(repository, ORG_A, { skill: 'finance_review', status: 'active' })).toEqual(
      ids([6, 12, 18, 24, 30]),
    );
    expect(await walk(repository, ORG_A, { skill: 'finance_review', autonomy: 'propose' })).toEqual(
      ids([15, 30]),
    );
    // Another organization's agent with the same skill and level is never there.
    expect(await walk(repository, ORG_B, { skill: 'finance_review' })).toEqual(ids([31]));
    expect(await walk(repository, ORG_B, { autonomy: 'propose' })).toEqual(ids([31]));
  });

  it('reads the old way, and logs it, while an index is missing', async () => {
    const missing: string[] = [];
    const repository = new FirestoreSpecialistRepository(await seed(), {
      onIndexMissing: (query) => missing.push(query),
    });
    const real = Query.prototype.get;
    vi.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
      const filters = JSON.stringify(
        (this as unknown as { _queryOptions: { filters: unknown } })._queryOptions.filters,
      );
      if (filters.includes('"skills"') || filters.includes('"autonomy"')) {
        return Promise.reject(
          Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), {
            code: 9,
          }),
        );
      }
      return real.call(this);
    });
    expect(await walk(repository, ORG_A, { skill: 'finance_review' })).toEqual(SKILLED);
    expect(await walk(repository, ORG_A, { autonomy: 'propose' })).toEqual(PROPOSE);
    expect(new Set(missing)).toEqual(new Set(['specialists_skills', 'specialists_autonomy']));
  });

  it('never hides another error as a missing index', async () => {
    const repository = new FirestoreSpecialistRepository(await seed());
    vi.spyOn(Query.prototype, 'get').mockRejectedValue(
      Object.assign(new Error('14 UNAVAILABLE'), { code: 14 }),
    );
    await expect(
      pageOfAgents(repository, ORG_A, { limit: 2, skill: 'finance_review' }),
    ).rejects.toThrow('UNAVAILABLE');
  });
});
