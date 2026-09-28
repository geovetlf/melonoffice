import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import { DEFAULT_DEPARTMENT_CATALOGUE, provisionDepartments } from '@melonoffice/departments';
import type {
  BusinessProfile,
  InitialBilling,
  IsoTimestamp,
  Organization,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService, ROLES, type RoleCatalogue } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { BrainError } from './errors.js';
import { candidateOf, createGatewayKnowledgeExtractor } from './extractor.js';
import { checkKnowledgeInput, knowledgeItemId } from './knowledge.js';
import { InMemoryKnowledgeRepository } from './repository.js';
import { createCompanyBrain, type KnowledgeExtractor } from './service.js';
import {
  ingestFromConnection,
  operationalKnowledge,
  organizationKnowledge,
  profileKnowledge,
  recordResult,
} from './sources.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const NOW = new Date('2026-09-28T12:00:00Z');

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
    if (error instanceof BrainError) return error.code;
    throw error;
  }
  return 'accepted';
}

const price = (soles: number) => ({
  domain: 'products',
  key: 'price',
  subject: { type: 'product', id: 'combo_familiar' },
  label: 'Combo Familiar',
  value: { type: 'money', amountMinor: soles * 100, currency: 'PEN' },
});

async function world(
  options: { roles?: RoleCatalogue; extractor?: KnowledgeExtractor; clock?: () => Date } = {},
) {
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(() => NOW);
  const create = (user: UserId, name: string) =>
    createOrganization(as(user), { name }, tenancy, {
      billing: BILLING,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
      credits: openWallet,
    });
  const a = await create(ALICE, 'Pollería X');
  const b = await create(BOB, 'Otra empresa');
  const repository = new InMemoryKnowledgeRepository(audit);
  let tick = 0;
  const brain = createCompanyBrain({
    repository,
    organizations: tenancy,
    authorization: createAuthorizationService(options.roles ?? ROLES),
    ...(options.extractor === undefined ? {} : { extractor: options.extractor }),
    // Each change a second later, so versions and updates are ordered.
    now: options.clock ?? (() => new Date(NOW.getTime() + 1000 * tick++)),
  });
  return {
    audit,
    brain,
    repository,
    orgA: a.organization.id,
    orgB: b.organization.id,
    alice: await resolveTenant(as(ALICE), a.organization.id, tenancy),
    gia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
    bob: await resolveTenant(as(BOB), b.organization.id, tenancy),
    organizationA: a.organization,
  };
}

const events = (audit: InMemoryAuditStore) => audit.events().map((e) => e.action);

describe('Company Brain: creating and reading knowledge (ADR-0051)', () => {
  it('starts empty and is initialized with the organization it belongs to', async () => {
    const w = await world();
    expect((await w.brain.summary(w.alice)).initialized).toBe(false);
    const { source, facts } = organizationKnowledge(w.organizationA);
    await w.brain.ingest(w.alice, source, facts);
    const summary = await w.brain.summary(w.alice);
    expect(summary.initialized).toBe(true);
    expect(summary.byDomain.identity).toBe(1);
    const [item] = await w.brain.list(w.alice);
    expect(item?.value).toEqual({ type: 'text', text: 'Pollería X' });
    expect(item?.verification).toBe('confirmed');
    expect(item?.provenance.sourceType).toBe('user');
  });

  it('stores a fact with its provenance, and a person acting directly confirms it', async () => {
    const w = await world();
    const outcome = await w.brain.propose(w.alice, price(25));
    expect(outcome).toMatchObject({ outcome: 'created', revision: 1 });
    const { item, versions } = await w.brain.get(w.alice, outcome.itemId);
    expect(item).toMatchObject({
      domain: 'products',
      key: 'price',
      label: 'Combo Familiar',
      verification: 'confirmed',
      status: 'active',
      critical: true,
      sensitivity: 'internal',
      provenance: {
        sourceType: 'user',
        recordedBy: { type: 'user', userId: ALICE, via: 'direct' },
      },
      effectiveFrom: NOW.toISOString(),
    });
    expect(versions.map((v) => v.operation)).toEqual(['created']);
    expect(events(w.audit)).toContain('knowledge.created');
    const event = w.audit.events().find((e) => e.action === 'knowledge.created');
    expect(event).toMatchObject({
      target: { type: 'knowledge_item', id: outcome.itemId },
      targetVersion: 1,
      reference: 'products:user',
    });
    // The audit trail never holds the value; its versions do.
    expect(JSON.stringify(event)).not.toContain('2500');
  });

  it('refuses malformed or unknown fields, without storing anything', async () => {
    const w = await world();
    for (const bad of [
      { ...price(25), domain: 'secrets' },
      { ...price(25), key: 'Price!' },
      { ...price(25), value: { type: 'money', amountMinor: 1.5, currency: 'PEN' } },
      { ...price(25), organizationId: 'org_x' },
      { ...price(25), subject: { type: 'person', id: 'x' } },
    ]) {
      expect(await codeOf(w.brain.propose(w.alice, bad))).toBe('invalid_knowledge');
    }
    expect(await w.brain.list(w.alice)).toEqual([]);
  });
});

