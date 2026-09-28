import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  ChannelConnectionId,
  InitialBilling,
  IsoTimestamp,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createCustomerService } from './customers.js';
import { ConversationError } from './errors.js';
import { createOpportunityService, pipelineSummary } from './opportunities.js';
import { checkStages, proposedPipeline, templateFor } from './pipeline.js';
import { InMemoryConversationRepository } from './repository.js';
import { createConversationIngress } from './service.js';

const T0 = new Date('2026-09-28T17:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;

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
    if (error instanceof ConversationError)
      return `${error.code}${error.detail ? `:${error.detail}` : ''}`;
    throw error;
  }
  return 'accepted';
}

async function world(businessTypes: Record<string, string> = {}) {
  let tick = 0;
  const now = () => new Date(T0.getTime() + 1000 * tick++);
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(
    now,
    audit,
    undefined,
    new InMemoryDepartmentRepository(),
  );
  const options = {
    billing: BILLING,
    credits: openWallet,
    departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
  };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
  const repository = new InMemoryConversationRepository(audit);
  const authorization = createAuthorizationService();
  let n = 0;
  const newId = () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const customers = createCustomerService({
    repository,
    organizations: tenancy,
    authorization,
    now,
    newId,
  });
  let s = 0;
  const opportunities = createOpportunityService({
    repository,
    organizations: tenancy,
    authorization,
    businessType: async (org: OrganizationId) =>
      businessTypes[org === a.organization.id ? 'A' : 'B'],
    currency: async () => 'PEN',
    now,
    newId,
    newStageId: () => `stage_${'abcdefgh'.slice(0, ++s)}`,
  });
  return {
    audit,
    repository,
    customers,
    opportunities,
    alice: await resolveTenant(as(ALICE), a.organization.id, tenancy),
    aliceAsGia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
    bob: await resolveTenant(as(BOB), b.organization.id, tenancy),
    orgA: a.organization.id,
  };
}

const actions = (audit: InMemoryAuditStore, prefix = 'opportunity.') =>
  audit
    .events()
    .filter((e) => e.action.startsWith(prefix))
    .map((e) => e.action);

describe('pipeline templates (C2, ADR-0054)', () => {
  it('proposes stages for the kind of business, and the general ones otherwise', () => {
    const org = '33333333-3333-4333-8333-333333333333' as OrganizationId;
    const at = T0.toISOString() as IsoTimestamp;
    const restaurant = proposedPipeline(org, 'restaurant', at);
    expect(restaurant.stages.map((s) => [s.id, s.kind])).toEqual([
      ['inquiry', 'open'],
      ['quote', 'open'],
      ['confirmation', 'open'],
      ['won', 'won'],
      ['lost', 'lost'],
    ]);
    expect(restaurant.template).toBe('restaurant');
    expect(templateFor(undefined)).toBe('general');
    expect(templateFor('something_new')).toBe('general');
    expect(proposedPipeline(org, 'workshop', at).stages[0]).toMatchObject({
      id: 'diagnosis',
      nameKey: 'pipeline.stage.diagnosis',
    });
  });

  it('checks stages: open ones first, won and lost last and kept, names and probabilities', () => {
    const current = proposedPipeline(
      '33333333-3333-4333-8333-333333333333' as OrganizationId,
      'restaurant',
      T0.toISOString() as IsoTimestamp,
    ).stages;
    const next = checkStages(
      current,
      [
        { id: 'quote', name: 'Presupuesto', probability: 40 },
        { name: 'Degustación', probability: 60 },
        { id: 'won' },
        { id: 'lost', name: 'No compró' },
      ],
      () => 'stage_new',
    );
    expect(next).toEqual([
      { id: 'quote', kind: 'open', name: 'Presupuesto', probability: 40 },
      { id: 'stage_new', kind: 'open', name: 'Degustación', probability: 60 },
      { id: 'won', kind: 'won', nameKey: 'pipeline.stage.won', probability: 100 },
      { id: 'lost', kind: 'lost', name: 'No compró', probability: 0 },
    ]);
    const refused = (stages: unknown) => {
      try {
        checkStages(current, stages, () => 'stage_x');
        return 'accepted';
      } catch (error) {
        return (error as ConversationError).detail;
      }
    };
    expect(refused([{ id: 'won' }, { id: 'lost' }])).toBe('stages'); // no open stage
    expect(refused([{ id: 'quote', probability: 30 }, { id: 'won' }])).toBe('stages'); // no lost
    expect(refused([{ id: 'won' }, { id: 'quote', probability: 30 }, { id: 'lost' }])).toBe(
      'stages.1',
    );
    expect(refused([{ id: 'quote', probability: 101 }, { id: 'won' }, { id: 'lost' }])).toBe(
      'stages.0.probability',
    );
    expect(refused([{ probability: 10 }, { id: 'won' }, { id: 'lost' }])).toBe('stages.0.name');
    expect(refused([{ id: 'nope', probability: 10 }, { id: 'won' }, { id: 'lost' }])).toBe(
      'stages.0.id',
    );
    expect(
      refused([{ id: 'quote', probability: 10 }, { id: 'won', probability: 50 }, { id: 'lost' }]),
    ).toBe('stages.1.probability');
  });

  it('adds amounts only in the business currency', () => {
    const base = {
      stageId: 'quote',
      status: 'open',
    } as const;
    const summary = pipelineSummary(
      [
        { ...base, value: { amountMinor: 1000, currency: 'PEN' } },
        { ...base, value: { amountMinor: 999, currency: 'USD' } },
        { ...base, stageId: 'won', status: 'won' },
      ] as never,
      'PEN',
    );
    expect(summary.open).toEqual({ count: 2, valueMinor: 1000 });
    expect(summary.won).toBe(1);
    expect(summary.stages.quote).toEqual({ count: 2, valueMinor: 1000 });
  });
});

