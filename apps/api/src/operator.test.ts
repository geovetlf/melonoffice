import type { AuditEvent } from '@melonoffice/audit';
import { createConversationService } from '@melonoffice/conversations';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import type { EntitlementOverride } from '@melonoffice/entitlements';
import { createConversationAgentCheck } from '@melonoffice/integrations';
import { createAuthorizationService } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { OperatorError, seedTestAgent, setEntitlementOverride, TEST_AGENT } from './operator.js';
import { setupApp, STORES } from './test-api.js';

/**
 * Operator tools (CV-6C, ADR-0044): an audited, per-organization override that leaves the plan
 * alone, and the DEV-only test agent, seeded through the product's own model and services.
 */

const MISSING = '99999999-9999-4999-8999-999999999999';

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof OperatorError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe.each(STORES)('operator tools with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores = createStores();
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
    const orgA = await create('token-alice', 'MOpruebas');
    const orgB = await create('token-bob', 'B');
    const written: { organizationId: string; override: EntitlementOverride; event: AuditEvent }[] =
      [];
    const writer = {
      set: async (
        organizationId: OrganizationId,
        override: EntitlementOverride,
        event: AuditEvent,
      ) => {
        written.push({ organizationId, override, event });
      },
    };
    const conversations = createConversationService({
      repository: stores.conversations,
      agents: createConversationAgentCheck(stores.specialists),
      organizations: stores.tenancy,
      departments: stores.departments,
      authorization: createAuthorizationService(),
    });
    return { ...ctx, stores, aliceId, orgA, orgB, written, writer, conversations };
  }

  describe('entitlement override', () => {
    it('writes one audited value for the named organization, naming its approver', async () => {
      const t = await setup();
      const result = await setEntitlementOverride({
        organizationId: t.orgA,
        key: 'integrations.connectionsMax',
        value: '1',
        reason: 'DEV test connection (CV-6C)',
        approvedBy: t.aliceId,
        tenancy: t.stores.tenancy,
        users: t.stores.users,
        store: t.writer,
      });
      expect(result).toEqual({ organizationId: t.orgA, key: 'integrations.connectionsMax' });
      expect(t.written).toHaveLength(1);
      expect(t.written[0]).toMatchObject({
        organizationId: t.orgA,
        override: { key: 'integrations.connectionsMax', value: 1, approvedBy: t.aliceId },
        event: {
          action: 'entitlements.override_set',
          actor: { type: 'user', userId: t.aliceId },
          organizationId: t.orgA,
          reference: 'entitlement:integrations.connectionsMax',
        },
      });
    });

    it('refuses an unknown organization, key, value, approver or empty reason', async () => {
      const t = await setup();
      const base = {
        organizationId: t.orgA as string,
        key: 'integrations.connectionsMax',
        value: '1',
        reason: 'DEV test connection',
        approvedBy: t.aliceId as string,
        tenancy: t.stores.tenancy,
        users: t.stores.users,
        store: t.writer,
      };
      expect(await codeOf(setEntitlementOverride({ ...base, organizationId: MISSING }))).toBe(
        'organization_not_found',
      );
      expect(await codeOf(setEntitlementOverride({ ...base, key: 'plans.everything' }))).toBe(
        'invalid_input',
      );
      expect(await codeOf(setEntitlementOverride({ ...base, value: '-1' }))).toBe('invalid_input');
      expect(await codeOf(setEntitlementOverride({ ...base, value: 'many' }))).toBe(
        'invalid_input',
      );
      expect(await codeOf(setEntitlementOverride({ ...base, reason: ' ' }))).toBe('invalid_input');
      expect(await codeOf(setEntitlementOverride({ ...base, approvedBy: MISSING }))).toBe(
        'approver_not_found',
      );
      expect(t.written).toEqual([]);
    });
  });

  describe('test agent', () => {
    const seed = (t: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) =>
      seedTestAgent({
        environment: 'dev',
        organizationId: t.orgA,
        autonomy: 'supervised',
        tenancy: t.stores.tenancy,
        departments: t.stores.departments,
        specialists: t.stores.specialists,
        conversations: t.conversations,
        ...overrides,
      });

    it('is seeded in DEV only, and never outside it', async () => {
      const t = await setup();
      for (const environment of ['staging', 'prod', undefined]) {
        expect(await codeOf(seed(t, { environment }))).toBe('not_dev');
      }
      expect(await t.stores.specialists.list(t.orgA)).toEqual([]);
    });

    it("becomes the named organization's agent, once, at the level asked for", async () => {
      const t = await setup();
      const first = await seed(t);
      expect(first).toMatchObject({
        organizationId: t.orgA,
        autonomy: 'supervised',
        created: true,
      });
      expect(await seed(t)).toMatchObject({ specialistId: first.specialistId, created: false });
      const [agent] = await t.stores.specialists.list(t.orgA);
      expect(agent).toMatchObject({
        status: 'active',
        identity: { displayName: TEST_AGENT.displayName },
        configuration: {
          tools: [
            { id: 'message_send', version: 2 },
            { id: 'conversation_handoff', version: 1 },
          ],
          conversation: { autonomy: 'supervised', channels: ['whatsapp'] },
        },
      });
      const settings = await t.stores.conversations.findSettings(t.orgA);
      expect(settings).toMatchObject({ agentId: first.specialistId, autonomy: 'supervised' });
      const autonomous = await seed(t, { autonomy: 'autonomous' });
      expect(autonomous.specialistId).not.toBe(first.specialistId);
      // Nothing happened to another organization.
      expect(await t.stores.specialists.list(t.orgB)).toEqual([]);
      expect(await t.stores.conversations.findSettings(t.orgB)).toBeUndefined();
    });

    it('refuses an unknown organization or level', async () => {
      const t = await setup();
      expect(await codeOf(seed(t, { organizationId: MISSING }))).toBe('organization_not_found');
      expect(await codeOf(seed(t, { autonomy: 'manual' }))).toBe('invalid_input');
    });
  });
});
