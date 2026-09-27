import type { ExecutionId, ExecutionJob, IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { isJobError } from './errors.js';
import {
  acquireLease,
  cancelJob,
  checkFinish,
  checkLeaseHolder,
  checkNextJob,
  checkStoredJob,
  finishJob,
  isJobTerminal,
  JOB_STATES,
  JOB_TRANSITIONS,
  jobIdFor,
  leaseIsLive,
  newJob,
  releaseJob,
  takeTurn,
} from './model.js';

const ORG = '33333333-3333-4333-8333-333333333333' as OrganizationId;
const OTHER_ORG = '44444444-4444-4444-8444-444444444444' as OrganizationId;
const EXEC = '55555555-5555-4555-8555-555555555555' as ExecutionId;
const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
const LEASE_1 = '66666666-6666-4666-8666-666666666666';
const LEASE_2 = '77777777-7777-4777-8777-777777777777';
const later = (ms: number) => new Date(Date.parse(AT) + ms).toISOString() as IsoTimestamp;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (isJobError(error)) return error.code;
    throw error;
  }
  return 'accepted';
};

const queued = (attempt = 1) =>
  newJob(
    { organizationId: ORG, executionId: EXEC, nodeId: 'n0', attempt, correlationId: 'req-1' },
    AT,
  );
const leased = () =>
  acquireLease(queued(), { leaseId: LEASE_1, workerId: 'w1', leaseMs: 1_000 }, AT);

