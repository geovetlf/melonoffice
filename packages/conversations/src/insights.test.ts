import type {
  ChannelConnectionId,
  ChannelIdentityId,
  Contact,
  ContactId,
  ContactStage,
  Conversation,
  ConversationId,
  InitialBilling,
  IsoTimestamp,
  Opportunity,
  OpportunityId,
  Organization,
  OrganizationId,
  Pipeline,
  PipelineId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import { createAuthorizationService, ROLES, type RoleCatalogue } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createCustomerService } from './customers.js';
import { createOpportunityService } from './opportunities.js';
import { InMemoryConversationRepository } from './repository.js';
import {
  commercialInsights,
  createCommercialInsights,
  dateIn,
  type CommercialInsights,
  type InsightInput,
} from './insights.js';

const ORG = 'org_a' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
// Wednesday 30 September 2026, 10:00 in Lima.
const NOW = new Date('2026-09-30T15:00:00Z');
const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const created = organization.createdAt;
  return {
    account: {
      organizationId: organization.id,
      subscriptionId,
      createdAt: created,
      updatedAt: created,
    },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: created,
      updatedAt: created,
    },
  };
};
const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });
const at = (date: string) => `${date}T15:00:00.000Z` as IsoTimestamp;

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

function contact(
  name: string,
  stage: ContactStage,
  updated: string,
  extra: Partial<NonNullable<Contact['commercial']>> = {},
  organizationId = ORG,
): Contact {
  return {
    id: `contact_${uuid()}` as ContactId,
    organizationId,
    displayName: name,
    phone: '+51900000000',
    status: 'active',
    origin: { kind: 'user', userId: ALICE },
    commercial: {
      stage,
      source: { kind: 'channel' },
      consent: { messaging: 'unknown' },
      stageChangedAt: at(updated),
      ...extra,
    },
    revision: 1,
    createdAt: at(updated),
    updatedAt: at(updated),
  };
}

function opportunity(
  title: string,
  of: Contact,
  fields: Partial<Opportunity> & { readonly updated: string },
): Opportunity {
  const { updated, ...rest } = fields;
  return {
    id: uuid() as OpportunityId,
    organizationId: of.organizationId,
    contactId: of.id,
    pipelineId: `${ORG}_main` as PipelineId,
    stageId: 'quote',
    status: 'open',
    title,
    probability: 40,
    stageChangedAt: at(updated),
    revision: 1,
    createdBy: ALICE,
    createdAt: at(updated),
    updatedAt: at(updated),
    ...rest,
  };
}

function conversation(of: Contact, inbound: string, outbound?: string): Conversation {
  return {
    id: uuid() as ConversationId,
    organizationId: of.organizationId,
    contactId: of.id,
    channelIdentityId: uuid() as ChannelIdentityId,
    channel: 'whatsapp',
    connectionId: uuid() as ChannelConnectionId,
    status: 'open',
    priority: 'normal',
    tags: [],
    lastMessageAt: (outbound !== undefined && outbound > inbound
      ? outbound
      : inbound) as IsoTimestamp,
    lastInboundAt: inbound as IsoTimestamp,
    ...(outbound === undefined ? {} : { lastOutboundAt: outbound as IsoTimestamp }),
    createdAt: inbound as IsoTimestamp,
    updatedAt: inbound as IsoTimestamp,
    revision: 1,
  };
}

const PIPELINE: Pipeline = {
  id: `${ORG}_main` as PipelineId,
  organizationId: ORG,
  template: 'restaurant',
  stages: [
    { id: 'inquiry', kind: 'open', probability: 20 },
    { id: 'quote', kind: 'open', probability: 40 },
    { id: 'confirmation', kind: 'open', name: 'Confirmado', probability: 80 },
    { id: 'won', kind: 'won', probability: 100 },
    { id: 'lost', kind: 'lost', probability: 0 },
  ],
  revision: 1,
  createdAt: at('2026-09-01'),
  updatedAt: at('2026-09-01'),
};

const counts = (list: readonly Contact[]) => ({
  lead: list.filter((c) => c.commercial?.stage === 'lead').length,
  customer: list.filter((c) => c.commercial?.stage === 'customer').length,
  inactive: list.filter((c) => c.commercial?.stage === 'inactive').length,
});

function input(
  contacts: readonly Contact[],
  opportunities: readonly Opportunity[],
  extra: Partial<InsightInput> = {},
): InsightInput {
  return {
    timeZone: 'America/Lima',
    now: NOW,
    viewer: ALICE,
    currency: 'PEN',
    contacts: { items: contacts, counts: counts(contacts), partial: false },
    opportunities: {
      items: opportunities,
      counts: {
        open: opportunities.filter((o) => o.status === 'open').length,
        won: opportunities.filter((o) => o.status === 'won').length,
        lost: opportunities.filter((o) => o.status === 'lost').length,
      },
      pipeline: PIPELINE,
      partial: false,
    },
    ...extra,
  };
}

