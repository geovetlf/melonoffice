import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, isAuditAction } from './actions.js';
import {
  actorOf,
  buildAuditEvent,
  stableAuditEventId,
  type AuditEventId,
  type AuditEventInput,
} from './event.js';
import { InMemoryAuditStore } from './memory.js';
import { AuditEventAlreadyStored, AuditEventConflict, createAuditService } from './service.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId;
const alice: AuthenticatedContext = { actor: 'user', userId: ALICE, emailVerified: true };

const signIn: AuditEventInput = {
  action: 'auth.sign_in',
  result: 'success',
  actor: actorOf(alice),
  source: 'api',
};

describe('catalogue', () => {
  it('names every action category.verb and describes it', () => {
    for (const [id, definition] of Object.entries(AUDIT_ACTIONS)) {
      expect(id.startsWith(`${id.split('.')[0]}.`)).toBe(true);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.results.length).toBeGreaterThan(0);
    }
  });

  it('knows nothing outside the catalogue, including prototype names', () => {
    for (const value of ['auth.*', 'toString', '__proto__', '', 'audit.write']) {
      expect(isAuditAction(value)).toBe(false);
    }
  });
});

describe('buildAuditEvent', () => {
  it('adds a random id and the time, and freezes the event', () => {
    const event = buildAuditEvent(signIn, NOW);
    expect(event).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      occurredAt: '2026-09-26T12:00:00.000Z',
      action: 'auth.sign_in',
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      source: 'api',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.actor)).toBe(true);
    expect(buildAuditEvent(signIn, NOW).id).not.toBe(event.id);
  });

  it.each([
    ['an unknown action', { ...signIn, action: 'audit.delete' }, 'unknown audit action'],
    ['a result the action never has', { ...signIn, result: 'denied' }, 'cannot be denied'],
    ['a free-text reason', { ...signIn, reason: 'Bearer abc.def' }, 'invalid audit reason'],
    ['a malformed permission', { ...signIn, permission: 'x' }, 'invalid audit permission'],
  ])('refuses %s', (_name, input, message) => {
    expect(() => buildAuditEvent(input as AuditEventInput, NOW)).toThrow(message);
  });

  it('records an execution job by id, node, attempt and lease, and refuses anything malformed', () => {
    const JOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const LEASE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const leased: AuditEventInput = {
      action: 'execution.job_leased',
      result: 'success',
      actor: actorOf({ actor: 'runtime', userId: ALICE }),
      organizationId: ORG_A,
      job: { id: JOB, nodeId: 'n0', attempt: 1, leaseId: LEASE },
      source: 'api',
    };
    const event = buildAuditEvent(leased, NOW);
    expect(event.job).toEqual({ id: JOB, nodeId: 'n0', attempt: 1, leaseId: LEASE });
    expect(Object.isFrozen(event.job)).toBe(true);
    for (const job of [
      { id: 'job-1', nodeId: 'n0', attempt: 1 },
      { id: JOB, nodeId: 'n 0', attempt: 1 },
      { id: JOB, nodeId: 'n0', attempt: 0 },
      { id: JOB, nodeId: 'n0', attempt: 1, leaseId: 'lease' },
    ]) {
      expect(() => buildAuditEvent({ ...leased, job }, NOW)).toThrow('invalid audit job');
    }
  });

  it('keeps a well-formed requested organization and drops anything else', () => {
    const denied = { ...signIn, action: 'tenancy.resolve', result: 'denied' } as const;
    expect(
      buildAuditEvent({ ...denied, requestedOrganizationId: ORG_A }, NOW).requestedOrganizationId,
    ).toBe(ORG_A);
    for (const bad of ['org-a', `${ORG_A}/x`, 'x'.repeat(500), '<script>']) {
      expect(buildAuditEvent({ ...denied, requestedOrganizationId: bad }, NOW)).not.toHaveProperty(
        'requestedOrganizationId',
      );
    }
  });

  it('drops a malformed request id', () => {
    expect(buildAuditEvent({ ...signIn, requestId: 'ok-1' }, NOW).requestId).toBe('ok-1');
    expect(buildAuditEvent({ ...signIn, requestId: 'bad id\n' }, NOW)).not.toHaveProperty(
      'requestId',
    );
  });

  it('records a well-formed plan reference and refuses a malformed one', () => {
    const assign: AuditEventInput = {
      action: 'plan.assign',
      result: 'success',
      actor: actorOf(alice),
      organizationId: ORG_A,
      target: { type: 'organization', id: ORG_A },
      plan: { id: 'entrepreneur', version: 1 },
      source: 'api',
    };
    const event = buildAuditEvent(assign, NOW);
    expect(event.plan).toEqual({ id: 'entrepreneur', version: 1 });
    expect(Object.isFrozen(event.plan)).toBe(true);
    for (const plan of [
      { id: 'Entrepreneur', version: 1 },
      { id: 'entrepreneur', version: 0 },
      { id: 'a b', version: 1 },
    ]) {
      expect(() => buildAuditEvent({ ...assign, plan }, NOW)).toThrow('invalid audit plan');
    }
    expect(() => buildAuditEvent({ ...assign, result: 'denied' }, NOW)).toThrow();
  });

  it('records a well-formed status transition and refuses a malformed one', () => {
    const change: AuditEventInput = {
      action: 'execution.state_changed',
      result: 'success',
      actor: actorOf(alice),
      organizationId: ORG_A,
      target: { type: 'execution', id: '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' },
      transition: { from: 'running', to: 'cancelled' },
      reason: 'director_request',
      source: 'api',
    };
    const event = buildAuditEvent(change, NOW);
    expect(event.transition).toEqual({ from: 'running', to: 'cancelled' });
    expect(Object.isFrozen(event.transition)).toBe(true);
    for (const transition of [
      { from: 'Running', to: 'cancelled' },
      { from: 'running', to: 'cancelled; drop' },
      { from: '', to: 'x' },
    ]) {
      expect(() => buildAuditEvent({ ...change, transition }, NOW)).toThrow(
        'invalid audit transition',
      );
    }
    expect(() => buildAuditEvent({ ...change, result: 'denied' }, NOW)).toThrow();
  });

  it('records a well-formed operation reference and refuses a malformed one', () => {
    const consume: AuditEventInput = {
      action: 'credits.consume',
      result: 'success',
      actor: actorOf(alice),
      organizationId: ORG_A,
      target: { type: 'credit_entry', id: 'a'.repeat(64) },
      reference: 'task:42.run-1',
      reason: 'task_execution',
      source: 'api',
    };
    expect(buildAuditEvent(consume, NOW).reference).toBe('task:42.run-1');
    for (const reference of ['', 'a b', 'Bearer abc', 'x'.repeat(129), 'a/b']) {
      expect(() => buildAuditEvent({ ...consume, reference }, NOW)).toThrow(
        'invalid audit reference',
      );
    }
    expect(() => buildAuditEvent({ ...consume, result: 'denied' }, NOW)).toThrow();
  });

  it('copies only model fields, so extra input never reaches storage', () => {
    const input = { ...signIn, metadata: { token: 'secret' }, email: 'a@example.com' };
    const event = buildAuditEvent(input as AuditEventInput, NOW);
    expect(JSON.stringify(event)).not.toMatch(/secret|example\.com|metadata/);
  });
});

