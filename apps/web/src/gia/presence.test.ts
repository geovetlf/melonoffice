import { beforeEach, describe, expect, it } from 'vitest';
import { giaEngagements, giaTarget, samePlace } from './presence.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const agents = [
  { id: 'ana', departmentId: 'sales', status: 'active' },
  { id: 'leo', departmentId: 'marketing', status: 'active' },
  { id: 'eva', departmentId: 'finance', status: 'paused' },
];
const task = (id: string, status: string) => ({ id, status });

describe('where GIA is (gia/presence.ts)', () => {
  beforeEach(() => giaEngagements.reset());

  it('is home with nothing brought to an agent: coordinating while agents work, else idle', () => {
    expect(giaTarget([], agents, new Map(), NOW)).toEqual({
      place: { kind: 'home' },
      activity: 'coordinating',
      coordinating: 2,
    });
    expect(giaTarget([], [], new Map(), NOW).activity).toBe('idle');
  });

  it('is with the agent while the task she brought is under way, or waits on it', () => {
    const brought = [{ taskId: 't1', agentId: 'ana', at: NOW - 600_000 }];
    const running = giaTarget(brought, agents, new Map([['ana', task('t1', 'running')]]), NOW);
    expect(running).toMatchObject({
      place: { kind: 'department', departmentId: 'sales', agentId: 'ana' },
      activity: 'working',
      taskId: 't1',
    });
    for (const status of ['pending', 'paused', 'waiting_approval']) {
      expect(giaTarget(brought, agents, new Map([['ana', task('t1', status)]]), NOW).activity).toBe(
        'waiting',
      );
    }
  });

  it('goes home once the task is done, failed or replaced by a newer one', () => {
    const brought = [{ taskId: 't1', agentId: 'ana', at: NOW - 600_000 }];
    for (const latest of [task('t1', 'completed'), task('t1', 'failed'), task('t2', 'running')]) {
      expect(giaTarget(brought, agents, new Map([['ana', latest]]), NOW).place).toEqual({
        kind: 'home',
      });
    }
  });

  it('waits with the agent for a task just sent, before the office has read it', () => {
    const fresh = [{ taskId: 't9', agentId: 'leo', at: NOW - 10_000 }];
    expect(giaTarget(fresh, agents, new Map(), NOW)).toMatchObject({
      place: { kind: 'department', departmentId: 'marketing' },
      activity: 'waiting',
    });
    const stale = [{ taskId: 't9', agentId: 'leo', at: NOW - 600_000 }];
    expect(giaTarget(stale, agents, new Map(), NOW).place.kind).toBe('home');
  });

  it('never goes to an agent that is not active, and follows the latest work first', () => {
    const brought = [
      { taskId: 't1', agentId: 'ana', at: NOW - 120_000 },
      { taskId: 't3', agentId: 'eva', at: NOW - 1_000 },
      { taskId: 't2', agentId: 'leo', at: NOW - 60_000 },
    ];
    const work = new Map([
      ['ana', task('t1', 'running')],
      ['leo', task('t2', 'running')],
      ['eva', task('t3', 'running')],
    ]);
    expect(giaTarget(brought, agents, work, NOW).place).toMatchObject({ agentId: 'leo' });
  });

  it('keeps what the chat records for the session, and forgets on request', () => {
    giaEngagements.record({ taskId: 't1', agentId: 'ana', at: NOW });
    giaEngagements.record({ taskId: 't1', agentId: 'ana', at: NOW });
    expect(giaEngagements.list()).toHaveLength(1);
    giaEngagements.forget('t1');
    expect(giaEngagements.list()).toEqual([]);
  });

  it('compares places by room', () => {
    const sales = { kind: 'department', departmentId: 'sales', agentId: 'ana' } as const;
    expect(samePlace({ kind: 'home' }, { kind: 'home' })).toBe(true);
    expect(samePlace(sales, { ...sales, agentId: 'other' })).toBe(true);
    expect(samePlace(sales, { kind: 'home' })).toBe(false);
  });
});
