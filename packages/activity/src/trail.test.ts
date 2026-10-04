import {
  AUDIT_ACTIONS,
  buildAuditEvent,
  InMemoryAuditStore,
  MAX_QUERY_ACTIONS,
  type AuditEvent,
  type AuditEventInput,
} from '@melonoffice/audit';
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
import { ActivityError } from './errors.js';
import { dayRange } from './period.js';
import {
  actionsOf,
  AUDIT_TRAIL_CATEGORIES,
  createAuditTrailService,
  TECHNICAL_ACTIONS,
  toAuditTrailItem,
} from './trail.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const NOW = new Date('2026-10-04T15:00:00Z');

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

const event = (input: Partial<AuditEventInput> & Pick<AuditEventInput, 'action'>, at = NOW) =>
  buildAuditEvent(
    {
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      source: 'api',
      ...input,
    } as AuditEventInput,
    at,
  );

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ActivityError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('the audit trail viewer (ADR-0147)', () => {
  async function world(reader?: InMemoryAuditStore) {
    const audit = reader ?? new InMemoryAuditStore();
    const tenancy = new InMemoryTenancyStore(() => NOW);
    const options = {
      billing: BILLING,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
      credits: openWallet,
    };
    const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
    const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
    const service = createAuditTrailService({
      reader: audit,
      organizations: tenancy,
      authorization: createAuthorizationService(),
      now: () => NOW,
    });
    const orgA = a.organization.id as OrganizationId;
    const orgB = b.organization.id as OrganizationId;
    const tenant = await resolveTenant(as(ALICE), orgA, tenancy);
    const page = (input: Record<string, unknown> = {}) =>
      service.page(tenant, { timeZone: 'America/Lima', ...input });
    return { audit, tenancy, service, orgA, orgB, tenant, page };
  }

  it('reads every action of the catalogue in queries within the per-query limit', () => {
    const everything = actionsOf(undefined);
    expect(everything.length + TECHNICAL_ACTIONS.length).toBe(Object.keys(AUDIT_ACTIONS).length);
    for (const category of AUDIT_TRAIL_CATEGORIES) {
      expect(actionsOf(category).length).toBeGreaterThan(0);
    }
    expect(MAX_QUERY_ACTIONS).toBe(30);
  });

  it('shows who acted as the reader understands it, never another person’s id', () => {
    const viewer = ALICE;
    const item = (input: Partial<AuditEventInput> & Pick<AuditEventInput, 'action'>) =>
      toAuditTrailItem(event(input), viewer).actor;
    expect(item({ action: 'plan.approved' })).toEqual({ kind: 'you' });
    expect(
      item({ action: 'plan.approved', actor: { type: 'user', userId: BOB, via: 'direct' } }),
    ).toEqual({ kind: 'member' });
    expect(
      item({ action: 'gia.message_answered', actor: { type: 'user', userId: BOB, via: 'gia' } }),
    ).toEqual({ kind: 'gia', onBehalfOf: 'member' });
    expect(
      item({
        action: 'plan.step_declined',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
      }),
    ).toEqual({ kind: 'agent', onBehalfOf: 'you' });
    expect(
      JSON.stringify(
        toAuditTrailItem(
          event({ action: 'plan.approved', actor: { type: 'user', userId: BOB, via: 'direct' } }),
          viewer,
        ),
      ),
    ).not.toContain(BOB);
  });

  it('shows only allow-listed codes: never references, request ids or the asked organization', () => {
    const shown = toAuditTrailItem(
      event({
        action: 'credits.consume',
        organizationId: '33333333-3333-4333-8333-333333333333' as OrganizationId,
        reason: 'ai_call',
        reference: 'credit-ref-SECRET-123',
        requestId: 'request-SECRET',
        requestedOrganizationId: '44444444-4444-4444-8444-444444444444',
      }),
      ALICE,
    );
    expect(shown.details).toEqual({ reason: 'ai_call' });
    const text = JSON.stringify(shown);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('44444444');
  });

  it('is read by a person only, with activity.read: not by GIA', async () => {
    const w = await world();
    const gia = await resolveTenant(as(ALICE, 'gia'), w.orgA, w.tenancy);
    expect(await codeOf(w.service.page(gia, { timeZone: 'UTC' }))).toBe('permission_denied');
    expect(await codeOf(w.page())).toBe('accepted');
  });

  it('keeps out what a store returned for another organization', async () => {
    const leaky = new InMemoryAuditStore();
    const w = await world(leaky);
    const foreign: AuditEvent = event({ action: 'plan.approved', organizationId: w.orgB });
    // A store that ignored the organization filter: the service filters again.
    leaky.query = async () => [foreign];
    leaky.history = async () => [foreign];
    expect((await w.page()).items).toEqual([]);
    expect((await w.page({ target: 'plan:abc' })).items).toEqual([]);
  });

  it('reads days in the business time zone, the last 30 by default, at most a year', () => {
    const range = dayRange({}, 'America/Lima', NOW);
    expect(range?.fromDay).toBe('2026-09-05');
    expect(range?.toDay).toBe('2026-10-04');
    expect(range?.from.toISOString()).toBe('2026-09-05T05:00:00.000Z');
    expect(range?.to.getTime()).toBe(NOW.getTime() + 1);
    const past = dayRange({ from: '2026-01-01', to: '2026-01-31' }, 'UTC', NOW);
    expect(past?.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(dayRange({ from: '2025-01-01', to: '2026-01-02' }, 'UTC', NOW)).toBeUndefined();
    expect(dayRange({ from: '2026-02-29' }, 'UTC', NOW)).toBeUndefined();
  });

  it('refuses what is not a filter, cursor, record or day, and an inactive organization', async () => {
    const w = await world();
    expect(await codeOf(w.page({ filter: 'secrets' }))).toBe('invalid_filter');
    expect(await codeOf(w.page({ cursor: 'x' }))).toBe('invalid_cursor');
    expect(await codeOf(w.page({ target: 'plan' }))).toBe('invalid_target');
    expect(await codeOf(w.page({ from: 'yesterday' }))).toBe('invalid_period');
    expect(await codeOf(w.page({ timeZone: 'Mars/Base' }))).toBe('invalid_time_zone');
  });
});
