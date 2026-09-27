import type { Firestore } from '@google-cloud/firestore';
import {
  createAuditService,
  InMemoryAuditStore,
  type AuditEvent,
  type AuditStore,
} from '@melonoffice/audit';
import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import { openBilling } from '@melonoffice/billing';
import { openWallet } from '@melonoffice/credits';
import type {
  Execution,
  ExecutionJob,
  JobId,
  Membership,
  Organization,
  UserId,
} from '@melonoffice/domain';
import {
  createExecutionService,
  InMemoryExecutionRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import {
  createJobService,
  InMemoryJobRepository,
  isJobError,
  jobIdFor,
  newJob,
  type JobClaim,
  type JobRepository,
} from '@melonoffice/jobs';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenancyStore,
} from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS, FirestoreAuditStore, fromAuditDocument, type AuditDocument } from './audit.js';
import { FirestoreExecutionRepository } from './executions.js';
import { EXECUTION_JOBS, FirestoreJobRepository, toJob, toJobDocument } from './jobs.js';
import { FirestoreTenancyStore, MEMBERSHIPS } from './tenancy.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const LEASE_MS = 30_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const BILLING = (organization: Organization) =>
  openBilling(organization, { id: 'entrepreneur', version: 1 });
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const SECRET = ['sk', '-live-', 'abcdefghijklmnopqrstuvwxyz0123'].join('');

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

interface Stores {
  readonly tenancy: TenancyStore;
  readonly executions: ExecutionRepository;
  readonly jobs: JobRepository;
  readonly audit: AuditStore;
  readonly events: () => Promise<readonly AuditEvent[]>;
  /** Stores a job record as given, the way tampered or corrupted data would look. */
  readonly putRaw: (id: JobId, record: Record<string, unknown>) => Promise<void>;
  readonly suspend: (membership: Membership) => Promise<void>;
}

function memoryStores(): Stores {
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(() => NOW);
  const jobs = new InMemoryJobRepository(audit);
  return {
    tenancy,
    executions: new InMemoryExecutionRepository(audit),
    jobs,
    audit,
    events: async () => audit.events(),
    putRaw: async (_id, record) => jobs.put(record as unknown as ExecutionJob),
    suspend: async (membership) => tenancy.put({ ...membership, status: 'suspended' }),
  };
}

function firestoreStores(): Stores {
  const db: Firestore = emulatorFirestore();
  return {
    tenancy: new FirestoreTenancyStore(db, () => NOW),
    executions: new FirestoreExecutionRepository(db),
    jobs: new FirestoreJobRepository(db),
    audit: new FirestoreAuditStore(db),
    async events() {
      const snapshot = await db.collection(AUDIT_LOGS).get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
    async putRaw(id, record) {
      await db.collection(EXECUTION_JOBS).doc(id).set(record);
    },
    async suspend(membership) {
      await db.collection(MEMBERSHIPS).doc(membership.id).update({ status: 'suspended' });
    },
  };
}

const STORES: [string, () => Stores][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, () => Stores]] : []),
];

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isJobError(error)) return error.code;
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
}