/** The restaurant of C4's main scenario: 3 leads, 2 customers, 4 opportunities. */
function restaurant() {
  const ana = contact('Ana', 'lead', '2026-09-20');
  const beto = contact('Beto', 'lead', '2026-09-26');
  const carla = contact('Carla', 'lead', '2026-09-29');
  const diego = contact('Diego', 'customer', '2026-06-01');
  const elena = contact('Elena', 'customer', '2026-09-29', { ownerId: BOB });
  const boda = opportunity('Catering boda', ana, {
    updated: '2026-09-25',
    value: { amountMinor: 1_200_000, currency: 'PEN' },
    nextAction: { text: 'Enviar cotización final', dueOn: '2026-09-27' },
    ownerId: ALICE,
  });
  const cumple = opportunity('Cumpleaños 50 personas', beto, {
    updated: '2026-09-26',
    value: { amountMinor: 800_000, currency: 'PEN' },
    expectedCloseOn: '2026-10-03',
    nextAction: { text: 'Confirmar menú', dueOn: '2026-10-02' },
  });
  const almuerzo = opportunity('Almuerzo corporativo', diego, {
    updated: '2026-06-01',
    stageId: 'won',
    status: 'won',
    probability: 100,
    value: { amountMinor: 250_000, currency: 'PEN' },
    closedAt: at('2026-06-01'),
  });
  const semanal = opportunity('Pedido semanal', elena, {
    updated: '2026-09-29',
    stageId: 'inquiry',
    value: { amountMinor: 150_000, currency: 'PEN' },
    nextAction: { text: 'Llamar', dueOn: '2026-10-05' },
  });
  return {
    ana,
    beto,
    carla,
    diego,
    elena,
    boda,
    cumple,
    almuerzo,
    semanal,
    contacts: [ana, beto, carla, diego, elena],
    opportunities: [boda, cumple, almuerzo, semanal],
  };
}

const recordOf = (insights: CommercialInsights, ref: string) =>
  insights.records.opportunities.find((o) => o.ref === ref) ??
  insights.records.contacts.find((c) => c.ref === ref) ??
  insights.records.conversations.find((v) => v.ref === ref);