describe('actorOf', () => {
  it('is the verified user, acting directly', () => {
    expect(actorOf(alice)).toEqual({ type: 'user', userId: ALICE, via: 'direct' });
  });

  it('keeps the real user when GIA acts, and marks GIA only as the channel', () => {
    expect(actorOf(actAsGia(alice))).toEqual({ type: 'user', userId: ALICE, via: 'gia' });
  });

  it('records the runtime as a system actor with the user who started the work (ADR-0029)', () => {
    const runtime = { actor: 'runtime', userId: ALICE } as const;
    expect(actorOf(runtime)).toEqual({
      type: 'system',
      id: 'runtime',
      initiatedBy: ALICE,
      via: 'runtime',
    });
    const event = buildAuditEvent({ ...signIn, actor: actorOf(runtime) }, NOW);
    expect(event.actor).toEqual(actorOf(runtime));
    for (const actor of [
      { type: 'system', id: 'runtime', initiatedBy: 'not-a-user', via: 'runtime' },
      { type: 'system', id: 'scheduler', initiatedBy: ALICE, via: 'runtime' },
      { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'direct' },
      { type: 'system' },
    ]) {
      expect(() => buildAuditEvent({ ...signIn, actor } as never, NOW)).toThrow();
    }
  });
});

describe('AuditService and InMemoryAuditStore', () => {
  it('records events in order', async () => {
    const store = new InMemoryAuditStore();
    const audit = createAuditService(store, () => NOW);
    const first = await audit.record(signIn);
    const second = await audit.record({ ...signIn, action: 'auth.register' });
    expect(store.events()).toEqual([first, second]);
  });

  it('only appends: no update or delete exists, and stored events cannot be changed', async () => {
    const store = new InMemoryAuditStore();
    const event = await createAuditService(store).record(signIn);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    // `query`, `history` and `find` only read (ADR-0049, ADR-0054, ADR-0044).
    expect(methods.sort()).toEqual([
      'append',
      'appendNow',
      'constructor',
      'events',
      'find',
      'history',
      'query',
    ]);
    expect(() => {
      (event as { result: string }).result = 'denied';
    }).toThrow();
    (store.events() as unknown[]).length = 0;
    expect(store.events()).toHaveLength(1);
  });

  it("reads one target's history, newest first, only in its organization (ADR-0054)", async () => {
    const store = new InMemoryAuditStore();
    const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as OrganizationId;
    const about = (id: string, organizationId: OrganizationId, at: string, action: string) =>
      buildAuditEvent(
        {
          action,
          result: 'success',
          actor: actorOf(alice),
          source: 'api',
          organizationId,
          target: { type: 'opportunity', id },
        } as AuditEventInput,
        new Date(at),
      );
    const opened = about('opp_1', ORG_A, '2026-09-28T10:00:00Z', 'opportunity.created');
    const won = about('opp_1', ORG_A, '2026-09-28T11:00:00Z', 'opportunity.won');
    await store.append([
      opened,
      about('opp_2', ORG_A, '2026-09-28T10:30:00Z', 'opportunity.created'),
      about('opp_1', ORG_B, '2026-09-28T10:45:00Z', 'opportunity.created'),
      won,
    ]);
    const target = { type: 'opportunity', id: 'opp_1' };
    expect((await store.history(ORG_A, target, 50)).map((e) => e.id)).toEqual([won.id, opened.id]);
    expect((await store.history(ORG_A, target, 1)).map((e) => e.id)).toEqual([won.id]);
  });

  it('refuses to record the same event twice', async () => {
    const store = new InMemoryAuditStore();
    const event = buildAuditEvent(signIn, NOW);
    await store.append([event]);
    await expect(store.append([event])).rejects.toThrow('audit event already recorded');
  });

  it('rejects when the store fails, so callers can apply the error policy', async () => {
    const audit = createAuditService({
      append: async () => {
        throw new Error('down');
      },
      find: async () => undefined,
    });
    await expect(audit.record(signIn)).rejects.toThrow('down');
  });
});