describe('updates, versions and invalidation', () => {
  it('keeps the previous price when it changes: current S/28, before S/25, when and by whom', async () => {
    const w = await world();
    const first = await w.brain.propose(w.alice, price(25));
    const second = await w.brain.propose(w.alice, price(28));
    expect(second).toMatchObject({ outcome: 'updated', itemId: first.itemId, revision: 2 });
    const { item, versions } = await w.brain.get(w.alice, first.itemId);
    expect(item.value).toEqual({ type: 'money', amountMinor: 2800, currency: 'PEN' });
    expect(versions.map((v) => [v.revision, v.value])).toEqual([
      [1, { type: 'money', amountMinor: 2500, currency: 'PEN' }],
      [2, { type: 'money', amountMinor: 2800, currency: 'PEN' }],
    ]);
    expect((versions[0]?.changedAt ?? '') < (versions[1]?.changedAt ?? '')).toBe(true);
    expect(versions[1]?.changedBy).toEqual({ type: 'user', userId: ALICE, via: 'direct' });
    // The same value again changes nothing and records nothing.
    const before = w.audit.events().length;
    expect((await w.brain.propose(w.alice, price(28))).outcome).toBe('unchanged');
    expect(w.audit.events().length).toBe(before);
  });

  it('invalidates and archives with the current revision only, keeping the history', async () => {
    const w = await world();
    const { itemId } = await w.brain.propose(w.alice, price(25));
    expect(await codeOf(w.brain.invalidate(w.alice, itemId, 7))).toBe('stale_revision');
    await w.brain.invalidate(w.alice, itemId, 1, 'price_withdrawn');
    const { item, versions } = await w.brain.get(w.alice, itemId);
    expect(item.status).toBe('outdated');
    expect(item.effectiveUntil).toBeDefined();
    expect(versions.map((v) => v.operation)).toEqual(['created', 'invalidated']);
    expect(await w.brain.list(w.alice)).toEqual([]);
    expect((await w.brain.list(w.alice, { includeInactive: true })).length).toBe(1);
    await w.brain.archive(w.alice, itemId, 2);
    expect((await w.brain.get(w.alice, itemId)).item.status).toBe('archived');
    expect(events(w.audit)).toEqual(
      expect.arrayContaining(['knowledge.invalidated', 'knowledge.archived']),
    );
    const invalidated = w.audit.events().find((e) => e.action === 'knowledge.invalidated');
    expect(invalidated?.reason).toBe('price_withdrawn');
  });
});