describe('commercial insights (C4)', () => {
  it('lists what to attend to today, most pressing first, each with its reason', () => {
    const r = restaurant();
    const insights = commercialInsights(input(r.contacts, r.opportunities));
    expect(insights).toMatchObject({ today: '2026-09-30', weekStart: '2026-09-28' });
    expect(insights.attention.map((a) => [recordOf(insights, a.ref), a.reasons])).toEqual([
      [
        expect.objectContaining({
          title: 'Catering boda',
          value: { amountMinor: 1_200_000, currency: 'PEN' },
        }),
        [{ kind: 'overdue_next_action', date: '2026-09-27', days: 3 }],
      ],
      [
        expect.objectContaining({ title: 'Cumpleaños 50 personas', expectedCloseOn: '2026-10-03' }),
        [{ kind: 'closing_soon', date: '2026-10-03', days: 3 }],
      ],
      [
        expect.objectContaining({ name: 'Carla', stage: 'lead' }),
        [{ kind: 'lead_without_follow_up', date: '2026-09-29', days: 1 }],
      ],
      [
        expect.objectContaining({ name: 'Diego', stage: 'customer' }),
        [{ kind: 'inactive_customer', date: '2026-06-01', days: 121 }],
      ],
    ]);
    // Each opportunity names its contact and responsible person as the reader understands it.
    const boda = recordOf(insights, insights.attention[0]?.ref ?? '');
    expect(boda).toMatchObject({ owner: 'you', stage: { id: 'quote', name: null } });
    expect(recordOf(insights, (boda as { contact: string }).contact)).toMatchObject({
      name: 'Ana',
    });
  });

  it('counts leads, customers, opportunities, pipeline value and sales', () => {
    const r = restaurant();
    const insights = commercialInsights(input(r.contacts, r.opportunities));
    expect(insights.contacts).toMatchObject({
      counts: { lead: 3, customer: 2, inactive: 0 },
      leadsWithoutNextAction: 1,
      inactiveCustomers: 1,
      overdueNextAction: 0,
    });
    expect(insights.opportunities).toMatchObject({
      counts: { open: 3, won: 1, lost: 0 },
      openValue: [{ currency: 'PEN', amountMinor: 2_150_000, count: 3 }],
      wonValue: [{ currency: 'PEN', amountMinor: 250_000, count: 1 }],
      wonThisMonth: [],
      closingSoon: 1,
      overdueNextAction: 1,
      closeDatePassed: 0,
    });
    const stages = insights.opportunities?.stages ?? [];
    expect(stages.map((s) => [s.id, s.count])).toEqual([
      ['inquiry', 1],
      ['quote', 2],
      ['confirmation', 0],
      ['won', 1],
      ['lost', 0],
    ]);
    expect(stages[2]?.name).toBe('Confirmado');
    // The highest open values, and the latest wins, are named.
    expect(
      insights.lists.highestValue.map(
        (ref) => (recordOf(insights, ref) as { title: string }).title,
      ),
    ).toEqual(['Catering boda', 'Cumpleaños 50 personas', 'Pedido semanal']);
    expect(
      insights.lists.activeLeads.map((ref) => (recordOf(insights, ref) as { name: string }).name),
    ).toEqual(['Carla']);
  });

  it('never adds amounts in different currencies', () => {
    const r = restaurant();
    const dollars = opportunity('Evento turistas', r.beto, {
      updated: '2026-09-29',
      value: { amountMinor: 100_000, currency: 'USD' },
    });
    const insights = commercialInsights(input(r.contacts, [...r.opportunities, dollars]));
    expect(insights.opportunities?.openValue).toEqual([
      { currency: 'PEN', amountMinor: 2_150_000, count: 3 },
      { currency: 'USD', amountMinor: 100_000, count: 1 },
    ]);
    // Highest values are compared only within a currency.
    expect(insights.lists.highestValue).toHaveLength(4);
    const quote = insights.opportunities?.stages.find((s) => s.id === 'quote');
    // Also per stage: the dollars stand apart from the soles.
    expect(quote?.value).toEqual([
      { currency: 'PEN', amountMinor: 2_000_000, count: 2 },
      { currency: 'USD', amountMinor: 100_000, count: 1 },
    ]);
  });

  it('dates everything in the business time zone', () => {
    const lead = contact('Rosa', 'lead', '2026-09-20', {
      nextAction: { text: 'Llamar', dueOn: '2026-09-30' },
    });
    // 22:00 on 30 September in Lima is already 1 October in UTC.
    const late = new Date('2026-10-01T03:00:00Z');
    const lima = commercialInsights(input([lead], [], { now: late }));
    expect(lima.today).toBe('2026-09-30');
    expect(lima.attention[0]?.reasons).toEqual([
      { kind: 'next_action_today', date: '2026-09-30', days: 0 },
    ]);
    const tokyo = commercialInsights(input([lead], [], { now: late, timeZone: 'Asia/Tokyo' }));
    expect(tokyo.today).toBe('2026-10-01');
    expect(tokyo.attention[0]?.reasons).toEqual([
      { kind: 'overdue_next_action', date: '2026-09-30', days: 1 },
    ]);
    expect(dateIn('America/Lima', '2026-10-01T03:00:00Z')).toBe('2026-09-30');
  });

  it('flags a conversation waiting for an answer, a passed close date and a quiet high value', () => {
    const r = restaurant();
    const quiet = opportunity('Buffet aniversario', r.elena, {
      updated: '2026-09-01',
      value: { amountMinor: 2_000_000, currency: 'PEN' },
      expectedCloseOn: '2026-09-20',
    });
    const waiting = conversation(r.carla, '2026-09-29T18:00:00.000Z', '2026-09-29T12:00:00.000Z');
    const answered = conversation(r.beto, '2026-09-29T12:00:00.000Z', '2026-09-29T13:00:00.000Z');
    const insights = commercialInsights(
      input(r.contacts, [...r.opportunities, quiet], { conversations: [waiting, answered] }),
    );
    expect(insights.conversations).toEqual({ waitingReply: 1 });
    const reasons = Object.fromEntries(
      insights.attention.map((a) => [
        (recordOf(insights, a.ref) as { title?: string; name?: string; id: string }).title ??
          (recordOf(insights, a.ref) as { id: string }).id,
        a.reasons.map((x) => x.kind),
      ]),
    );
    expect(reasons['Buffet aniversario']).toEqual(['close_date_passed', 'quiet_high_value']);
    expect(reasons[waiting.id]).toEqual(['waiting_reply']);
    expect(insights.records.conversations[0]).toMatchObject({ id: waiting.id });
    expect(recordOf(insights, insights.records.conversations[0]?.contact ?? '')).toMatchObject({
      name: 'Carla',
    });
  });

  it('says there is nothing when there are no records', () => {
    const insights = commercialInsights(input([], [], { conversations: [] }));
    expect(insights.attention).toEqual([]);
    expect(insights.contacts?.counts).toEqual({ lead: 0, customer: 0, inactive: 0 });
    expect(insights.opportunities).toMatchObject({
      counts: { open: 0, won: 0, lost: 0 },
      openValue: [],
      wonValue: [],
    });
    expect(Object.values(insights.lists).every((l) => l.length === 0)).toBe(true);
    expect(insights.records).toEqual({ contacts: [], opportunities: [], conversations: [] });
  });

  it('leaves out, whole, what the person may not read', () => {
    const r = restaurant();
    const all = input(r.contacts, r.opportunities);
    const insights = commercialInsights({ ...all, contacts: undefined } as never);
    expect(insights.contacts).toBeNull();
    expect(insights.conversations).toBeNull();
    expect(insights.records.contacts).toEqual([]);
    // Opportunities do not reveal their contacts' names.
    expect(insights.records.opportunities.every((o) => o.contact === null)).toBe(true);
    expect(JSON.stringify(insights)).not.toContain('Ana');
  });
});

