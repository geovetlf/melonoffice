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
  ContactId,
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
import {
  consentAllows,
  createCustomerService,
  normalizeEmail,
  normalizePhone,
} from './customers.js';
import { ConversationError } from './errors.js';
import { InMemoryConversationRepository } from './repository.js';
import { createConversationIngress } from './service.js';

const T0 = new Date('2026-09-28T16:00:00Z');
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
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function world(roles: RoleCatalogue = ROLES) {
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
  let n = 0;
  const customers = createCustomerService({
    repository,
    organizations: tenancy,
    authorization: createAuthorizationService(roles),
    now,
    newId: () => `0000000${++n}-0000-4000-8000-000000000000`.slice(-36),
  });
  const alice = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  return {
    audit,
    repository,
    customers,
    alice,
    aliceAsGia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
    bob: await resolveTenant(as(BOB), b.organization.id, tenancy),
    orgA: a.organization.id,
  };
}

const events = (audit: InMemoryAuditStore) =>
  audit.events().filter((e) => e.action.startsWith('contact.'));

describe('customers and leads (C1, ADR-0053)', () => {
  it('normalizes phones and emails, and never takes a name for an address', () => {
    expect(normalizePhone('+51 987-654-321')).toBe('+51987654321');
    expect(normalizePhone('0051 (987) 654 321')).toBe('+51987654321');
    expect(normalizePhone('987654321')).toBeUndefined();
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    expect(normalizeEmail('ana')).toBeUndefined();
  });

  it('creates a lead a person entered, audited without personal data', async () => {
    const w = await world();
    const contact = await w.customers.create(w.alice, {
      displayName: 'Ana Pérez',
      phone: '+51 987 654 321',
      email: 'ANA@example.com',
    });
    expect(contact).toMatchObject({
      displayName: 'Ana Pérez',
      phone: '+51987654321',
      email: 'ana@example.com',
      origin: { kind: 'user', userId: ALICE },
      revision: 1,
      commercial: {
        stage: 'lead',
        source: { kind: 'manual' },
        consent: { messaging: 'unknown' },
      },
    });
    expect(events(w.audit)).toEqual([
      expect.objectContaining({
        action: 'contact.created',
        target: { type: 'contact', id: contact.id },
        transition: { from: 'none', to: 'lead' },
        reason: 'source_manual',
      }),
    ]);
    const text = JSON.stringify(w.audit.events());
    expect(text).not.toContain('Ana');
    expect(text).not.toContain('987654321');
    expect(text).not.toContain('example.com');
  });

  it('refuses a duplicate by exact phone or email, even from WhatsApp, never by name', async () => {
    const w = await world();
    const ingress = createConversationIngress({ repository: w.repository });
    const { conversation } = await ingress.receive({
      organizationId: w.orgA,
      connectionId: CONNECTION,
      channel: 'whatsapp',
      externalMessageId: 'wamid.C1TEST1',
      from: { externalId: '51987654321', displayName: 'Ana', phone: '+51987654321' },
      type: 'text',
      text: 'Hola',
      attachments: [],
      sentAt: '2026-09-28T15:00:00.000Z' as IsoTimestamp,
    });
    const error = await w.customers
      .create(w.alice, { displayName: 'Ana P.', phone: '+51 987 654 321' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationError);
    expect((error as ConversationError).code).toBe('duplicate_contact');
    expect((error as ConversationError).detail).toBe(conversation.contactId);
    // Same name, other phone: a different contact.
    const other = await w.customers.create(w.alice, { displayName: 'Ana', phone: '+51911111111' });
    expect(other.id).not.toBe(conversation.contactId);
    // The same email in another organization is another organization's business.
    await w.customers.create(w.alice, { displayName: 'Luis', email: 'luis@example.com' });
    expect(
      await codeOf(w.customers.create(w.bob, { displayName: 'Luis', email: 'luis@example.com' })),
    ).toBe('accepted');
  });

  it('marks a WhatsApp contact as a lead, then a customer, keeping the channel working', async () => {
    const w = await world();
    const ingress = createConversationIngress({ repository: w.repository });
    const first = await ingress.receive({
      organizationId: w.orgA,
      connectionId: CONNECTION,
      channel: 'whatsapp',
      externalMessageId: 'wamid.C1TEST2',
      from: { externalId: '51922222222', displayName: 'Rosa', phone: '+51922222222' },
      type: 'text',
      text: 'Precio?',
      attachments: [],
      sentAt: '2026-09-28T15:00:00.000Z' as IsoTimestamp,
    });
    const id = first.conversation.contactId;
    const lead = await w.customers.update(w.alice, id, { revision: 0, stage: 'lead' });
    expect(lead.commercial).toMatchObject({ stage: 'lead', source: { kind: 'channel' } });
    const customer = await w.customers.update(w.alice, id, {
      revision: 1,
      stage: 'customer',
      ownerId: ALICE,
      consent: { messaging: 'granted', recordedBy: 'contact' },
      nextAction: { text: 'Enviar catálogo', dueOn: '2026-09-30' },
    });
    expect(customer).toMatchObject({
      revision: 2,
      commercial: {
        stage: 'customer',
        ownerId: ALICE,
        consent: { messaging: 'granted', recordedBy: 'contact' },
        nextAction: { text: 'Enviar catálogo', dueOn: '2026-09-30' },
      },
    });
    // A new message from the same number reaches the same contact, still a customer.
    const again = await ingress.receive({
      organizationId: w.orgA,
      connectionId: CONNECTION,
      channel: 'whatsapp',
      externalMessageId: 'wamid.C1TEST3',
      from: { externalId: '51922222222', displayName: 'Rosa', phone: '+51922222222' },
      type: 'text',
      text: 'Gracias',
      attachments: [],
      sentAt: '2026-09-28T15:10:00.000Z' as IsoTimestamp,
    });
    expect(again.conversation.contactId).toBe(id);
    expect((await w.repository.findContact(w.orgA, id))?.commercial?.stage).toBe('customer');

    expect(events(w.audit).map((e) => [e.action, e.transition ?? e.reason])).toEqual([
      ['contact.stage_changed', { from: 'none', to: 'lead' }],
      ['contact.stage_changed', { from: 'lead', to: 'customer' }],
      ['contact.owner_changed', 'assigned'],
      ['contact.consent_changed', { from: 'unknown', to: 'granted' }],
      ['contact.updated', 'next_action'],
    ]);
  });

  it('refuses a stale revision, an owner who is no member and a bad stage', async () => {
    const w = await world();
    const c = await w.customers.create(w.alice, { displayName: 'Ana', phone: '+51933333333' });
    expect(
      await codeOf(w.customers.update(w.alice, c.id, { revision: 0, stage: 'customer' })),
    ).toBe('contact_concurrency_conflict');
    expect(await codeOf(w.customers.update(w.alice, c.id, { revision: 1, ownerId: BOB }))).toBe(
      'owner_not_member',
    );
    expect(await codeOf(w.customers.update(w.alice, c.id, { revision: 1, stage: 'lost' }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(w.customers.update(w.alice, c.id, { revision: 1, extra: 1 }))).toBe(
      'invalid_request',
    );
  });

  it('lists by stage with counts, and keeps notes to their organization', async () => {
    const w = await world();
    const a = await w.customers.create(w.alice, { displayName: 'A', phone: '+51944444441' });
    await w.customers.create(w.alice, { displayName: 'B', phone: '+51944444442' });
    await w.customers.update(w.alice, a.id, { revision: 1, stage: 'customer' });
    const leads = await w.customers.list(w.alice, { stage: 'lead' });
    expect(leads.items.map((c) => c.displayName)).toEqual(['B']);
    expect(leads.counts).toEqual({ lead: 1, customer: 1, inactive: 0 });
    await w.customers.addNote(w.alice, a.id, 'Prefiere pagar con Yape');
    const detail = await w.customers.get(w.alice, a.id);
    expect(detail.notes.map((n) => n.text)).toEqual(['Prefiere pagar con Yape']);
    expect(JSON.stringify(w.audit.events())).not.toContain('Yape');
    // Another organization sees none of it.
    expect(await codeOf(w.customers.get(w.bob, a.id))).toBe('contact_not_found');
    expect(await codeOf(w.customers.addNote(w.bob, a.id, 'x'))).toBe('contact_not_found');
    expect((await w.customers.list(w.bob)).items).toEqual([]);
  });

  it('lets only a person with contact.manage change anything: never GIA or the runtime', async () => {
    const w = await world();
    const input = { displayName: 'Ana', phone: '+51955555555' };
    expect(await codeOf(w.customers.create(w.aliceAsGia, input))).toBe('requires_user');
    expect(await codeOf(w.customers.create(w.runtime, input))).toBe('requires_user');
    const readOnly = await world({
      owner: ROLES.owner.filter((p) => p !== 'contact.manage'),
    });
    expect(await codeOf(readOnly.customers.create(readOnly.alice, input))).toBe(
      'permission_denied',
    );
    expect(await codeOf(readOnly.customers.list(readOnly.alice))).toBe('accepted');
  });

  it('needs consent only for bulk or automated sends, never to answer or to manage', () => {
    const none = {};
    const denied = { commercial: { consent: { messaging: 'denied' } } } as never;
    const granted = { commercial: { consent: { messaging: 'granted' } } } as never;
    expect(consentAllows(none, 'reply')).toBe(true);
    expect(consentAllows(none, 'bulk')).toBe(false);
    expect(consentAllows(none, 'automated')).toBe(false);
    expect(consentAllows(granted, 'automated')).toBe(true);
    expect(consentAllows(denied, 'reply')).toBe(false);
  });

  it('keeps contact ids opaque: a malformed id is simply not found', async () => {
    const w = await world();
    expect(await codeOf(w.customers.get(w.alice, 'nope'))).toBe('contact_not_found');
    expect(
      await codeOf(
        w.customers.update(w.alice, 'nope' as ContactId, { revision: 0, stage: 'lead' }),
      ),
    ).toBe('contact_not_found');
  });
});