describe('opportunities (C2, ADR-0054)', () => {
  it('shows the proposal for the business until it is stored, then stores it with the first opportunity', async () => {
    const w = await world({ A: 'restaurant' });
    const view = await w.opportunities.pipeline(w.alice);
    expect(view.stored).toBe(false);
    expect(view.pipeline.template).toBe('restaurant');
    const contact = await w.customers.create(w.alice, {
      displayName: 'Rosa',
      phone: '+51922222222',
    });
    const opportunity = await w.opportunities.create(w.alice, {
      contactId: contact.id,
      title: 'Cena de empresa',
      value: { amountMinor: 150000 },
    });
    expect(opportunity).toMatchObject({
      stageId: 'inquiry',
      status: 'open',
      probability: 20,
      value: { amountMinor: 150000, currency: 'PEN' },
      revision: 1,
      createdBy: ALICE,
    });
    expect((await w.opportunities.pipeline(w.alice)).stored).toBe(true);
    expect(actions(w.audit, 'pipeline.')).toEqual(['pipeline.created']);
    expect(w.audit.events().find((e) => e.action === 'pipeline.created')?.reason).toBe(
      'restaurant',
    );
  });

  it('turns a WhatsApp contact into a lead, then a customer when the opportunity is won', async () => {
    const w = await world();
    const { conversation } = await createConversationIngress({ repository: w.repository }).receive({
      organizationId: w.orgA,
      connectionId: CONNECTION,
      channel: 'whatsapp',
      externalMessageId: 'wamid.C2TEST1',
      from: { externalId: '51933333333', displayName: 'Luis', phone: '+51933333333' },
      type: 'text',
      text: 'Hola',
      attachments: [],
      sentAt: '2026-09-28T16:00:00.000Z' as IsoTimestamp,
    });
    const opp = await w.opportunities.create(w.alice, {
      contactId: conversation.contactId,
      title: 'Pedido mayorista',
    });
    let contact = await w.repository.findContact(w.orgA, conversation.contactId);
    expect(contact?.commercial).toMatchObject({ stage: 'lead', source: { kind: 'channel' } });
    const moved = await w.opportunities.update(w.alice, opp.id, {
      revision: 1,
      stageId: 'proposal',
    });
    expect(moved).toMatchObject({ stageId: 'proposal', probability: 50, revision: 2 });
    const won = await w.opportunities.update(w.alice, opp.id, { revision: 2, stageId: 'won' });
    expect(won).toMatchObject({ status: 'won', probability: 100, closedAt: expect.any(String) });
    contact = await w.repository.findContact(w.orgA, conversation.contactId);
    expect(contact?.commercial?.stage).toBe('customer');
    expect(actions(w.audit)).toEqual([
      'opportunity.created',
      'opportunity.stage_changed',
      'opportunity.won',
    ]);
    const stageChanges = w.audit.events().filter((e) => e.action === 'contact.stage_changed');
    expect(stageChanges.map((e) => e.transition)).toEqual([
      { from: 'none', to: 'lead' },
      { from: 'lead', to: 'customer' },
    ]);
    // A won opportunity changes only by being reopened.
    expect(
      await codeOf(w.opportunities.update(w.alice, opp.id, { revision: 3, title: 'Otro' })),
    ).toBe('opportunity_closed');
  });

  it('loses an opportunity with a reason, and the contact keeps its stage', async () => {
    const w = await world();
    const contact = await w.customers.create(w.alice, {
      displayName: 'Ana',
      email: 'ana@example.com',
    });
    const opp = await w.opportunities.create(w.alice, { contactId: contact.id, title: 'Web' });
    expect(
      await codeOf(w.opportunities.update(w.alice, opp.id, { revision: 1, stageId: 'lost' })),
    ).toBe('invalid_request:lostReason');
    const lost = await w.opportunities.update(w.alice, opp.id, {
      revision: 1,
      stageId: 'lost',
      lostReason: 'price',
    });
    expect(lost).toMatchObject({ status: 'lost', probability: 0, lostReason: 'price' });
    expect((await w.repository.findContact(w.orgA, contact.id))?.commercial?.stage).toBe('lead');
    const event = w.audit.events().find((e) => e.action === 'opportunity.lost');
    expect(event).toMatchObject({ reason: 'price', transition: { from: 'new', to: 'lost' } });
    // Reopened to an open stage: the loss is cleared.
    const reopened = await w.opportunities.update(w.alice, opp.id, {
      revision: 2,
      stageId: 'contacted',
    });
    expect(reopened).toMatchObject({ status: 'open', probability: 25 });
    expect(reopened.lostReason).toBeUndefined();
    expect(reopened.closedAt).toBeUndefined();
    expect(actions(w.audit).at(-1)).toBe('opportunity.reopened');
  });

  it('changes details against the revision, audited without title, amounts or names', async () => {
    const w = await world();
    const contact = await w.customers.create(w.alice, {
      displayName: 'Carmen',
      phone: '+51944444444',
    });
    const opp = await w.opportunities.create(w.alice, {
      contactId: contact.id,
      title: 'Catering boda',
    });
    const changed = await w.opportunities.update(w.alice, opp.id, {
      revision: 1,
      value: { amountMinor: 880000, currency: 'PEN' },
      probability: 35,
      ownerId: ALICE,
      expectedCloseOn: '2026-10-15',
      nextAction: { text: 'Enviar menú', dueOn: '2026-09-30' },
    });
    expect(changed).toMatchObject({
      revision: 2,
      probability: 35,
      ownerId: ALICE,
      expectedCloseOn: '2026-10-15',
    });
    expect(await codeOf(w.opportunities.update(w.alice, opp.id, { revision: 1, title: 'X' }))).toBe(
      'opportunity_concurrency_conflict',
    );
    expect(
      await codeOf(w.opportunities.update(w.alice, opp.id, { revision: 2, ownerId: BOB })),
    ).toBe('owner_not_member');
    const same = await w.opportunities.update(w.alice, opp.id, { revision: 2, probability: 35 });
    expect(same.revision).toBe(2);
    const trail = JSON.stringify(w.audit.events());
    for (const personal of ['Carmen', 'Catering', '880000', 'Enviar', '944444444']) {
      expect(trail).not.toContain(personal);
    }
    expect(
      w.audit
        .events()
        .filter((e) => e.action === 'opportunity.updated')
        .map((e) => e.reason),
    ).toEqual(['value', 'expected_close', 'next_action', 'probability']);
  });

  it('never removes a stage an opportunity is at, and edits stages against the revision', async () => {
    const w = await world();
    const contact = await w.customers.create(w.alice, {
      displayName: 'Ana',
      email: 'ana@example.com',
    });
    await w.opportunities.create(w.alice, {
      contactId: contact.id,
      title: 'Web',
      stageId: 'proposal',
    });
    const stages = [
      { id: 'new', probability: 10 },
      { id: 'negotiation', probability: 75 },
      { id: 'won' },
      { id: 'lost' },
    ];
    expect(await codeOf(w.opportunities.savePipeline(w.alice, { revision: 1, stages }))).toBe(
      'stage_in_use',
    );
    expect(await codeOf(w.opportunities.savePipeline(w.alice, { revision: 0, stages: [] }))).toBe(
      'pipeline_concurrency_conflict',
    );
    const saved = await w.opportunities.savePipeline(w.alice, {
      revision: 1,
      stages: [
        { id: 'new', name: 'Primer contacto', probability: 10 },
        { id: 'proposal', probability: 50 },
        { name: 'Demo', probability: 60 },
        { id: 'won' },
        { id: 'lost' },
      ],
    });
    expect(saved.revision).toBe(2);
    expect(saved.stages.map((s) => s.id)).toEqual(['new', 'proposal', 'stage_a', 'won', 'lost']);
    expect(actions(w.audit, 'pipeline.')).toEqual(['pipeline.created', 'pipeline.updated']);
  });

  it('lets GIA read but never change, and keeps organizations apart', async () => {
    const w = await world();
    const contact = await w.customers.create(w.alice, {
      displayName: 'Ana',
      email: 'ana@example.com',
    });
    const opp = await w.opportunities.create(w.alice, { contactId: contact.id, title: 'Web' });
    expect((await w.opportunities.list(w.aliceAsGia)).items).toHaveLength(1);
    expect((await w.opportunities.get(w.aliceAsGia, opp.id)).opportunity.id).toBe(opp.id);
    expect(
      await codeOf(w.opportunities.create(w.aliceAsGia, { contactId: contact.id, title: 'X' })),
    ).toBe('requires_user');
    expect(
      await codeOf(w.opportunities.update(w.aliceAsGia, opp.id, { revision: 1, stageId: 'won' })),
    ).toBe('requires_user');
    expect(
      await codeOf(w.opportunities.update(w.runtime, opp.id, { revision: 1, stageId: 'won' })),
    ).toBe('requires_user');
    // Bob, in his organization, cannot see or use Alice's opportunity or contact.
    expect(await codeOf(w.opportunities.get(w.bob, opp.id))).toBe('opportunity_not_found');
    expect(
      await codeOf(w.opportunities.update(w.bob, opp.id, { revision: 1, stageId: 'won' })),
    ).toBe('opportunity_not_found');
    expect(await codeOf(w.opportunities.create(w.bob, { contactId: contact.id, title: 'X' }))).toBe(
      'contact_not_found',
    );
    expect((await w.opportunities.list(w.bob)).items).toHaveLength(0);
  });

  it('refuses bad input: unknown keys, a closed stage at creation, bad values', async () => {
    const w = await world();
    const contact = await w.customers.create(w.alice, {
      displayName: 'Ana',
      email: 'ana@example.com',
    });
    const create = (input: Record<string, unknown>) =>
      codeOf(w.opportunities.create(w.alice, { contactId: contact.id, title: 'Web', ...input }));
    expect(await create({ organizationId: w.orgA })).toBe('invalid_request:organizationId');
    expect(await create({ stageId: 'won' })).toBe('invalid_request:stageId');
    expect(await create({ stageId: 'nope' })).toBe('stage_not_found');
    expect(await create({ value: { amountMinor: 1.5 } })).toBe('invalid_request:value.amountMinor');
    expect(await create({ value: { amountMinor: -1 } })).toBe('invalid_request:value.amountMinor');
    expect(await create({ value: { amountMinor: 10, currency: 'soles' } })).toBe(
      'invalid_request:value.currency',
    );
    expect(await create({ expectedCloseOn: '15/10/2026' })).toBe('invalid_request:expectedCloseOn');
    expect(await create({ title: ' ' })).toBe('invalid_request:title');
  });
});