describe('sources and verification', () => {
  it('never treats GIA, an agent or a document as confirmed; a person confirms it', async () => {
    const w = await world();
    const fromGia = await w.brain.propose(w.gia, {
      domain: 'customers',
      key: 'target_segment',
      value: { type: 'text', text: 'familias' },
    });
    const giaItem = (await w.brain.get(w.alice, fromGia.itemId)).item;
    expect(giaItem.verification).toBe('proposed');
    expect(giaItem.provenance).toMatchObject({
      sourceType: 'gia',
      recordedBy: { type: 'user', userId: ALICE, via: 'gia' },
    });
    expect(giaItem.needsConfirmation).toBe(true);

    const fromAgent = await w.brain.propose(w.runtime, {
      domain: 'marketing',
      key: 'best_channel',
      value: { type: 'text', text: 'WhatsApp' },
    });
    expect((await w.brain.get(w.alice, fromAgent.itemId)).item).toMatchObject({
      verification: 'proposed',
      provenance: { sourceType: 'agent', recordedBy: { type: 'runtime', initiatedBy: ALICE } },
    });

    // GIA cannot confirm or change on its own.
    expect(await codeOf(w.brain.confirm(w.gia, fromGia.itemId, 1))).toBe('requires_user');
    await w.brain.confirm(w.alice, fromGia.itemId, 1);
    const confirmed = (await w.brain.get(w.alice, fromGia.itemId)).item;
    expect(confirmed.verification).toBe('confirmed');
    // Where it came from stays: GIA found it, the person confirmed it.
    expect(confirmed.provenance.sourceType).toBe('gia');
  });

  it('marks analyses as calculated and integrations as imported', async () => {
    const w = await world();
    const [growth] = (
      await recordResult(w.brain, w.alice, { type: 'analytics', id: 'marketing_analytics' }, [
        {
          domain: 'marketing',
          key: 'growth',
          subject: { type: 'campaign', id: 'combo_familiar' },
          label: 'Combo Familiar',
          value: { type: 'number', number: 18, unit: '%' },
        },
      ])
    ).outcomes;
    expect((await w.brain.get(w.alice, growth?.itemId ?? '')).item.verification).toBe('calculated');
    const context = await w.brain.context(w.gia, { purpose: 'gia', query: 'combo familiar' });
    expect(context.facts).toEqual([
      expect.objectContaining({
        label: 'Combo Familiar',
        value: '18 %',
        verification: 'calculated',
        source: 'analytics',
      }),
    ]);
  });

  it('takes the business profile as confirmed facts from its owner', async () => {
    const w = await world();
    const profile: BusinessProfile = {
      organizationId: w.orgA,
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      timeZone: 'America/Lima',
      city: 'Lima',
      salesChannels: ['whatsapp', 'delivery_apps'],
      offering: 'Pollo a la brasa',
      revision: 2,
      updatedAt: NOW.toISOString() as IsoTimestamp,
      updatedBy: ALICE,
    } as unknown as BusinessProfile;
    const { source, facts } = profileKnowledge(profile);
    const result = await w.brain.ingest(w.alice, source, facts);
    expect(result.rejected).toBe(0);
    expect(result.outcomes.every((o) => o.outcome === 'created')).toBe(true);
    const items = await w.brain.list(w.alice);
    expect(items.every((i) => i.verification === 'confirmed')).toBe(true);
    expect(items.find((i) => i.key === 'city')?.provenance.sourceReference).toBe(
      `business_profile:${w.orgA}@2`,
    );
    // Saving the same profile again changes nothing.
    const again = await w.brain.ingest(w.alice, source, facts);
    expect(again.outcomes.every((o) => o.outcome === 'unchanged')).toBe(true);
    // A person's source cannot be claimed by GIA.
    expect(await codeOf(w.brain.ingest(w.gia, source, facts))).toBe('requires_user');
  });

  it('computes what MelonOffice itself knows, as calculated facts', async () => {
    const w = await world();
    const { source, facts } = operationalKnowledge({
      departments: ['leadership', 'sales', 'marketing'],
      activeAgents: 1,
      channels: [
        { channel: 'whatsapp', status: 'connected', category: 'messaging' },
        { channel: 'whatsapp', status: 'disconnected', category: 'messaging' },
      ],
    });
    await w.brain.ingest(w.alice, source, facts);
    const items = await w.brain.list(w.alice);
    expect(items.map((i) => [i.key, i.verification])).toEqual([
      ['connected_channels', 'calculated'],
      ['agents', 'calculated'],
      ['departments', 'calculated'],
    ]);
  });

  it('syncs from an integration only through its own, connected connection', async () => {
    const w = await world();
    const connection = {
      id: 'conn_1',
      organizationId: w.orgA,
      provider: 'crm_provider',
      category: 'crm',
      status: 'connected',
    };
    const connections = { list: async () => [connection] as never };
    const result = await ingestFromConnection(w.brain, connections, w.alice, 'conn_1', [
      price(28),
      { domain: 'products', key: 'price', value: { type: 'money' } },
    ]);
    expect(result.rejected).toBe(1);
    const item = (await w.brain.get(w.alice, result.outcomes[0]?.itemId ?? '')).item;
    expect(item).toMatchObject({
      verification: 'imported',
      provenance: { sourceType: 'crm', sourceId: 'conn_1', sourceReference: 'crm_provider' },
      needsConfirmation: true,
    });
    expect(
      await codeOf(ingestFromConnection(w.brain, connections, w.alice, 'conn_2', [price(1)])),
    ).toBe('not_found');
    const paused = { list: async () => [{ ...connection, status: 'paused' }] as never };
    expect(await codeOf(ingestFromConnection(w.brain, paused, w.alice, 'conn_1', [price(1)]))).toBe(
      'invalid_knowledge',
    );
  });
});

