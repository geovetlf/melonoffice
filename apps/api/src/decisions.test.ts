import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
} from '@melonoffice/ai-gateway';
import type { PolicyId } from '@melonoffice/domain';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { dateIn } from '@melonoffice/conversations';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The Decision Engine's read route (DE-1, ADR-0065): what GIA may prepare for the person asking,
 * with the same answer GIA's chat uses. Nothing here prepares or runs anything.
 */
const ai = {
  environment: 'dev' as const,
  registry: createProviderRegistry({ providers: [], models: [], adapters: [] }),
  policies: createModelPolicyCatalogue([
    { ...DEFAULT_MODEL_POLICY, id: 'gia_assist' as PolicyId, maxSensitivity: 'confidential' },
  ]),
  creditRate: { microUsdPerCredit: 10_000 },
};

type Json = Record<string, unknown>;

interface Action {
  readonly action: string;
  readonly outcome: string;
  readonly reasons: readonly string[];
}

describe.each(STORES)('decisions with storage in %s', (_name, createStores) => {
  async function setup(options: { readonly without?: readonly string[] } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.without === undefined
        ? undefined
        : createAuthorizationService({
            ...ROLES,
            owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
          }),
      undefined,
      undefined,
      undefined,
      { ai },
    );
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const org = async (token: string, name: string) => {
      const response = await ctx.app.request(
        '/v1/organizations',
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      );
      return ((await response.json()) as { organization: { id: string } }).organization.id;
    };
    const orgA = await org('token-alice', 'A');
    const actions = async (token: string, organizationId = orgA) => {
      const response = await ctx.app.request(
        `/v1/organizations/${organizationId}/decisions/actions`,
        ctx.as(token),
      );
      return {
        status: response.status,
        body: (await response.json()) as { actions?: Action[]; error?: string },
      };
    };
    const send = async (token: string, path: string, body: unknown, organizationId = orgA) => {
      const response = await ctx.app.request(
        `/v1/organizations/${organizationId}${path}`,
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await response.json()) as Json };
    };
    const decide = (token: string, body: unknown, organizationId = orgA) =>
      send(token, '/decisions', body, organizationId);
    return { actions, orgA, ctx, send, decide };
  }

  it('lists what GIA may prepare for the owner, each with its condition and cost', async () => {
    const { actions } = await setup();
    const read = await actions('token-alice');
    expect(read.status).toBe(200);
    expect(read.body.actions).toEqual([
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
      // Nothing carries a discount out yet: it is decided on, never prepared.
      {
        action: 'opportunity.offer_discount',
        outcome: 'unavailable',
        confirmation: 'person_confirms',
        maxCredits: 0,
        reasons: ['not_configured'],
      },
    ]);
  });

  it('says why an action is not offered: the role lacks its permission', async () => {
    const role = await setup({ without: ['specialist.task'] });
    expect((await role.actions('token-alice')).body.actions?.[2]).toMatchObject({
      action: 'agent_task.assign',
      outcome: 'unavailable',
      reasons: ['permission_denied'],
    });
  });

  it('needs gia.ask, and another organization answers as forbidden', async () => {
    const { actions, orgA } = await setup();
    expect((await actions('token-bob', orgA)).status).toBe(403);
    const noGia = await setup({ without: ['gia.ask'] });
    expect(await noGia.actions('token-alice')).toEqual({
      status: 403,
      body: { error: 'permission_denied' },
    });
  });

  // DE-1 end to end, on the real services and storage: records, Company Brain, audit.
  it('decides what to attend to first from the real records, explains it and audits it', async () => {
    const { ctx, send, decide, orgA } = await setup();
    await ctx.app.request(
      `/v1/organizations/${orgA}/business-profile`,
      ctx.as('token-alice', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          businessType: 'restaurant',
          country: 'PE',
          currency: 'PEN',
          timeZone: 'America/Lima',
          city: 'Lima',
        }),
      }),
    );
    const today = dateIn('America/Lima', new Date());
    const day = (offset: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const juan = await send('token-alice', '/customers', {
      displayName: 'Juan',
      phone: '+51911111111',
      stage: 'lead',
    });
    const sale = await send('token-alice', '/opportunities', {
      contactId: juan.body.id,
      title: 'Equipos para Juan',
      value: { amountMinor: 1_200_000 },
      nextAction: { text: 'Llamar a Juan', dueOn: day(-2) },
    });
    const before = (await ctx.auditEvents()).length;
    const decided = await decide('token-alice', { type: 'commercial.priorities' });
    expect(decided.status).toBe(200);
    const decision = decided.body.decision as Json & { items: Json[] };
    expect(decision).toMatchObject({
      type: 'commercial.priorities',
      category: 'priority',
      outcome: 'attention_needed',
      priority: 'high',
      requiredApproval: false,
      model: null,
    });
    expect(decision.items[0]).toMatchObject({
      outcome: 'next_action_overdue',
      priority: 'high',
      subject: { type: 'opportunity', id: sale.body.id, label: 'Equipos para Juan' },
      reasons: [{ code: 'overdue_next_action', params: { days: 2, amountMinor: 1_200_000 } }],
      recommendedAction: { code: 'do_next_action', action: null },
    });
    // Only the decision was recorded: nothing changed, scheduled or sent.
    const events = (await ctx.auditEvents()).slice(before);
    expect(events.map((e) => [e.action, e.result, e.reason])).toEqual([
      ['decision.evaluated', 'success', 'attention_needed'],
    ]);
    expect(events[0]).toMatchObject({
      target: { type: 'decision', id: decision.id },
      decision: { type: 'commercial.priorities', version: 1 },
    });
    expect(JSON.stringify(events)).not.toMatch(/Juan|Equipos|1200000/);
  });

  it('a 30% discount above the company policy of 20% needs approval; nothing is executed', async () => {
    const { send, decide, ctx } = await setup();
    const policy = await send('token-alice', '/brain/knowledge', {
      domain: 'policies',
      key: 'discount_approval_above_percent',
      label: 'Descuentos que necesitan aprobación',
      value: { type: 'number', number: 20 },
    });
    expect(policy.status).toBeLessThan(300);
    const before = (await ctx.auditEvents()).length;
    const decided = await decide('token-alice', {
      type: 'action.policy_check',
      input: { action: 'opportunity.offer_discount', discountPercent: 30 },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.decision).toMatchObject({
      outcome: 'approval_required',
      requiredApproval: true,
      reasons: [
        { code: 'discount_above_policy', params: { discountPercent: 30, limitPercent: 20 } },
      ],
      recommendedAction: { code: 'ask_owner_approval', action: null },
      // Nothing carries a discount out here, and the decision says so.
      constraints: ['not_carried_out_here'],
      sourceContext: { sources: ['action_catalogue', 'company_brain.policies'] },
    });
    expect((await ctx.auditEvents()).slice(before).map((e) => e.action)).toEqual([
      'decision.evaluated',
    ]);
  });

  it('lists the decision types; refuses without the permission, for another organization, or with bad input', async () => {
    const { decide, orgA, ctx } = await setup();
    const types = await ctx.app.request(
      `/v1/organizations/${orgA}/decisions/types`,
      ctx.as('token-alice'),
    );
    expect(((await types.json()) as { types: Json[] }).types.map((t) => t.type)).toEqual([
      'commercial.priorities',
      'action.policy_check',
      'forecast.signal',
      'agent.routing',
    ]);
    expect((await decide('token-bob', { type: 'commercial.priorities' })).status).toBe(403);
    // Context is never taken from a request: the engine reads it as the person.
    expect(
      (await decide('token-alice', { type: 'commercial.priorities', preload: {} })).body,
    ).toEqual({ error: 'invalid_request' });
    expect((await decide('token-alice', { type: 'Pay Now' })).status).toBe(400);
    expect(await decide('token-alice', { type: 'payments.pay' })).toEqual({
      status: 404,
      body: { error: 'unknown_decision_type' },
    });
    expect(
      await decide('token-alice', { type: 'action.policy_check', input: { action: 'x' } }),
    ).toEqual({ status: 400, body: { error: 'invalid_input', field: 'action' } });
    // No Forecasting Engine is set up in this test: nothing is pretended.
    expect(
      await decide('token-alice', {
        type: 'forecast.signal',
        input: { forecastId: `fc_${'a'.repeat(40)}` },
      }),
    ).toEqual({ status: 503, body: { error: 'not_configured' } });
    const denied = await setup({ without: ['decision.evaluate'] });
    expect(await denied.decide('token-alice', { type: 'commercial.priorities' })).toEqual({
      status: 403,
      body: { error: 'permission_denied' },
    });
  });
});
