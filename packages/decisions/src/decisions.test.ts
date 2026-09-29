import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type {
  CreditWallet,
  CreditWalletId,
  InitialBilling,
  Organization,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService, ROLES, type RoleCatalogue } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOGUE, checkCatalogue, type ActionDefinition } from './catalogue.js';
import { createDecisionEngine } from './engine.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

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
const CREDITS = (organization: Organization): CreditWallet => ({
  id: `wallet-${organization.id}` as CreditWalletId,
  organizationId: organization.id,
  balance: 0,
  createdAt: organization.createdAt,
  updatedAt: organization.createdAt,
});

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

async function tenants() {
  const store = new InMemoryTenancyStore();
  const { organization } = await createOrganization(as(ALICE), { name: 'A' }, store, {
    billing: BILLING,
    credits: CREDITS,
  });
  const alice = await resolveTenant(as(ALICE), organization.id, store);
  const gia = await resolveTenant(actAsGia(as(ALICE)), organization.id, store);
  return { alice, gia };
}

const without = (...permissions: string[]) =>
  createAuthorizationService({
    ...ROLES,
    owner: ROLES.owner.filter((p) => !permissions.includes(p)),
  } as RoleCatalogue);

describe('Decision Engine (DE-1)', () => {
  it('offers the owner every action, each with its condition and cost', async () => {
    const { alice } = await tenants();
    const engine = createDecisionEngine({ authorization: createAuthorizationService() });
    expect(engine.listActions(alice)).toEqual([
      {
        action: 'knowledge.propose_fact',
        outcome: 'available',
        confirmation: 'person_confirms',
        maxCredits: 0,
        reasons: [],
      },
      {
        action: 'follow_up.schedule',
        outcome: 'available',
        confirmation: 'person_confirms',
        maxCredits: 0,
        reasons: [],
      },
      {
        action: 'agent_task.assign',
        outcome: 'available',
        confirmation: 'person_confirms',
        maxCredits: 1,
        reasons: [],
      },
      {
        action: 'opportunity.offer_discount',
        outcome: 'available',
        confirmation: 'person_confirms',
        maxCredits: 0,
        reasons: [],
      },
    ]);
    expect(engine.offers(alice, 'agent_task.assign')).toBe(true);
  });

  it('decides with RBAC for the person: a permission the role lacks is not offered', async () => {
    const { alice } = await tenants();
    const engine = createDecisionEngine({ authorization: without('specialist.task') });
    expect(engine.evaluateAction(alice, 'agent_task.assign')).toMatchObject({
      outcome: 'unavailable',
      reasons: ['permission_denied'],
    });
    expect(engine.offers(alice, 'follow_up.schedule')).toBe(true);
  });

  it('never prepares an action for GIA, the runtime or an unresolved context', async () => {
    const { alice, gia } = await tenants();
    const engine = createDecisionEngine({ authorization: createAuthorizationService() });
    expect(engine.evaluateAction(gia, 'follow_up.schedule').reasons).toEqual(['requires_user']);
    const forged = { ...alice } as TenantContext;
    expect(engine.evaluateAction(forged, 'follow_up.schedule').reasons).toEqual([
      'unresolved_tenant',
    ]);
  });

  it('says when the engine behind an action is not set up here, and refuses unknown ones', async () => {
    const { alice } = await tenants();
    const engine = createDecisionEngine({
      authorization: createAuthorizationService(),
      configured: (action) => action !== 'agent_task.assign',
    });
    expect(engine.evaluateAction(alice, 'agent_task.assign')).toMatchObject({
      outcome: 'unavailable',
      reasons: ['not_configured'],
    });
    expect(engine.evaluateAction(alice, 'payments.pay')).toEqual({
      action: 'payments.pay',
      outcome: 'unavailable',
      confirmation: null,
      maxCredits: null,
      reasons: ['unknown_action'],
    });
    // Agents prepare only what the catalogue lets them (a discount, not a follow-up).
    expect(engine.evaluateAction(alice, 'follow_up.schedule', 'agent').reasons).toEqual([
      'proposer_not_allowed',
    ]);
  });

  it('an action that needs approval is offered as such; a bad catalogue is refused', async () => {
    const { alice } = await tenants();
    const approval: ActionDefinition = {
      id: 'tool.message_send',
      version: 1,
      permission: 'conversation.send',
      confirmation: 'approval',
      proposers: ['agent'],
      maxCredits: 0,
    };
    const engine = createDecisionEngine({
      authorization: createAuthorizationService(),
      catalogue: [...ACTION_CATALOGUE, approval],
    });
    expect(engine.evaluateAction(alice, 'tool.message_send', 'agent').outcome).toBe(
      'needs_approval',
    );
    expect(() => checkCatalogue([approval, approval])).toThrow('duplicate action');
    expect(() => checkCatalogue([{ ...approval, id: 'Bad' }])).toThrow('invalid action id');
    expect(() => checkCatalogue([{ ...approval, maxCredits: -1 }])).toThrow('invalid credits');
    expect(() => checkCatalogue([{ ...approval, proposers: [] }])).toThrow('no proposer');
  });

  it('every action names a permission that exists', () => {
    for (const action of ACTION_CATALOGUE) {
      expect(Object.values(ROLES).flat()).toContain(action.permission);
    }
  });
});