describe('conflicts', () => {
  it('records a conflict instead of choosing between the owner and the CRM', async () => {
    const w = await world();
    const { itemId } = await w.brain.propose(w.alice, price(30));
    const crm = { type: 'crm' as const, id: 'conn_1' };
    const [clash] = (await w.brain.ingest(w.alice, crm, [price(28)])).outcomes;
    expect(clash?.outcome).toBe('conflict');
    const { item } = await w.brain.get(w.alice, itemId);
    // Nothing chosen silently: the value stays the owner's.
    expect(item.value).toEqual({ type: 'money', amountMinor: 3000, currency: 'PEN' });
    expect(item.openConflictId).toBe(clash?.conflictId);
    const [conflict] = await w.brain.conflicts(w.alice);
    expect(conflict).toMatchObject({
      status: 'open',
      label: 'Combo Familiar',
      current: { value: { amountMinor: 3000 }, provenance: { sourceType: 'user' } },
      candidate: { value: { amountMinor: 2800 }, provenance: { sourceType: 'crm' } },
    });
    expect((await w.brain.gaps(w.alice)).openConflicts).toBe(1);
    // While it is open, the fact cannot be changed around it.
    expect(await codeOf(w.brain.confirm(w.alice, itemId, item.revision))).toBe('conflict_open');
    // A second disagreement updates the same conflict.
    const [again] = (await w.brain.ingest(w.alice, crm, [price(27)])).outcomes;
    expect(again).toMatchObject({ outcome: 'conflict_updated', conflictId: conflict?.id });
    expect(await codeOf(w.brain.resolveConflict(w.gia, conflict?.id ?? '', 'took_candidate'))).toBe(
      'requires_user',
    );
    await w.brain.resolveConflict(w.alice, conflict?.id ?? '', 'took_candidate');
    const resolved = await w.brain.get(w.alice, itemId);
    expect(resolved.item).toMatchObject({
      value: { amountMinor: 2700 },
      verification: 'confirmed',
    });
    expect(resolved.item.openConflictId).toBeUndefined();
    expect(resolved.versions.map((v) => v.operation)).toEqual([
      'created',
      'conflict_detected',
      'conflict_resolved',
    ]);
    expect(await w.brain.conflicts(w.alice)).toEqual([]);
    expect(events(w.audit)).toEqual(
      expect.arrayContaining(['knowledge.conflict_detected', 'knowledge.conflict_resolved']),
    );
    expect(await codeOf(w.brain.resolveConflict(w.alice, conflict?.id ?? '', 'kept_current'))).toBe(
      'not_open',
    );
  });

  it('lets a person settle a conflict by stating the value', async () => {
    const w = await world();
    await w.brain.propose(w.alice, price(30));
    await w.brain.ingest(w.alice, { type: 'crm', id: 'conn_1' }, [price(28)]);
    const [conflict] = await w.brain.conflicts(w.alice);
    await w.brain.propose(w.alice, price(29));
    expect(await w.brain.conflicts(w.alice)).toEqual([]);
    const settled = await w.repository.findConflict(w.orgA, conflict?.id ?? '');
    expect(settled).toMatchObject({
      status: 'resolved',
      resolution: 'replaced',
      resolvedBy: ALICE,
    });
  });

  it('lets a stronger source replace a mere proposal, and one source update its own reading', async () => {
    const w = await world();
    const segment = (text: string) => ({
      domain: 'customers',
      key: 'target_segment',
      value: { type: 'text', text },
    });
    await w.brain.propose(w.gia, segment('familias'));
    const [fromCrm] = (
      await w.brain.ingest(w.alice, { type: 'crm', id: 'c1' }, [segment('oficinas')])
    ).outcomes;
    expect(fromCrm?.outcome).toBe('updated');
    const [newer] = (
      await w.brain.ingest(w.alice, { type: 'crm', id: 'c1' }, [segment('empresas')])
    ).outcomes;
    expect(newer?.outcome).toBe('updated');
    const [other] = (
      await w.brain.ingest(w.alice, { type: 'integration', id: 'shop' }, [segment('turistas')])
    ).outcomes;
    expect(other?.outcome).toBe('conflict');
  });
});

