import type { InvoicingSyncJob } from '@melonoffice/domain';
import { IntegrationError } from '@melonoffice/integrations';
import { createLogger } from '@melonoffice/observability';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createInvoicingSyncHandler, RUN_INVOICING_SYNC_PATH } from './invoicing.js';

/**
 * The worker's invoicing sync route (ADR-0193): a thin handler over the gateway's `runSync`,
 * which keeps one run at a time with its lease. It queues the next run when a sync wants one and
 * looks again when a lease ends, so a lost worker never leaves a sync running for good.
 */

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'eeeeeeee-eeee-4eee-8eee-000000000001';
const NOW = new Date('2026-10-13T00:00:00Z');
const task = { organizationId: ORG, jobId: JOB };

const job = (overrides: Partial<InvoicingSyncJob>) =>
  ({ id: JOB, organizationId: ORG, status: 'queued', ...overrides }) as InvoicingSyncJob;

function handler(
  run: () => Promise<{ job: InvoicingSyncJob; again: boolean }>,
  stored?: InvoicingSyncJob,
) {
  const queued: { task: unknown; at: string }[] = [];
  const calls: unknown[][] = [];
  const h = createInvoicingSyncHandler({
    gateway: {
      runSync: async (...args) => {
        calls.push(args);
        return run();
      },
    },
    syncs: { findJob: async () => stored },
    scheduler: { schedule: async (t, at) => void queued.push({ task: t, at: at.toISOString() }) },
    workerId: 'worker-1',
    now: () => NOW,
  });
  return { h, queued, calls };
}

describe('invoicing syncs in the worker', () => {
  it('runs a sync and queues its next run when it wants one', async () => {
    const more = handler(async () => ({ job: job({ status: 'queued' }), again: true }));
    expect(await more.h.run(task)).toEqual({ status: 200, body: { result: 'queued' } });
    expect(more.calls).toEqual([[ORG, JOB, 'worker-1']]);
    expect(more.queued).toEqual([{ task, at: NOW.toISOString() }]);
    // A retry waits for its time.
    const later = handler(async () => ({
      job: job({ nextAttemptAt: '2026-10-13T00:00:30.000Z' as never }),
      again: true,
    }));
    await later.h.run(task);
    expect(later.queued[0]?.at).toBe('2026-10-13T00:00:30.000Z');
    const done = handler(async () => ({ job: job({ status: 'completed' }), again: false }));
    expect(await done.h.run(task)).toEqual({ status: 200, body: { result: 'completed' } });
    expect(done.queued).toEqual([]);
  });

  it('looks again when another worker’s lease ends, and drops a sync that is gone', async () => {
    const leaseUntil = '2026-10-13T00:05:00.000Z';
    const held = handler(
      async () => {
        throw new IntegrationError('sync_in_progress');
      },
      job({ status: 'running', leaseUntil: leaseUntil as never }),
    );
    expect(await held.h.run(task)).toEqual({ status: 200, body: { result: 'in_progress' } });
    expect(held.queued).toEqual([{ task, at: leaseUntil }]);
    // Waiting for its own time: its task is already queued.
    const waiting = handler(
      async () => {
        throw new IntegrationError('sync_in_progress');
      },
      job({ status: 'queued', nextAttemptAt: '2026-10-13T00:01:00.000Z' as never }),
    );
    await waiting.h.run(task);
    expect(waiting.queued).toEqual([]);
    const gone = handler(async () => {
      throw new IntegrationError('sync_not_found');
    });
    expect(await gone.h.run(task)).toEqual({ status: 200, body: { result: 'not_found' } });
  });

  it('asks the queue again when storage fails, and refuses anything but its task', async () => {
    const down = handler(async () => {
      throw new Error('firestore unavailable');
    });
    expect(await down.h.run(task)).toEqual({
      status: 503,
      body: { result: 'unavailable', code: 'unavailable' },
    });
    for (const body of [
      {},
      { ...task, extra: 1 },
      { organizationId: ORG, jobId: 'x' },
      [task],
      null,
    ]) {
      expect((await down.h.run(body)).status).toBe(400);
    }
    // Only the well-formed task reached the gateway.
    expect(down.calls).toHaveLength(1);
  });

  it('answers 503 where invoicing is not configured', async () => {
    const app = createApp({
      logger: createLogger({ service: 'test', sink: () => undefined }),
      version: 'test',
    });
    const response = await app.request(RUN_INVOICING_SYNC_PATH, { method: 'POST' });
    expect(response.status).toBe(503);
  });
});