describe('job ids', () => {
  it('are the same for the same organization, execution, node and attempt, and differ otherwise', () => {
    const id = jobIdFor(ORG, EXEC, 'n0', 1);
    expect(jobIdFor(ORG, EXEC, 'n0', 1)).toBe(id);
    for (const other of [
      jobIdFor(OTHER_ORG, EXEC, 'n0', 1),
      jobIdFor(ORG, '88888888-8888-4888-8888-888888888888' as ExecutionId, 'n0', 1),
      jobIdFor(ORG, EXEC, 'n1', 1),
      jobIdFor(ORG, EXEC, 'n0', 2),
    ]) {
      expect(other).not.toBe(id);
    }
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('refuse malformed parts', () => {
    expect(codeOf(() => jobIdFor('org' as OrganizationId, EXEC, 'n0', 1))).toBe('invalid_job');
    expect(codeOf(() => jobIdFor(ORG, EXEC, 'n 0', 1))).toBe('invalid_job');
    expect(codeOf(() => jobIdFor(ORG, EXEC, 'n0', 0))).toBe('invalid_job');
    expect(codeOf(() => jobIdFor(ORG, EXEC, 'n0', 1.5))).toBe('invalid_job');
  });
});

describe('job state machine', () => {
  it('has exactly three terminal states', () => {
    expect(JOB_STATES.filter(isJobTerminal)).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(JOB_TRANSITIONS.queued).toEqual(['leased', 'cancelled']);
  });

  it('starts queued, with a retry pointing at the previous attempt', () => {
    expect(queued()).toMatchObject({ state: 'queued', revision: 1, leaseCount: 0 });
    expect(queued(2).retryOf).toBe(jobIdFor(ORG, EXEC, 'n0', 1));
  });

  it('gives one live lease at a time, and a new lease id after expiry', () => {
    const job = leased();
    expect(job).toMatchObject({ state: 'leased', revision: 2, leaseCount: 1 });
    expect(job.lease).toEqual({
      leaseId: LEASE_1,
      workerId: 'w1',
      acquiredAt: AT,
      expiresAt: later(1_000),
    });
    expect(leaseIsLive(job.lease, later(999))).toBe(true);
    expect(leaseIsLive(job.lease, later(1_000))).toBe(false);
    expect(
      codeOf(() =>
        acquireLease(job, { leaseId: LEASE_2, workerId: 'w2', leaseMs: 1_000 }, later(999)),
      ),
    ).toBe('job_lease_held');
    // The same lease id is never reused.
    expect(
      codeOf(() =>
        acquireLease(job, { leaseId: LEASE_1, workerId: 'w2', leaseMs: 1_000 }, later(1_000)),
      ),
    ).toBe('invalid_job');
    const taken = acquireLease(
      job,
      { leaseId: LEASE_2, workerId: 'w2', leaseMs: 1_000 },
      later(1_000),
    );
    expect(taken).toMatchObject({ leaseCount: 2, revision: 3, lease: { leaseId: LEASE_2 } });
  });

  it('checks the lease holder: lease id, revision and expiry', () => {
    const job = leased();
    const proof = { jobId: job.id, leaseId: LEASE_1, revision: job.revision };
    expect(codeOf(() => checkLeaseHolder(job, proof, later(10)))).toBe('accepted');
    expect(codeOf(() => checkLeaseHolder(job, { ...proof, leaseId: LEASE_2 }, AT))).toBe(
      'job_lease_mismatch',
    );
    expect(codeOf(() => checkLeaseHolder(job, { ...proof, revision: 1 }, AT))).toBe(
      'job_revision_mismatch',
    );
    expect(codeOf(() => checkLeaseHolder(job, proof, later(1_000)))).toBe('job_lease_expired');
    expect(codeOf(() => checkLeaseHolder(queued(), proof, AT))).toBe('job_lease_mismatch');
  });

  it('finishes only with a valid lease, and never leaves a terminal state', () => {
    const job = leased();
    const proof = { jobId: job.id, leaseId: LEASE_1, revision: job.revision };
    const done = finishJob(
      job,
      proof,
      checkFinish({ result: 'succeeded', code: 'done' }),
      later(5),
    );
    expect(done).toMatchObject({
      state: 'succeeded',
      outcome: { code: 'done' },
      finishedAt: later(5),
    });
    expect(done.lease?.leaseId).toBe(LEASE_1);
    expect(codeOf(() => finishJob(done, proof, { result: 'failed', code: 'x' }, later(6)))).toBe(
      'job_terminal',
    );
    expect(codeOf(() => cancelJob(done, 'execution_ended', later(6)))).toBe('job_terminal');
    const cancelled = cancelJob(queued(), 'execution_ended', AT);
    expect(
      codeOf(() => acquireLease(cancelled, { leaseId: LEASE_2, workerId: 'w', leaseMs: 1 }, AT)),
    ).toBe('job_cancelled');
  });

  it('gives the holder one turn per revision, and lets it release the job to the queue (ADR-0031)', () => {
    const job = leased();
    const proof = { jobId: job.id, leaseId: LEASE_1, revision: job.revision };
    const turned = takeTurn(job, proof, later(1));
    expect(turned).toMatchObject({ state: 'leased', revision: 3, leaseCount: 1, lease: job.lease });
    expect(codeOf(() => checkNextJob(job, turned))).toBe('accepted');
    // The same proof never gets a second turn.
    expect(codeOf(() => takeTurn(turned, proof, later(2)))).toBe('job_revision_mismatch');
    expect(codeOf(() => takeTurn(job, proof, later(1_000)))).toBe('job_lease_expired');
    const next = { ...proof, revision: turned.revision };
    const released = releaseJob(turned, next, later(3));
    expect(released).toMatchObject({ state: 'queued', revision: 4, lease: job.lease });
    expect(codeOf(() => checkNextJob(turned, released))).toBe('accepted');
    expect(codeOf(() => releaseJob(released, next, later(4)))).toBe('job_lease_mismatch');
    expect(
      acquireLease(released, { leaseId: LEASE_2, workerId: 'w2', leaseMs: 1_000 }, later(4)),
    ).toMatchObject({ state: 'leased', leaseCount: 2, lease: { leaseId: LEASE_2 } });
  });

  it('accepts a finish with exactly a result, a code and a reference', () => {
    expect(
      checkFinish({ result: 'failed', code: 'node_failed', ref: { type: 'doc', id: 'd1' } }),
    ).toEqual({ result: 'failed', code: 'node_failed', ref: { type: 'doc', id: 'd1' } });
    for (const bad of [
      null,
      { result: 'done', code: 'x' },
      { result: 'succeeded', code: 'Not A Code' },
      { result: 'succeeded', code: 'x', output: 'text' },
      { result: 'succeeded', code: 'x', ref: { type: 'doc', id: 'd1', extra: 1 } },
      { result: 'succeeded', code: 'x', ref: { type: 'doc' } },
    ]) {
      expect(codeOf(() => checkFinish(bad))).toBe('invalid_job');
    }
  });

  it('refuses a next state that changes a protected field, skips a revision or jumps states', () => {
    const job = queued();
    const next = (change: Partial<ExecutionJob>) =>
      ({ ...job, revision: 2, ...change }) as ExecutionJob;
    expect(codeOf(() => checkNextJob(job, next({ organizationId: OTHER_ORG })))).toBe(
      'invalid_job',
    );
    expect(codeOf(() => checkNextJob(job, next({ attempt: 2 })))).toBe('invalid_job');
    expect(codeOf(() => checkNextJob(job, { ...job, revision: 3 }))).toBe(
      'job_concurrency_conflict',
    );
    expect(codeOf(() => checkNextJob(job, { ...job }))).toBe('job_concurrency_conflict');
    expect(
      codeOf(() => checkNextJob(job, next({ state: 'succeeded', outcome: { code: 'done' } }))),
    ).toBe('invalid_job');
    expect(codeOf(() => checkNextJob(job, leased()))).toBe('accepted');
  });

  it('refuses a stored job with unknown fields, a changed id or an inconsistent lease', () => {
    const job = queued();
    expect(checkStoredJob(job)).toBe(job);
    const bad = (change: Record<string, unknown>) =>
      codeOf(() => checkStoredJob({ ...job, ...change } as ExecutionJob));
    expect(bad({ credential: 'x' })).toBe('invalid_job');
    expect(bad({ tenant: { organizationId: OTHER_ORG } })).toBe('invalid_job');
    expect(bad({ organizationId: OTHER_ORG })).toBe('invalid_job');
    expect(bad({ state: 'leased' })).toBe('invalid_job');
    expect(bad({ state: 'succeeded' })).toBe('invalid_job');
    expect(bad({ retryOf: jobIdFor(ORG, EXEC, 'n0', 1) })).toBe('invalid_job');
    expect(bad({ idempotencyKey: 'other' })).toBe('invalid_job');
  });
});