describe('retrieval: selective, with least privilege', () => {
  async function stocked() {
    const w = await world();
    await w.brain.ingest(w.alice, { type: 'user', id: 'setup' }, [
      { domain: 'identity', key: 'industry', value: { type: 'text', text: 'restaurante' } },
      { domain: 'brand', key: 'tone_of_voice', value: { type: 'text', text: 'cercano' } },
      price(28),
      { ...price(12), key: 'cost' },
      {
        domain: 'finance',
        key: 'monthly_budget',
        value: { type: 'money', amountMinor: 500000, currency: 'PEN' },
      },
      { domain: 'customers', key: 'top_customer', value: { type: 'text', text: 'Sra. Pérez' } },
      { domain: 'customers', key: 'target_segment', value: { type: 'text', text: 'familias' } },
    ]);
    return w;
  }

  it('gives marketing brand, products and segments, never costs, budgets or customer records', async () => {
    const w = await stocked();
    const context = await w.brain.context(w.runtime, { purpose: 'marketing' });
    const keys = context.facts.map((f) => f.key).sort();
    expect(keys).toEqual(['industry', 'price', 'target_segment', 'tone_of_voice']);
    const withheld = await w.brain.context(w.runtime, {
      purpose: 'marketing',
      domains: ['finance', 'brand'],
    });
    expect(withheld.withheld).toEqual(['finance']);
    expect(withheld.facts.map((f) => f.key)).toEqual(['tone_of_voice']);
  });

  it('gives finance its restricted facts, and a department it does not know nothing', async () => {
    const w = await stocked();
    const finance = await w.brain.context(w.runtime, { purpose: 'finance' });
    expect(finance.facts.map((f) => f.key)).toEqual(
      expect.arrayContaining(['cost', 'monthly_budget', 'price']),
    );
    expect(finance.facts.map((f) => f.key)).not.toContain('top_customer');
    const unknown = await w.brain.context(w.runtime, { purpose: 'legal' as never });
    expect(unknown.facts).toEqual([]);
  });

  it('sends only what matches, never the whole brain, in a small, labelled shape', async () => {
    const w = await stocked();
    const answer = await w.brain.context(w.gia, {
      purpose: 'gia',
      query: 'precio del combo familiar',
    });
    // Only the combo's facts: its price and (restricted, readable by the owner) its cost.
    expect(answer.facts.map((f) => f.key).sort()).toEqual(['cost', 'price']);
    expect(answer.facts.find((f) => f.key === 'price')).toEqual({
      id: knowledgeItemId(w.orgA, 'products', 'price', { type: 'product', id: 'combo_familiar' }),
      domain: 'products',
      key: 'price',
      subject: { type: 'product', id: 'combo_familiar' },
      label: 'Combo Familiar',
      value: '28.00 PEN',
      verification: 'confirmed',
      needsConfirmation: false,
      source: 'user',
      updatedAt: expect.any(String),
    });
    expect(answer.ref).toMatchObject({ kind: 'company_context', id: `company_brain:${w.orgA}` });
    const one = await w.brain.context(w.gia, { purpose: 'gia', limit: 2 });
    expect(one.facts.length).toBe(2);
    expect(one.truncated).toBe(true);
  });

  it("follows the person's own permissions: GIA sees no more than the person", async () => {
    const limited: RoleCatalogue = {
      owner: ROLES.owner.filter(
        (p) => p !== 'knowledge.read_restricted' && p !== 'knowledge.manage',
      ),
    };
    const w = await world({ roles: limited });
    await w.brain.propose(w.alice, { ...price(12), key: 'cost' });
    const items = await w.brain.list(w.alice, { includeInactive: true });
    expect(items).toEqual([]);
    const context = await w.brain.context(w.gia, { purpose: 'gia' });
    expect(context.facts).toEqual([]);
    const leadership = await w.brain.context(w.runtime, { purpose: 'leadership' });
    expect(leadership.facts).toEqual([]);
    // Without knowledge.manage, what the person states is a proposal, not confirmed.
    const { itemId } = await w.brain.propose(w.alice, price(30));
    expect((await w.brain.get(w.alice, itemId)).item.verification).toBe('proposed');
  });

  it('refuses a role without knowledge.read', async () => {
    const w = await world({ roles: { owner: ['organization.read'] } });
    expect(await codeOf(w.brain.context(w.gia, { purpose: 'gia' }))).toBe('permission_denied');
    expect(await codeOf(w.brain.propose(w.alice, price(1)))).toBe('permission_denied');
  });
});

