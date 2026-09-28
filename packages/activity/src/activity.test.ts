import { buildAuditEvent, InMemoryAuditStore, type AuditEventInput } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import { DEFAULT_DEPARTMENT_CATALOGUE, provisionDepartments } from '@melonoffice/departments';
import type {
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_ACTION_GROUPS, ACTIVITY_ACTIONS, toActivityItem } from './catalogue.js';
import { ActivityError } from './errors.js';
import { periodRange } from './period.js';
import { createActivityService } from './service.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ActivityError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('periods in the business time zone (ADR-0049)', () => {
  // Monday 2026-09-28, 03:30 in Lima (UTC-5): still Sunday 27 is over, today began at 05:00Z.
  const now = new Date('2026-09-28T08:30:00Z');

  it('starts today at local midnight', () => {
    expect(periodRange('today', 'America/Lima', now).from.toISOString()).toBe(
      '2026-09-28T05:00:00.000Z',
    );
    expect(periodRange('today', 'UTC', now).from.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('uses the local date, not UTC’s, near midnight', () => {
    const late = new Date('2026-09-28T03:00:00Z'); // 22:00 on Sunday 27 in Lima
    expect(periodRange('today', 'America/Lima', late).from.toISOString()).toBe(
      '2026-09-27T05:00:00.000Z',
    );
    expect(periodRange('week', 'America/Lima', late).from.toISOString()).toBe(
      '2026-09-21T05:00:00.000Z',
    );
  });

  it('starts the week on Monday and the month on the 1st', () => {
    expect(periodRange('week', 'America/Lima', now).from.toISOString()).toBe(
      '2026-09-28T05:00:00.000Z',
    );
    expect(periodRange('month', 'America/Lima', now).from.toISOString()).toBe(
      '2026-09-01T05:00:00.000Z',
    );
  });

  it('follows daylight saving time where the zone has it', () => {
    // Madrid is UTC+2 in summer and UTC+1 after 25 October 2026.
    const november = new Date('2026-11-02T12:00:00Z');
    expect(periodRange('month', 'Europe/Madrid', november).from.toISOString()).toBe(
      '2026-10-31T23:00:00.000Z',
    );
    expect(periodRange('today', 'Europe/Madrid', now).from.toISOString()).toBe(
      '2026-09-27T22:00:00.000Z',
    );
  });

  it('ends now', () => {
    expect(periodRange('month', 'America/Lima', now).to).toEqual(now);
  });
});

describe('activity items', () => {
  const ORG = 'org' as OrganizationId;
  const event = (input: Partial<AuditEventInput>) =>
    buildAuditEvent(
      {
        action: 'conversation.message_sent',
        result: 'success',
        actor: { type: 'user', userId: ALICE, via: 'direct' },
        organizationId: ORG,
        source: 'api',
        ...input,
      } as AuditEventInput,
      new Date('2026-09-28T12:00:00Z'),
    );

  it('names who did it without another user’s id', () => {
    expect(toActivityItem(event({}), ALICE).actor).toBe('you');
    expect(toActivityItem(event({}), BOB).actor).toBe('member');
    expect(
      toActivityItem(event({ actor: { type: 'user', userId: ALICE, via: 'gia' } }), ALICE).actor,
    ).toBe('gia');
    expect(
      toActivityItem(
        event({ actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' } }),
        ALICE,
      ).actor,
    ).toBe('agent');
    expect(
      toActivityItem(
        event({ action: 'conversation.message_received', actor: { type: 'anonymous' } }),
        ALICE,
      ).actor,
    ).toBe('contact');
    expect(JSON.stringify(toActivityItem(event({}), BOB))).not.toContain(ALICE);
  });

  it('links to the conversation it is about, and carries nothing else of the event', () => {
    const item = toActivityItem(
      event({
        action: 'conversation.message_received',
        actor: { type: 'anonymous' },
        target: { type: 'message', id: 'm1' },
        reference: 'conversation:c-1',
        reason: 'whatsapp',
      }),
      ALICE,
    );
    expect(item.link).toEqual({ kind: 'conversation', id: 'c-1' });
    expect(Object.keys(item).sort()).toEqual(['action', 'actor', 'at', 'id', 'link', 'result']);
  });

  it('queries at most 30 kinds of event at a time, none of them plumbing', () => {
    expect(ACTIVITY_ACTION_GROUPS.length).toBeGreaterThan(1);
    for (const group of ACTIVITY_ACTION_GROUPS) expect(group.length).toBeLessThanOrEqual(30);
    expect(ACTIVITY_ACTIONS).toContain('contact.stage_changed');
    for (const hidden of ['auth.sign_in', 'tenancy.resolve', 'authorization.check']) {
      expect(ACTIVITY_ACTIONS as readonly string[]).not.toContain(hidden);
    }
  });
});

describe('activity service', () => {
  const NOW = new Date('2026-09-28T17:00:00Z'); // 12:00 in Lima

  async function world() {
    const audit = new InMemoryAuditStore();
    const tenancy = new InMemoryTenancyStore(() => NOW);
    const options = {
      billing: BILLING,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
      credits: openWallet,
    };
    const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
    const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
    const service = createActivityService({
      reader: audit,
      organizations: tenancy,
      authorization: createAuthorizationService(),
      now: () => NOW,
    });
    const record = (organizationId: OrganizationId, action: string, at: string) =>
      audit.appendNow([
        buildAuditEvent(
          {
            action,
            result: 'success',
            actor: { type: 'user', userId: ALICE, via: 'direct' },
            organizationId,
            source: 'api',
          } as AuditEventInput,
          new Date(at),
        ),
      ]);
    return {
      service,
      record,
      orgA: a.organization.id,
      orgB: b.organization.id,
      tenantA: await resolveTenant(as(ALICE), a.organization.id, tenancy),
      giaA: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
      tenantB: await resolveTenant(as(BOB), b.organization.id, tenancy),
    };
  }
  const LIMA = { period: 'today', timeZone: 'America/Lima' };

  it('shows what happened today, newest first, in the business time zone', async () => {
    const w = await world();
    w.record(w.orgA, 'conversation.message_sent', '2026-09-28T04:59:00Z'); // yesterday in Lima
    w.record(w.orgA, 'conversation.message_sent', '2026-09-28T06:00:00Z');
    w.record(w.orgA, 'conversation.assigned', '2026-09-28T16:00:00Z');
    w.record(w.orgA, 'auth.sign_in', '2026-09-28T16:30:00Z'); // plumbing: not shown
    const page = await w.service.list(w.tenantA, LIMA);
    expect(page.items.map((i) => i.action)).toEqual([
      'conversation.assigned',
      'conversation.message_sent',
    ]);
    expect(page.from).toBe('2026-09-28T05:00:00.000Z');
    expect(page.hasMore).toBe(false);
    // The month includes Sunday evening in Lima, which UTC already called Monday.
    expect((await w.service.list(w.tenantA, { ...LIMA, period: 'month' })).items.length).toBe(3);
  });

  it('merges the customer actions, queried apart, into the same newest-first page', async () => {
    const w = await world();
    w.record(w.orgA, 'conversation.message_sent', '2026-09-28T15:00:00Z');
    w.record(w.orgA, 'contact.created', '2026-09-28T15:30:00Z');
    w.record(w.orgA, 'contact.stage_changed', '2026-09-28T16:10:00Z');
    w.record(w.orgA, 'contact.note_added', '2026-09-28T16:20:00Z'); // kept in the audit only
    const page = await w.service.list(w.tenantA, LIMA);
    expect(page.items.map((i) => i.action)).toEqual([
      'contact.stage_changed',
      'contact.created',
      'conversation.message_sent',
    ]);
  });

  it('keeps each organization’s activity to itself', async () => {
    const w = await world();
    w.record(w.orgA, 'conversation.message_sent', '2026-09-28T16:00:00Z');
    const b = await w.service.list(w.tenantB, LIMA);
    expect(b.items.some((i) => i.action === 'conversation.message_sent')).toBe(false);
  });

  it('answers an empty page, never an invented one, when nothing happened', async () => {
    const w = await world();
    const early = createActivityService({
      reader: { query: async () => [] },
      organizations: { findOrganization: async () => undefined },
      authorization: createAuthorizationService(),
    });
    expect(await codeOf(early.list(w.tenantA, LIMA))).toBe('organization_inactive');
    const empty = await createActivityService({
      reader: { query: async () => [] },
      organizations: { findOrganization: async (id) => ({ id, status: 'active' }) as never },
      authorization: createAuthorizationService(),
    }).list(w.tenantA, LIMA);
    expect(empty.items).toEqual([]);
  });

  it('lets GIA read for the person it helps', async () => {
    const w = await world();
    expect((await w.service.list(w.giaA, LIMA)).period).toBe('today');
  });

  it.each([
    [{ period: 'year', timeZone: 'America/Lima' }, 'invalid_period'],
    [{ period: 'today', timeZone: 'Lima' }, 'invalid_time_zone'],
  ])('refuses %j', async (input, code) => {
    const w = await world();
    expect(await codeOf(w.service.list(w.tenantA, input))).toBe(code);
  });

  it('refuses a role without activity.read', async () => {
    const w = await world();
    const none = createActivityService({
      reader: { query: async () => [] },
      organizations: { findOrganization: async () => undefined },
      authorization: { authorize: () => ({ allowed: false }) as never },
    });
    expect(await codeOf(none.list(w.tenantA, LIMA))).toBe('permission_denied');
  });

  it('pages at 100 and says there is more', async () => {
    const w = await world();
    for (let i = 0; i < 105; i += 1) {
      w.record(
        w.orgA,
        'conversation.message_sent',
        new Date(Date.parse('2026-09-28T06:00:00Z') + i * 1000).toISOString(),
      );
    }
    const page = await w.service.list(w.tenantA, LIMA);
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
  });
});