describe.each(STORES)('execution jobs with storage in %s', (_name, createStores) => {
  async function world() {
    const stores = createStores();
    let clock = new Date(NOW);
    const lines: string[] = [];
    const a = await createOrganization(as(ALICE), { name: 'A' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
    });
    const b = await createOrganization(as(BOB), { name: 'B' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
    });
    const authorization = createAuthorizationService();
    const auditService = createAuditService(stores.audit, () => clock);
    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      authorization,
      audit: auditService,
      now: () => NOW,
    });
    const jobService = createJobService({
      jobs: stores.jobs,
      executions: stores.executions,
      tenancy: stores.tenancy,
      authorization,
      audit: auditService,
      leaseMs: LEASE_MS,
      now: () => clock,
      requestId: 'req-jobs-1',
      logger: createLogger({ service: 'test', sink: (line) => lines.push(line) }),
    });
    const tenantA = await resolveTenant(as(ALICE), a.organization.id, stores.tenancy);
    const tenantB = await resolveTenant(as(BOB), b.organization.id, stores.tenancy);
    const giaA = await resolveTenant(actAsGia(as(ALICE)), a.organization.id, stores.tenancy);
    const runtimeA = await resolveRuntimeTenant(ALICE, a.organization.id, stores.tenancy);
    const runtimeB = await resolveRuntimeTenant(BOB, b.organization.id, stores.tenancy);

    /** A started execution of organization A with two agent nodes. */
    async function running(): Promise<Execution> {
      const created = await executions.create(tenantA, {
        mode: 'execute',
        input: { type: 'task', id: 'task-1' },
        versionSnapshot: {
          schemaVersion: 1,
          components: [{ kind: 'role', id: 'r1', version: '1' }],
        },
        nodes: [
          // Effect free, so a failed attempt may be retried (ADR-0029, rule A).
          { id: 'n0', type: 'verification', label: 'First' },
          { id: 'n1', type: 'agent', label: 'Second' },
        ],
      });
      return executions.start(tenantA, created.id);
    }

    const jobEvents = async () =>
      (await stores.events()).filter((e) => e.action.startsWith('execution.job_'));

    return {
      ...stores,
      a,
      b,
      executions,
      jobService,
      tenantA,
      tenantB,
      giaA,
      runtimeA,
      runtimeB,
      running,
      jobEvents,
      lines,
      advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    };
  }

  it('creates one queued job per node and attempt, with its organization from the execution', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    expect(job).toMatchObject({
      id: jobIdFor(w.a.organization.id, execution.id, 'n0', 1),
      organizationId: w.a.organization.id,
      executionId: execution.id,
      nodeId: 'n0',
      attempt: 1,
      state: 'queued',
      idempotencyKey: `job:${execution.id}:n0:1`,
      correlationId: 'req-jobs-1',
      leaseCount: 0,
      revision: 1,
    });
    expect(job).not.toHaveProperty('lease');
    expect(job).not.toHaveProperty('retryOf');
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(job);
  });

  it('1. lets only one of two concurrent workers take the lease', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const results = await Promise.allSettled([
      w.jobService.acquire(job.id, 'worker-1'),
      w.jobService.acquire(job.id, 'worker-2'),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(isJobError(lost[0]?.reason) && lost[0].reason.code).toBe('job_lease_held');
    const stored = await w.jobService.get(w.tenantA, job.id);
    expect(stored).toMatchObject({ state: 'leased', leaseCount: 1, revision: 2 });
    const leased = (await w.jobEvents()).filter((e) => e.action === 'execution.job_leased');
    expect(leased).toHaveLength(2);
    expect(leased).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: 'success' }),
        expect.objectContaining({ result: 'denied', reason: 'job_lease_held' }),
      ]),
    );
  });

  it('2. refuses a write on an expired lease, and lets another worker take it over', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const first = await w.jobService.acquire(job.id, 'worker-1');
    // Still live: nobody else can take it.
    w.advance(LEASE_MS - 1);
    expect(await codeOf(w.jobService.acquire(job.id, 'worker-2'))).toBe('job_lease_held');
    w.advance(1);
    expect(await codeOf(w.jobService.finish(first, { result: 'succeeded', code: 'done' }))).toBe(
      'job_lease_expired',
    );
    const second = await w.jobService.acquire(job.id, 'worker-2');
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);
    expect(second.job).toMatchObject({ state: 'leased', leaseCount: 2 });
    expect(second.job.lease?.workerId).toBe('worker-2');
  });

  it('3. refuses a write with the wrong lease id, without changing the job', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    const forged: JobClaim = { ...claim, lease: { ...claim.lease, leaseId: randomUUID() } };
    expect(await codeOf(w.jobService.finish(forged, { result: 'succeeded', code: 'done' }))).toBe(
      'job_lease_mismatch',
    );
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(claim.job);
  });

  it('4. refuses a write with the wrong revision, without changing the job', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    for (const revision of [claim.lease.revision - 1, claim.lease.revision + 1]) {
      const stale: JobClaim = { ...claim, lease: { ...claim.lease, revision } };
      expect(await codeOf(w.jobService.finish(stale, { result: 'succeeded', code: 'done' }))).toBe(
        'job_revision_mismatch',
      );
    }
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(claim.job);
  });

  it('5. refuses a claim carrying another organization’s context', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    const other: JobClaim = { ...claim, tenant: w.runtimeB };
    expect(await codeOf(w.jobService.finish(other, { result: 'succeeded', code: 'done' }))).toBe(
      'job_forbidden',
    );
    expect(await codeOf(w.jobService.get(w.tenantB, job.id))).toBe('job_not_found');
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(claim.job);
  });

  it('6. answers a job that does not exist, or a malformed id, as not found', async () => {
    const w = await world();
    for (const id of [randomUUID(), 'not-a-job', '']) {
      expect(await codeOf(w.jobService.acquire(id, 'worker-1'))).toBe('job_not_found');
      expect(await codeOf(w.jobService.get(w.tenantA, id))).toBe('job_not_found');
    }
    expect(await codeOf(w.jobService.acquire(randomUUID(), 'bad worker id'))).toBe('invalid_job');
  });

  it('7. never moves a finished job again', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    const finished = await w.jobService.finish(claim, { result: 'failed', code: 'node_failed' });
    expect(finished).toMatchObject({
      state: 'failed',
      outcome: { code: 'node_failed' },
      finishedAt: NOW.toISOString(),
    });
    expect(await codeOf(w.jobService.acquire(job.id, 'worker-2'))).toBe('job_terminal');
    expect(await codeOf(w.jobService.finish(claim, { result: 'succeeded', code: 'done' }))).toBe(
      'job_terminal',
    );
    // A second enqueue of the same attempt returns the ended job; it never makes a new one.
    expect(
      await codeOf(w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' })),
    ).toBe('accepted');
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(finished);
  });

  it('8. cancels the jobs of an execution that ended, and nobody can take or finish one', async () => {
    const w = await world();
    const execution = await w.running();
    const queued = await w.jobService.enqueue(w.tenantA, {
      executionId: execution.id,
      nodeId: 'n0',
    });
    const other = await w.jobService.enqueue(w.tenantA, {
      executionId: execution.id,
      nodeId: 'n1',
    });
    const claim = await w.jobService.acquire(other.id, 'worker-1');
    // Refused while the execution runs.
    expect(await codeOf(w.jobService.cancelForExecution(w.tenantA, execution.id))).toBe(
      'execution_not_ended',
    );
    await w.executions.cancel(w.tenantA, execution.id, 'user_cancelled');
    // A worker finds the execution ended: the job is cancelled, not run.
    expect(await codeOf(w.jobService.acquire(queued.id, 'worker-2'))).toBe('job_cancelled');
    expect(await w.jobService.get(w.tenantA, queued.id)).toMatchObject({
      state: 'cancelled',
      outcome: { code: 'execution_ended' },
    });
    // The holder's late result is refused.
    expect(await codeOf(w.jobService.finish(claim, { result: 'succeeded', code: 'done' }))).toBe(
      'job_cancelled',
    );
    expect(await w.jobService.get(w.tenantA, other.id)).toMatchObject({ state: 'cancelled' });
    // Cancelling again changes nothing.
    expect(await w.jobService.cancelForExecution(w.tenantA, execution.id)).toEqual([]);
    expect(await codeOf(w.jobService.acquire(other.id, 'worker-3'))).toBe('job_cancelled');
    expect(
      (await w.jobEvents()).filter((e) => e.action === 'execution.job_cancelled'),
    ).toHaveLength(2);
  });

  it('cancelForExecution cancels every unfinished job of an ended execution', async () => {
    const w = await world();
    const execution = await w.running();
    const a = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const b = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n1' });
    await w.executions.cancel(w.tenantA, execution.id, 'user_cancelled');
    const cancelled = await w.jobService.cancelForExecution(w.tenantA, execution.id);
    expect(cancelled.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
    expect(cancelled.every((j) => j.state === 'cancelled')).toBe(true);
    expect(await codeOf(w.jobService.cancelForExecution(w.giaA, execution.id))).toBe(
      'actor_not_allowed',
    );
  });

  it('9. refuses a job whose attempt is not the node’s, and makes a new job for the retry', async () => {
    const w = await world();
    const execution = await w.running();
    const first = await w.jobService.enqueue(w.tenantA, {
      executionId: execution.id,
      nodeId: 'n0',
    });
    await w.executions.runtimeChangeNode(w.runtimeA, execution.id, {
      nodeId: 'n0',
      from: 'pending',
      to: 'running',
    });
    await w.executions.runtimeChangeNode(w.runtimeA, execution.id, {
      nodeId: 'n0',
      from: 'running',
      to: 'failed',
      error: { code: 'model_error' },
    });
    await w.executions.retryNode(w.runtimeA, execution.id, 'n0');
    expect(await codeOf(w.jobService.acquire(first.id, 'worker-1'))).toBe('job_attempt_mismatch');
    expect(await w.jobService.get(w.tenantA, first.id)).toEqual(first);
    const retry = await w.jobService.enqueue(w.runtimeA, {
      executionId: execution.id,
      nodeId: 'n0',
    });
    expect(retry).toMatchObject({ attempt: 2, retryOf: first.id, state: 'queued' });
    expect(retry.id).toBe(jobIdFor(w.a.organization.id, execution.id, 'n0', 2));
    // The attempt is never the caller's to choose.
    expect(
      await codeOf(
        w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0', attempt: 1 }),
      ),
    ).toBe('invalid_job');
    expect(
      (await w.jobEvents()).find(
        (e) => e.action === 'execution.job_leased' && e.reason === 'job_attempt_mismatch',
      ),
    ).toMatchObject({ result: 'denied', job: { id: first.id, attempt: 1 } });
  });

  it('10. creates a job once, however many times it is asked', async () => {
    const w = await world();
    const execution = await w.running();
    const request = { executionId: execution.id, nodeId: 'n0' };
    const first = await w.jobService.enqueue(w.tenantA, request);
    const again = await w.jobService.enqueue(w.runtimeA, request);
    expect(again).toEqual(first);
    expect((await w.jobEvents()).filter((e) => e.action === 'execution.job_enqueued')).toHaveLength(
      1,
    );
  });

  it('11. stores one job for two concurrent creates', async () => {
    const w = await world();
    const execution = await w.running();
    const request = { executionId: execution.id, nodeId: 'n0' };
    const [one, two] = await Promise.all([
      w.jobService.enqueue(w.tenantA, request),
      w.jobService.enqueue(w.tenantA, request),
    ]);
    expect(two).toEqual(one);
    expect((await w.jobEvents()).filter((e) => e.action === 'execution.job_enqueued')).toHaveLength(
      1,
    );
  });

  it('12. never lets another organization read, create, take or cancel a job', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    expect(await codeOf(w.jobService.get(w.tenantB, job.id))).toBe('job_not_found');
    expect(
      await codeOf(w.jobService.enqueue(w.tenantB, { executionId: execution.id, nodeId: 'n1' })),
    ).toBe('execution_not_found');
    expect(await codeOf(w.jobService.cancelForExecution(w.tenantB, execution.id))).toBe(
      'execution_not_found',
    );
    // A worker never names an organization: the stored execution decides whose job it is.
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    expect(claim.tenant).toMatchObject({
      actor: 'runtime',
      userId: ALICE,
      organizationId: w.a.organization.id,
    });
  });

  it('13. refuses the write of a worker that lost its lease to another', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const lost = await w.jobService.acquire(job.id, 'worker-1');
    w.advance(LEASE_MS);
    const current = await w.jobService.acquire(job.id, 'worker-2');
    expect(await codeOf(w.jobService.finish(lost, { result: 'succeeded', code: 'done' }))).toBe(
      'job_lease_mismatch',
    );
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(current.job);
    expect(await w.jobService.finish(current, { result: 'succeeded', code: 'done' })).toMatchObject(
      { state: 'succeeded', outcome: { code: 'done' } },
    );
  });

  it('14. never stores a change to a protected field, nor reads a tampered job', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const tampered: Partial<Record<keyof ExecutionJob, unknown>>[] = [
      { organizationId: w.b.organization.id },
      { executionId: randomUUID() },
      { nodeId: 'n1' },
      { attempt: 2 },
      { idempotencyKey: 'job:other' },
      { correlationId: 'other' },
      { createdAt: '2020-01-01T00:00:00.000Z' },
    ];
    for (const change of tampered) {
      expect(
        await codeOf(
          w.jobs.update(job.id, (current) => ({
            job: { ...current, ...change, revision: current.revision + 1 } as ExecutionJob,
            events: [],
          })),
        ),
      ).toBe('invalid_job');
    }
    // A skipped revision, or a state jump, is refused too.
    expect(
      await codeOf(
        w.jobs.update(job.id, (current) => ({
          job: { ...current, revision: current.revision + 2 },
          events: [],
        })),
      ),
    ).toBe('job_concurrency_conflict');
    expect(
      await codeOf(
        w.jobs.update(job.id, (current) => ({
          job: {
            ...current,
            state: 'succeeded',
            outcome: { code: 'done' },
            revision: current.revision + 1,
          },
          events: [],
        })),
      ),
    ).toBe('invalid_job');
    expect(await w.jobService.get(w.tenantA, job.id)).toEqual(job);
    // A stored job whose attempt was changed no longer matches its id: refused, never used.
    await w.putRaw(job.id, {
      ...(_name === 'memory' ? job : toJobDocument(job)),
      attempt: 2,
    });
    expect(await codeOf(w.jobService.acquire(job.id, 'worker-1'))).toBe('invalid_job');
  });

  it('15. takes no organization, attempt, lease or context from the caller', async () => {
    const w = await world();
    const execution = await w.running();
    for (const extra of [
      { organizationId: w.b.organization.id },
      { userId: BOB },
      { tenant: w.tenantB },
      { lease: { leaseId: randomUUID() } },
      { state: 'leased' },
    ]) {
      expect(
        await codeOf(
          w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0', ...extra }),
        ),
      ).toBe('invalid_job');
    }
    // GIA cannot create jobs; a context copied by hand is not a resolved one.
    expect(
      await codeOf(w.jobService.enqueue(w.giaA, { executionId: execution.id, nodeId: 'n0' })),
    ).toBe('actor_not_allowed');
    expect(
      await codeOf(
        w.jobService.enqueue({ ...w.tenantA }, { executionId: execution.id, nodeId: 'n0' }),
      ),
    ).toBe('unresolved_tenant');
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    // The claim's context must be the runtime one the service issued, for this execution's user.
    for (const tenant of [{ ...claim.tenant }, w.tenantA, w.giaA]) {
      expect(
        await codeOf(w.jobService.finish({ ...claim, tenant }, { result: 'succeeded', code: 'x' })),
      ).toBe('job_forbidden');
    }
    // A user who lost their membership stops the work: no new lease, no finish.
    const next = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n1' });
    await w.suspend(w.a.membership);
    expect(await codeOf(w.jobService.finish(claim, { result: 'succeeded', code: 'x' }))).toBe(
      'job_forbidden',
    );
    expect(await codeOf(w.jobService.acquire(next.id, 'worker-2'))).toBe('job_forbidden');
    expect(await w.jobService.get(w.runtimeB, next.id).catch(() => 'hidden')).toBe('hidden');
  });

  it('16. refuses credentials or payloads anywhere in a job, and never stores or logs one', async () => {
    const w = await world();
    const execution = await w.running();
    for (const extra of [{ credential: SECRET }, { apiKey: SECRET }, { input: { text: SECRET } }]) {
      expect(
        await codeOf(
          w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0', ...extra }),
        ),
      ).toBe('invalid_job');
    }
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    // A finish carries a stable code and a reference at most: no output, no secret.
    for (const outcome of [
      { result: 'succeeded', code: 'done', output: SECRET },
      { result: 'succeeded', code: SECRET },
      { result: 'succeeded', code: 'done', ref: { type: 'doc', id: 'x', token: SECRET } },
    ]) {
      expect(await codeOf(w.jobService.finish(claim, outcome))).toBe('invalid_job');
    }
    // A stored job with a field the model does not know is refused, never used.
    await w.putRaw(job.id, {
      ...(_name === 'memory' ? claim.job : toJobDocument(claim.job)),
      token: SECRET,
    });
    expect(await codeOf(w.jobService.get(w.tenantA, job.id))).toBe('invalid_job');
    expect(JSON.stringify(await w.events())).not.toContain(SECRET);
    expect(w.lines.join('\n')).not.toContain(SECRET);
  });

  it('17. correlates every job event and log line with the job, lease, attempt and request', async () => {
    const w = await world();
    const execution = await w.running();
    const job = await w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' });
    const claim = await w.jobService.acquire(job.id, 'worker-1');
    await w.jobService.finish(claim, { result: 'succeeded', code: 'done' });
    const events = await w.jobEvents();
    const common = {
      organizationId: w.a.organization.id,
      target: { type: 'execution', id: execution.id },
      requestId: 'req-jobs-1',
      source: 'api',
    };
    const byAction = (action: string) => events.find((e) => e.action === action);
    expect(byAction('execution.job_enqueued')).toMatchObject({
      ...common,
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      job: { id: job.id, nodeId: 'n0', attempt: 1 },
    });
    expect(byAction('execution.job_enqueued')?.job).not.toHaveProperty('leaseId');
    const runtime = { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' };
    expect(byAction('execution.job_leased')).toMatchObject({
      ...common,
      result: 'success',
      actor: runtime,
      job: { id: job.id, nodeId: 'n0', attempt: 1, leaseId: claim.lease.leaseId },
    });
    expect(byAction('execution.job_finished')).toMatchObject({
      ...common,
      result: 'success',
      reason: 'done',
      actor: runtime,
      job: { id: job.id, leaseId: claim.lease.leaseId },
    });
    const logged = w.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.find((l) => l.message === 'job leased')).toMatchObject({
      organizationId: w.a.organization.id,
      executionId: execution.id,
      nodeId: 'n0',
      jobId: job.id,
      attempt: 1,
      leaseId: claim.lease.leaseId,
      workerId: 'worker-1',
      correlationId: 'req-jobs-1',
    });
  });

  it('refuses jobs for executions that cannot run, and nodes that are not pending', async () => {
    const w = await world();
    const pending = await w.executions.create(w.tenantA, {
      mode: 'execute',
      input: { type: 'task', id: 'task-2' },
      versionSnapshot: { schemaVersion: 1, components: [{ kind: 'role', id: 'r1', version: '1' }] },
      nodes: [{ id: 'n0', type: 'agent', label: 'Only' }],
    });
    expect(
      await codeOf(w.jobService.enqueue(w.tenantA, { executionId: pending.id, nodeId: 'n0' })),
    ).toBe('execution_not_runnable');
    const execution = await w.running();
    expect(
      await codeOf(w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'nx' })),
    ).toBe('node_not_runnable');
    await w.executions.runtimeChangeNode(w.runtimeA, execution.id, {
      nodeId: 'n0',
      from: 'pending',
      to: 'running',
    });
    expect(
      await codeOf(w.jobService.enqueue(w.tenantA, { executionId: execution.id, nodeId: 'n0' })),
    ).toBe('node_not_runnable');
  });
});

describe.runIf(emulatorHost)('FirestoreJobRepository (emulator)', () => {
  it('stores a job as flat pointers and reads it back unchanged', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreJobRepository(db);
    const organizationId = randomUUID();
    const executionId = randomUUID();
    const job = newJob(
      {
        organizationId: organizationId as never,
        executionId: executionId as never,
        nodeId: 'n0',
        attempt: 2,
        correlationId: 'req-1',
      },
      NOW.toISOString() as never,
    );
    expect(await repository.create({ job, events: [] })).toBe('created');
    expect(await repository.create({ job, events: [] })).toBe('exists');
    const stored = (await db.collection(EXECUTION_JOBS).doc(job.id).get()).data();
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      [
        'attempt',
        'correlationId',
        'createdAt',
        'executionId',
        'finishedAt',
        'idempotencyKey',
        'lease',
        'leaseCount',
        'nodeId',
        'organizationId',
        'outcome',
        'retryOf',
        'revision',
        'state',
        'updatedAt',
      ].sort(),
    );
    expect(await repository.find(job.id)).toEqual(job);
    expect(toJob(job.id, toJobDocument(job) as never)).toEqual(job);
  });
});