describe('isolation between organizations and people', () => {
  it("never shows or changes another organization's knowledge", async () => {
    const w = await world();
    const { itemId } = await w.brain.propose(w.alice, price(28));
    expect(await w.brain.list(w.bob)).toEqual([]);
    expect(await codeOf(w.brain.get(w.bob, itemId))).toBe('not_found');
    expect(await codeOf(w.brain.invalidate(w.bob, itemId, 1))).toBe('not_found');
    expect((await w.brain.context(w.bob, { purpose: 'gia', query: 'combo' })).facts).toEqual([]);
    // The same fact in B is B's own item.
    const b = await w.brain.propose(w.bob, price(40));
    expect(b.itemId).not.toBe(itemId);
    expect((await w.brain.get(w.alice, itemId)).item.value).toMatchObject({ amountMinor: 2800 });
  });

  it('keeps company knowledge apart from the person: only who recorded it, never their profile', async () => {
    const w = await world();
    const { itemId } = await w.brain.propose(w.alice, price(28));
    const { item } = await w.brain.get(w.alice, itemId);
    expect(item.organizationId).toBe(w.orgA);
    expect(Object.keys(item.provenance.recordedBy).sort()).toEqual(['type', 'userId', 'via']);
    expect(() => checkKnowledgeInput({ ...price(1), userId: ALICE })).toThrow(BrainError);
  });

  it('refuses a context not from resolveTenant, and an inactive organization', async () => {
    const w = await world();
    expect(await codeOf(w.brain.list({ ...w.alice }))).toBe('unresolved_tenant');
    const brain = createCompanyBrain({
      repository: w.repository,
      organizations: { findOrganization: async () => undefined },
      authorization: createAuthorizationService(),
    });
    expect(await codeOf(brain.list(w.alice))).toBe('organization_inactive');
  });
});

