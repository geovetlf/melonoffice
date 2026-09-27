import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, isAuditAction } from './actions.js';
import { actorOf, buildAuditEvent, type AuditEventInput } from './event.js';
import { InMemoryAuditStore } from './memory.js';
import { createAuditService } from './service.js';

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
    expect(methods.sort()).toEqual(['append', 'appendNow', 'constructor', 'events']);
    expect(() => {
      (event as { result: string }).result = 'denied';
    }).toThrow();
    (store.events() as unknown[]).length = 0;
    expect(store.events()).toHaveLength(1);
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
    });
    await expect(audit.record(signIn)).rejects.toThrow('down');
  });
});