describe('stable ids and recordOnce (ADR-0044)', () => {
  const KEY = 'inbound:wamid.HBgLMTU1NTEyMzQ1Njc';
  const id = stableAuditEventId(KEY);

  it('gives a key one id, shaped as a UUID, and another key another id', () => {
    expect(stableAuditEventId(KEY)).toBe(id);
    expect(stableAuditEventId(`${KEY}.2`)).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('builds an event under the id it is given, and refuses a malformed one', () => {
    expect(buildAuditEvent({ ...signIn, id }, NOW).id).toBe(id);
    expect(() => buildAuditEvent({ ...signIn, id: 'inbound-1' as AuditEventId }, NOW)).toThrow(
      'invalid audit event id',
    );
  });

  it('writes a fact once, and a repeat of the same fact finds the stored copy', async () => {
    const store = new InMemoryAuditStore();
    const audit = createAuditService(store, () => NOW);
    await expect(audit.recordOnce({ ...signIn, id })).resolves.toBe('written');
    await expect(audit.recordOnce({ ...signIn, id })).resolves.toBe('same');
    expect(store.events()).toHaveLength(1);
    expect(await store.find(id)).toMatchObject({ id, action: 'auth.sign_in' });
  });

  it('treats a repeat at a later time as the same fact: the time is not compared', async () => {
    const store = new InMemoryAuditStore();
    let at = NOW;
    const audit = createAuditService(store, () => at);
    await audit.recordOnce({ ...signIn, id });
    at = new Date('2026-09-26T12:05:00Z');
    await expect(audit.recordOnce({ ...signIn, id })).resolves.toBe('same');
    expect(store.events()).toHaveLength(1);
  });

  it('refuses a different fact under a stored id, and stores nothing', async () => {
    const store = new InMemoryAuditStore();
    const audit = createAuditService(store, () => NOW);
    await audit.recordOnce({ ...signIn, id });
    const other = audit.recordOnce({ ...signIn, id, reason: 'another_channel' });
    await expect(other).rejects.toBeInstanceOf(AuditEventConflict);
    await expect(other).rejects.toMatchObject({ code: 'audit_event_conflict' });
    expect(store.events()).toHaveLength(1);
  });

  it('rejects a store failure that is not a repeat, and never reports it as the same fact', async () => {
    const audit = createAuditService({
      append: async () => {
        throw new Error('down');
      },
      find: async () => undefined,
    });
    await expect(audit.recordOnce({ ...signIn, id })).rejects.toThrow('down');
  });

  it('a stored id that cannot be read back is a conflict, not a success', async () => {
    const audit = createAuditService({
      append: async () => {
        throw new AuditEventAlreadyStored();
      },
      find: async () => undefined,
    });
    await expect(audit.recordOnce({ ...signIn, id })).rejects.toBeInstanceOf(AuditEventConflict);
  });
});