describe('GIA onboarding, capture and documents', () => {
  const extractor = (facts: readonly unknown[] | 'fail'): KnowledgeExtractor => ({
    extract: async () =>
      facts === 'fail'
        ? { status: 'failed', code: 'provider_error' }
        : { status: 'extracted', facts },
  });

  it('asks only what is missing, and lists what the person should confirm', async () => {
    const w = await world();
    const before = await w.brain.gaps(w.alice);
    expect(before.questions.map((q) => q.id)).toEqual([
      'what_you_do',
      'main_products',
      'customers',
      'areas',
      'goals',
      'tone',
    ]);
    await w.brain.propose(w.alice, {
      domain: 'business_model',
      key: 'description',
      value: { type: 'text', text: 'Una pollería' },
    });
    await w.brain.propose(w.gia, {
      domain: 'customers',
      key: 'target_segment',
      value: { type: 'text', text: 'familias' },
    });
    const after = await w.brain.gaps(w.alice);
    expect(after.questions.map((q) => q.id)).toEqual(['main_products', 'areas', 'goals', 'tone']);
    expect(after.toConfirm.map((i) => i.key)).toEqual(['target_segment']);
  });

  it('turns "Tenemos una pollería" into proposals, never confirmed facts', async () => {
    const w = await world({
      extractor: extractor([
        candidateOf({
          domain: 'identity',
          key: 'industry',
          valueType: 'text',
          text: 'food',
          confidence: 0.9,
        }),
        candidateOf({
          domain: 'identity',
          key: 'category',
          valueType: 'text',
          text: 'pollería',
          confidence: 0.95,
        }),
        { domain: 'nowhere', key: 'x', value: { type: 'text', text: 'y' } },
      ]),
    });
    const result = await w.brain.capture(w.alice, 'Tenemos una pollería');
    expect(result.extraction).toBe('extracted');
    expect(result.rejected).toBe(1);
    const items = await w.brain.list(w.alice);
    expect(items.map((i) => [i.key, i.verification, i.provenance.sourceType])).toEqual([
      ['category', 'proposed', 'gia'],
      ['industry', 'proposed', 'gia'],
    ]);
    expect(items[0]?.provenance.confidence).toBe(0.95);
    // Capture is a person asking; GIA alone cannot spend on it.
    expect(await codeOf(w.brain.capture(w.gia, 'x'))).toBe('requires_user');
  });

  it('says extraction is unavailable when no model is configured, and records nothing', async () => {
    const w = await world();
    expect(await codeOf(w.brain.capture(w.alice, 'Tenemos una pollería'))).toBe(
      'extraction_unavailable',
    );
    const failing = await world({ extractor: extractor('fail') });
    const result = await failing.brain.capture(failing.alice, 'Tenemos una pollería');
    expect(result).toEqual({ outcomes: [], rejected: 0, extraction: 'failed' });
    expect(await failing.brain.list(failing.alice)).toEqual([]);
  });

  it('keeps a document, extracts its facts as unverified and points back to it', async () => {
    const w = await world({
      extractor: extractor([
        candidateOf({
          domain: 'products',
          key: 'price',
          subjectType: 'product',
          subjectId: 'combo_familiar',
          label: 'Combo Familiar',
          valueType: 'money',
          number: 45,
          currency: 'pen',
          confidence: 0.8,
        }),
      ]),
    });
    const result = await w.brain.ingestDocument(w.alice, {
      name: 'Carta 2026.txt',
      text: 'Combo Familiar S/45',
    });
    expect(result.extraction).toBe('extracted');
    expect(result.document).toMatchObject({
      name: 'Carta 2026.txt',
      status: 'extracted',
      facts: 1,
    });
    expect(result.document).not.toHaveProperty('text');
    const item = (await w.brain.get(w.alice, result.outcomes[0]?.itemId ?? '')).item;
    expect(item).toMatchObject({
      value: { type: 'money', amountMinor: 4500, currency: 'PEN' },
      verification: 'unverified',
      provenance: {
        sourceType: 'document',
        sourceId: result.document.id,
        sourceReference: 'Carta 2026.txt',
      },
    });
    const stored = await w.repository.findDocument(w.orgA, result.document.id);
    expect(stored?.text).toBe('Combo Familiar S/45');
    expect(events(w.audit)).toContain('knowledge.document_ingested');
    // The same text again is the same document.
    const again = await w.brain.ingestDocument(w.alice, {
      name: 'copia.txt',
      text: 'Combo Familiar S/45',
    });
    expect(again.extraction).toBe('duplicate');
    expect(await codeOf(w.brain.ingestDocument(w.alice, { name: '', text: 'x' }))).toBe(
      'invalid_document',
    );
  });

  it('keeps a document whose extraction failed, marked as such', async () => {
    const w = await world({ extractor: extractor('fail') });
    const result = await w.brain.ingestDocument(w.alice, { name: 'a.txt', text: 'hola' });
    expect(result.extraction).toBe('failed');
    expect((await w.repository.findDocument(w.orgA, result.document.id))?.status).toBe(
      'extraction_failed',
    );
  });
});

describe('extraction through the AI Gateway', () => {
  it('asks the gateway for the company_knowledge subject and checks the answer', async () => {
    const calls: unknown[] = [];
    const gateway = {
      assist: async (_tenant: unknown, request: unknown) => {
        calls.push(request);
        return {
          status: 'completed',
          output: {
            structured: {
              facts: [
                {
                  domain: 'identity',
                  key: 'industry',
                  valueType: 'text',
                  text: 'food',
                  confidence: 0.9,
                },
                { domain: 'identity', key: 'broken', valueType: 'money', confidence: 1 },
              ],
            },
          },
        } as never;
      },
    };
    const w = await world();
    const result = await createGatewayKnowledgeExtractor(gateway).extract(w.alice, {
      subjectId: 'cap-1',
      kind: 'statement',
      text: 'Tenemos una pollería <script>',
    });
    expect(result).toEqual({
      status: 'extracted',
      facts: [
        {
          domain: 'identity',
          key: 'industry',
          value: { type: 'text', text: 'food' },
          confidence: 0.9,
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      subject: { type: 'company_knowledge', id: 'cap-1' },
      sensitivity: 'confidential',
      requirements: { structuredOutput: true },
    });
    expect(JSON.stringify(calls[0])).not.toContain('<script>');
    const denied = createGatewayKnowledgeExtractor({
      assist: async () =>
        ({ status: 'denied', requestId: 'r', code: 'environment_unknown' }) as never,
    });
    expect(await denied.extract(w.alice, { subjectId: 'x', kind: 'document', text: 'y' })).toEqual({
      status: 'unavailable',
      code: 'environment_unknown',
    });
  });
});