describe('the commercial insight service (C4)', () => {
  async function world(roles: RoleCatalogue = ROLES) {
    let tick = 0;
    const now = () => new Date(NOW.getTime() + 1000 * tick++);
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
    // The owner sets everything up; the reader may have fewer permissions.
    const owner = createAuthorizationService(ROLES);
    const services = (authorization: ReturnType<typeof createAuthorizationService>) => {
      const customers = createCustomerService({
        repository,
        organizations: tenancy,
        authorization,
        now,
      });
      const opportunities = createOpportunityService({
        repository,
        organizations: tenancy,
        authorization,
        businessType: async () => 'restaurant',
        currency: async () => 'PEN',
        now,
      });
      return { customers, opportunities };
    };
    const setup = services(owner);
    const reader = services(createAuthorizationService(roles));
    const insights = createCommercialInsights({
      ...reader,
      conversations: repository,
      authorization: createAuthorizationService(roles),
      timeZone: async () => 'America/Lima',
      currency: async () => 'PEN',
      now: () => NOW,
    });
    return {
      audit,
      repository,
      setup,
      insights,
      alice: await resolveTenant(as(ALICE), a.organization.id, tenancy),
      aliceAsGia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
      bob: await resolveTenant(as(BOB), b.organization.id, tenancy),
      orgA: a.organization.id,
    };
  }

  async function seed(w: Awaited<ReturnType<typeof world>>) {
    const ana = await w.setup.customers.create(w.alice, {
      displayName: 'Ana',
      phone: '+51911111111',
    });
    await w.setup.opportunities.create(w.alice, {
      contactId: ana.id,
      title: 'Catering boda',
      value: { amountMinor: 1_200_000 },
      nextAction: { text: 'Enviar cotización', dueOn: '2026-09-27' },
    });
    const stranger = await w.setup.customers.create(w.bob, {
      displayName: 'Extraño',
      phone: '+51922222222',
    });
    await w.setup.opportunities.create(w.bob, { contactId: stranger.id, title: 'Venta ajena' });
  }

  it('reads through the C1 and C2 services, only the organization’s own records, changing nothing', async () => {
    const w = await world();
    await seed(w);
    const before = {
      events: w.audit.events().length,
      contacts: JSON.stringify(await w.repository.listContacts(w.orgA)),
      opportunities: JSON.stringify(await w.repository.listOpportunities(w.orgA)),
    };
    const insights = await w.insights.read(w.alice);
    expect(insights.contacts?.counts).toEqual({ lead: 1, customer: 0, inactive: 0 });
    expect(insights.opportunities?.counts).toEqual({ open: 1, won: 0, lost: 0 });
    expect(insights.attention[0]?.reasons[0]).toEqual({
      kind: 'overdue_next_action',
      date: '2026-09-27',
      days: 3,
    });
    expect(JSON.stringify(insights)).not.toContain('Extraño');
    expect(JSON.stringify(insights)).not.toContain('Venta ajena');
    // GIA reads as the person, too: reading is allowed to her, changing never is.
    await w.insights.read(w.aliceAsGia);
    expect(w.audit.events()).toHaveLength(before.events);
    expect(JSON.stringify(await w.repository.listContacts(w.orgA))).toBe(before.contacts);
    expect(JSON.stringify(await w.repository.listOpportunities(w.orgA))).toBe(before.opportunities);
  });

  it('leaves out each part the person may not read', async () => {
    const w = await world({ ...ROLES, owner: ['opportunity.read'] });
    await seed(w);
    const partial = await w.insights.read(w.alice);
    expect(partial.contacts).toBeNull();
    expect(partial.conversations).toBeNull();
    expect(partial.opportunities?.counts.open).toBe(1);
    expect(JSON.stringify(partial)).not.toContain('Ana');

    const n = await world({ ...ROLES, owner: [] });
    await seed(n);
    expect(await n.insights.read(n.alice)).toMatchObject({
      contacts: null,
      opportunities: null,
      conversations: null,
      attention: [],
    });
  });

  it('refuses an unresolved tenant', async () => {
    const w = await world();
    await expect(w.insights.read({ kind: 'unresolved' } as never)).rejects.toMatchObject({
      code: 'unresolved_tenant',
    });
  });
});
