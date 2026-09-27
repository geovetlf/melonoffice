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
  Message,
  MessageId,
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
import { ConversationError } from './errors.js';
import {
  applyInbound,
  applyOutbound,
  applyStatus,
  channelIdentityIdFor,
  checkInbound,
  CONVERSATION_TRANSITIONS,
  conversationIdFor,
  inboundMessageIdFor,
  normalizeTags,
  newOutboundMessage,
  outboundMessageIdFor,
  settleOutbound,
  type InboundMessage,
} from './model.js';
import { InMemoryConversationRepository } from './repository.js';
import { createConversationIngress, createConversationService } from './service.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CAROL = '44444444-4444-4444-8444-444444444444' as UserId;
const CONNECTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const CONNECTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as ChannelConnectionId;
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as ContactId;
const ORG = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;

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

const inbound = (
  organizationId: OrganizationId,
  overrides: Partial<InboundMessage> = {},
): InboundMessage => ({
  organizationId,
  connectionId: CONNECTION_A,
  channel: 'whatsapp',
  externalMessageId: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx',
  from: { externalId: '15551234567', displayName: 'Ana', phone: '+15551234567' },
  type: 'text',
  text: 'Hola, quiero información',
  attachments: [],
  sentAt: '2026-09-27T11:59:00.000Z' as IsoTimestamp,
  ...overrides,
});

async function codeOf(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  return 'accepted';
}

async function world() {
  let clock = T0;
  const now = () => clock;
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments);
  const options = {
    billing: BILLING,
    credits: openWallet,
    departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
  };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  const repository = new InMemoryConversationRepository(audit);
  let ids = 0;
  const ingress = createConversationIngress({
    repository,
    now,
    newId: () => `dddddddd-dddd-4ddd-8ddd-${String(++ids).padStart(12, '0')}`,
  });
  const service = createConversationService({
    repository,
    organizations: tenancy,
    departments,
    authorization: createAuthorizationService(),
    now,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const departmentOf = (organizationId: OrganizationId) =>
    `${organizationId}_${DEFAULT_DEPARTMENT_CATALOGUE.types[0]?.id}`;
  return {
    audit,
    tenancy,
    repository,
    ingress,
    service,
    orgA,
    orgB,
    tenantA,
    tenantB,
    departmentOf,
    events: (action: string) => audit.events().filter((e) => e.action === action),
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

describe('deterministic ids', () => {
  it('names one identity, conversation and message per organization, never across them', () => {
    const other = '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
    const identity = channelIdentityIdFor(ORG, 'whatsapp', '15551234567');
    expect(channelIdentityIdFor(ORG, 'whatsapp', '15551234567')).toBe(identity);
    expect(channelIdentityIdFor(other, 'whatsapp', '15551234567')).not.toBe(identity);
    expect(conversationIdFor(ORG, CONNECTION_A, identity)).not.toBe(
      conversationIdFor(ORG, CONNECTION_B, identity),
    );
    const message = inboundMessageIdFor(ORG, 'whatsapp', 'wamid.X');
    expect(inboundMessageIdFor(ORG, 'whatsapp', 'wamid.X')).toBe(message);
    expect(inboundMessageIdFor(other, 'whatsapp', 'wamid.X')).not.toBe(message);
    const conversation = conversationIdFor(ORG, CONNECTION_A, identity);
    expect(outboundMessageIdFor(ORG, conversation, 'client-1')).toBe(
      outboundMessageIdFor(ORG, conversation, 'client-1'),
    );
  });

  it('refuses malformed parts instead of hashing them', () => {
    expect(() => channelIdentityIdFor(ORG, 'telegram' as never, '1')).toThrow(ConversationError);
    expect(() => inboundMessageIdFor(ORG, 'whatsapp', 'has space')).toThrow(ConversationError);
    expect(() => outboundMessageIdFor(ORG, 'x' as never, 'client-1')).toThrow(ConversationError);
  });
});

describe('checkInbound', () => {
  it('accepts a normalized text message', () => {
    expect(checkInbound(inbound(ORG))).toBeDefined();
  });

  it.each<[string, Partial<InboundMessage>]>([
    ['organizationId', { organizationId: 'org' as OrganizationId }],
    ['connectionId', { connectionId: 'x' as ChannelConnectionId }],
    ['channel', { channel: 'sms' as never }],
    ['externalMessageId', { externalMessageId: '' }],
    ['from.externalId', { from: { externalId: 'a b' } }],
    ['from.phone', { from: { externalId: '1555', phone: '5551234' } }],
    ['from.displayName', { from: { externalId: '1555', displayName: 'A\u0000' } }],
    ['text', { text: 'x'.repeat(4097) }],
    ['text', { text: undefined } as never],
    ['type', { type: 'poll' as never }],
    ['sentAt', { sentAt: 'yesterday' as IsoTimestamp }],
    ['attachments', { attachments: Array(11).fill({ providerMediaId: 'm' }) }],
  ])('refuses a bad %s', async (_field, overrides) => {
    expect(await codeOf(() => checkInbound(inbound(ORG, overrides)))).toBe('invalid_inbound');
  });
});

describe('applyInbound', () => {
  it('creates contact, identity and an open conversation for a new address', () => {
    const r = applyInbound(inbound(ORG), {}, CONTACT, T0);
    expect(r.contact).toMatchObject({
      id: CONTACT,
      displayName: 'Ana',
      phone: '+15551234567',
      origin: { kind: 'channel', channel: 'whatsapp', connectionId: CONNECTION_A },
    });
    expect(r.identity).toMatchObject({ contactId: CONTACT, verification: 'provider' });
    expect(r.conversation).toMatchObject({ status: 'open', revision: 1, tags: [] });
    expect(r.message).toMatchObject({
      direction: 'inbound',
      status: 'received',
      sender: { kind: 'contact', channelIdentityId: r.identity.id },
    });
    // Nothing assigns, hands off or routes on arrival: a person decides (DG-1).
    expect(r.conversation.assigneeId).toBeUndefined();
    expect(r.conversation.departmentId).toBeUndefined();
    expect(r.conversation.handoff).toBeUndefined();
  });

  it('reuses a known contact as is and reopens a closed conversation', () => {
    const first = applyInbound(inbound(ORG), {}, CONTACT, T0);
    const renamed = { ...first.contact, displayName: 'Ana (cliente)' };
    const closed = { ...first.conversation, status: 'closed' as const };
    const next = applyInbound(
      inbound(ORG, {
        externalMessageId: 'wamid.second',
        from: { externalId: '15551234567', displayName: 'Other name' },
        sentAt: '2026-09-27T12:30:00.000Z' as IsoTimestamp,
      }),
      { identity: first.identity, contact: renamed, conversation: closed },
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as ContactId,
      T0,
    );
    expect(next.contact.displayName).toBe('Ana (cliente)');
    expect(next.conversation).toMatchObject({ status: 'open', revision: 2 });
    expect(next.conversation.lastMessage?.id).toBe(next.message.id);
  });

  it('keeps the newest message as the latest when an older one arrives late', () => {
    const first = applyInbound(inbound(ORG), {}, CONTACT, T0);
    const late = applyInbound(
      inbound(ORG, {
        externalMessageId: 'wamid.late',
        sentAt: '2026-09-27T11:00:00.000Z' as IsoTimestamp,
      }),
      first,
      CONTACT,
      T0,
    );
    expect(late.conversation.lastMessage?.id).toBe(first.message.id);
  });

  it('never merges by name: two numbers with the same name are two contacts', () => {
    const one = applyInbound(inbound(ORG), {}, CONTACT, T0);
    const two = applyInbound(
      inbound(ORG, {
        externalMessageId: 'wamid.two',
        from: { externalId: '15559876543', displayName: 'Ana' },
      }),
      {},
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as ContactId,
      T0,
    );
    expect(two.contact.id).not.toBe(one.contact.id);
    expect(two.identity.id).not.toBe(one.identity.id);
    expect(two.conversation.id).not.toBe(one.conversation.id);
  });
});

describe('applyStatus', () => {
  const outbound = (status: Message['status']): Message => ({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as MessageId,
    organizationId: ORG,
    conversationId: conversationIdFor(
      ORG,
      CONNECTION_A,
      channelIdentityIdFor(ORG, 'whatsapp', '15551234567'),
    ),
    channel: 'whatsapp',
    connectionId: CONNECTION_A,
    direction: 'outbound',
    externalMessageId: 'wamid.out',
    sender: { kind: 'user', userId: ALICE },
    type: 'text',
    text: 'Hola',
    attachments: [],
    status,
    sentAt: T0.toISOString() as IsoTimestamp,
    createdAt: T0.toISOString() as IsoTimestamp,
  });
  const update = (status: 'sent' | 'delivered' | 'read' | 'failed') => ({
    organizationId: ORG,
    connectionId: CONNECTION_A,
    channel: 'whatsapp' as const,
    externalMessageId: 'wamid.out',
    status,
    at: '2026-09-27T12:01:00.000Z' as IsoTimestamp,
  });

  it('moves forward only, and failed is final', () => {
    expect(applyStatus(outbound('sent'), update('delivered'))?.status).toBe('delivered');
    expect(applyStatus(outbound('read'), update('delivered'))).toBeUndefined();
    expect(applyStatus(outbound('sent'), update('sent'))).toBeUndefined();
    expect(applyStatus(outbound('failed'), update('read'))).toBeUndefined();
    const read = applyStatus(outbound('sent'), update('read'));
    expect(read).toMatchObject({ status: 'read', deliveredAt: read?.readAt });
    expect(applyStatus(outbound('sent'), update('failed'))?.failureCode).toBe('provider_failure');
  });

  it('never changes an inbound message', () => {
    expect(
      applyStatus({ ...outbound('received'), direction: 'inbound' }, update('read')),
    ).toBeUndefined();
  });
});

describe('transitions and tags', () => {
  it('lets a closed conversation only reopen', () => {
    expect(CONVERSATION_TRANSITIONS.closed).toEqual(['open']);
    expect(CONVERSATION_TRANSITIONS.open).toEqual(['pending', 'closed']);
  });

  it('normalizes tags and refuses bad or too many', async () => {
    expect(normalizeTags(['vip', 'lead', 'vip'])).toEqual(['lead', 'vip']);
    expect(await codeOf(() => normalizeTags(['Bad Tag']))).toBe('invalid_request');
    expect(await codeOf(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`)))).toBe(
      'invalid_request',
    );
  });
});

describe('ingress idempotency', () => {
  it('stores a webhook delivered twice as one message', async () => {
    const w = await world();
    const first = await w.ingress.receive(inbound(w.orgA));
    const again = await w.ingress.receive(inbound(w.orgA));
    expect(first).toMatchObject({ duplicate: false, newContact: true });
    expect(again).toMatchObject({ duplicate: true, newContact: false });
    expect(again.message.id).toBe(first.message.id);
    expect(await w.repository.listMessages(w.orgA, first.conversation.id)).toHaveLength(1);
    expect(await w.repository.listContacts(w.orgA)).toHaveLength(1);
    expect((await w.repository.findConversation(w.orgA, first.conversation.id))?.revision).toBe(1);
  });

  it('threads a second message into the same conversation and contact', async () => {
    const w = await world();
    const first = await w.ingress.receive(inbound(w.orgA));
    const second = await w.ingress.receive(
      inbound(w.orgA, {
        externalMessageId: 'wamid.second',
        sentAt: '2026-09-27T12:05:00.000Z' as IsoTimestamp,
      }),
    );
    expect(second).toMatchObject({ duplicate: false, newContact: false });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(await w.repository.listMessages(w.orgA, first.conversation.id)).toHaveLength(2);
  });

  it('writes no audit event and no actor for what a contact sent', async () => {
    const w = await world();
    const before = w.audit.events().length;
    await w.ingress.receive(inbound(w.orgA));
    // The origin is in the data (sender contact, contact origin channel), never a user action.
    expect(w.audit.events()).toHaveLength(before);
  });
});

describe('tenant isolation', () => {
  it('keeps the same number and provider id apart in two organizations', async () => {
    const w = await world();
    const a = await w.ingress.receive(inbound(w.orgA));
    const b = await w.ingress.receive(inbound(w.orgB, { connectionId: CONNECTION_B }));
    expect(b.duplicate).toBe(false);
    expect(b.message.id).not.toBe(a.message.id);
    expect(b.conversation.id).not.toBe(a.conversation.id);
    expect(b.conversation.contactId).not.toBe(a.conversation.contactId);
    expect(await w.service.list(w.tenantA)).toHaveLength(1);
    expect(await w.service.list(w.tenantB)).toHaveLength(1);
  });

  it("answers another organization's conversation and contact as missing", async () => {
    const w = await world();
    const a = await w.ingress.receive(inbound(w.orgA));
    const id = a.conversation.id;
    expect(await codeOf(w.service.get(w.tenantB, id))).toBe('conversation_not_found');
    expect(await codeOf(w.service.messages(w.tenantB, id))).toBe('conversation_not_found');
    expect(await codeOf(w.service.changeStatus(w.tenantB, id, 'closed'))).toBe(
      'conversation_not_found',
    );
    expect(await codeOf(w.service.assign(w.tenantB, id, { assigneeId: null }))).toBe(
      'conversation_not_found',
    );
    expect(await codeOf(w.service.changeTags(w.tenantB, id, { add: ['vip'] }))).toBe(
      'conversation_not_found',
    );
    expect(await codeOf(w.service.contact(w.tenantB, a.conversation.contactId))).toBe(
      'contact_not_found',
    );
    expect(await w.service.contacts(w.tenantB)).toEqual([]);
  });

  it('refuses a department of another organization', async () => {
    const w = await world();
    const a = await w.ingress.receive(inbound(w.orgA));
    expect(
      await codeOf(
        w.service.assign(w.tenantA, a.conversation.id, {
          departmentId: w.departmentOf(w.orgB) as never,
        }),
      ),
    ).toBe('department_not_found');
  });
});

describe('human inbox service', () => {
  it('assigns to a member and a department, and audits each change', async () => {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    const assigned = await w.service.assign(w.tenantA, conversation.id, {
      assigneeId: ALICE,
      departmentId: w.departmentOf(w.orgA) as never,
    });
    expect(assigned).toMatchObject({ assigneeId: ALICE, departmentId: w.departmentOf(w.orgA) });
    const cleared = await w.service.assign(w.tenantA, conversation.id, {
      assigneeId: null,
      departmentId: null,
    });
    expect(cleared.assigneeId).toBeUndefined();
    expect(cleared.departmentId).toBeUndefined();
    expect(w.events('conversation.assigned').map((e) => e.reason)).toEqual([
      'assigned',
      'unassigned',
    ]);
    expect(w.events('conversation.assigned')[0]).toMatchObject({
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      organizationId: w.orgA,
      target: { type: 'conversation', id: conversation.id },
    });
  });

  it('refuses an assignee who is not an active member', async () => {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    expect(await codeOf(w.service.assign(w.tenantA, conversation.id, { assigneeId: CAROL }))).toBe(
      'assignee_not_member',
    );
    // Bob is a member of B, not of A.
    expect(await codeOf(w.service.assign(w.tenantA, conversation.id, { assigneeId: BOB }))).toBe(
      'assignee_not_member',
    );
    expect(await codeOf(w.service.assign(w.tenantA, conversation.id, {}))).toBe('invalid_request');
  });

  it('moves status along the allowed transitions only, audited', async () => {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    await w.service.changeStatus(w.tenantA, conversation.id, 'pending');
    await w.service.changeStatus(w.tenantA, conversation.id, 'closed');
    expect(await codeOf(w.service.changeStatus(w.tenantA, conversation.id, 'pending'))).toBe(
      'invalid_transition',
    );
    expect(await codeOf(w.service.changeStatus(w.tenantA, conversation.id, 'archived'))).toBe(
      'invalid_request',
    );
    expect(w.events('conversation.status_changed').map((e) => e.transition)).toEqual([
      { from: 'open', to: 'pending' },
      { from: 'pending', to: 'closed' },
    ]);
  });

  it('adds and removes tags, audited', async () => {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    await w.service.changeTags(w.tenantA, conversation.id, { add: ['vip', 'lead'] });
    const after = await w.service.changeTags(w.tenantA, conversation.id, { remove: ['lead'] });
    expect(after.tags).toEqual(['vip']);
    expect(w.events('conversation.tags_changed')).toHaveLength(2);
    expect(await codeOf(w.service.changeTags(w.tenantA, conversation.id, {}))).toBe(
      'invalid_request',
    );
  });

  it('filters by status, assignee, department, contact, tag and date', async () => {
    const w = await world();
    const one = await w.ingress.receive(inbound(w.orgA));
    const two = await w.ingress.receive(
      inbound(w.orgA, {
        externalMessageId: 'wamid.two',
        from: { externalId: '15559876543' },
        sentAt: '2026-09-27T12:10:00.000Z' as IsoTimestamp,
      }),
    );
    await w.service.assign(w.tenantA, one.conversation.id, { assigneeId: ALICE });
    await w.service.changeTags(w.tenantA, two.conversation.id, { add: ['vip'] });
    await w.service.changeStatus(w.tenantA, two.conversation.id, 'pending');
    const ids = async (filter: Parameters<typeof w.service.list>[1]) =>
      (await w.service.list(w.tenantA, filter)).map((c) => c.id);
    // Newest activity first.
    expect(await ids({})).toEqual([two.conversation.id, one.conversation.id]);
    expect(await ids({ status: 'pending' })).toEqual([two.conversation.id]);
    expect(await ids({ assigneeId: ALICE })).toEqual([one.conversation.id]);
    expect(await ids({ unassigned: true })).toEqual([two.conversation.id]);
    expect(await ids({ tag: 'vip' })).toEqual([two.conversation.id]);
    expect(await ids({ contactId: one.conversation.contactId })).toEqual([one.conversation.id]);
    expect(await ids({ since: '2026-09-27T12:00:00.000Z' })).toEqual([two.conversation.id]);
    expect(await ids({ until: '2026-09-27T12:00:00.000Z' })).toEqual([one.conversation.id]);
    expect(await ids({ channel: 'whatsapp', limit: 1 })).toEqual([two.conversation.id]);
    expect(await codeOf(w.service.list(w.tenantA, { status: 'spam' as never }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(w.service.list(w.tenantA, { limit: 1000 }))).toBe('invalid_request');
  });

  it('returns a contact with its identities', async () => {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    const { contact, identities } = await w.service.contact(w.tenantA, conversation.contactId);
    expect(contact.displayName).toBe('Ana');
    expect(identities.map((i) => i.externalId)).toEqual(['15551234567']);
  });

  it('refuses a member without the permission; GIA and the runtime cannot manage', async () => {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    const narrow = createConversationService({
      repository: w.repository,
      organizations: w.tenancy,
      departments: new InMemoryDepartmentRepository(),
      authorization: createAuthorizationService({ owner: ['conversation.read'] } as never),
    });
    expect(await narrow.list(w.tenantA)).toHaveLength(1);
    expect(await codeOf(narrow.changeStatus(w.tenantA, conversation.id, 'closed'))).toBe(
      'permission_denied',
    );
    expect(await codeOf(narrow.contacts(w.tenantA))).toBe('permission_denied');
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(await codeOf(w.service.changeStatus(runtime, conversation.id, 'closed'))).toBe(
      'requires_user',
    );
    const gia = await resolveTenant(as(ALICE, 'gia'), w.orgA, w.tenancy);
    expect(await codeOf(w.service.assign(gia, conversation.id, { assigneeId: ALICE }))).toBe(
      'requires_user',
    );
    expect(await codeOf(w.service.changeTags(gia, conversation.id, { add: ['vip'] }))).toBe(
      'requires_user',
    );
    // Reading stays open to them: nothing is changed.
    expect(await w.service.list(gia)).toHaveLength(1);
  });
});

describe('inbox (CV-3)', () => {
  async function three() {
    const w = await world();
    const ana = await w.ingress.receive(inbound(w.orgA));
    w.advance(60);
    const jose = await w.ingress.receive(
      inbound(w.orgA, {
        externalMessageId: 'wamid.jose',
        from: { externalId: '5215512345678', displayName: 'José Pérez', phone: '+5215512345678' },
        sentAt: '2026-09-27T12:05:00.000Z' as IsoTimestamp,
      }),
    );
    w.advance(60);
    const luis = await w.ingress.receive(
      inbound(w.orgA, {
        externalMessageId: 'wamid.luis',
        from: { externalId: '34600111222', displayName: 'Luis' },
        sentAt: '2026-09-27T12:01:00.000Z' as IsoTimestamp,
      }),
    );
    return { w, ana: ana.conversation, jose: jose.conversation, luis: luis.conversation };
  }

  it('lists with each contact, filters by priority and orders by activity, creation or priority', async () => {
    const { w, ana, jose, luis } = await three();
    await w.service.changePriority(w.tenantA, luis.id, 'urgent');
    await w.service.changePriority(w.tenantA, ana.id, 'high');
    const entries = await w.service.inbox(w.tenantA);
    expect(entries.map((e) => e.conversation.id)).toEqual([jose.id, luis.id, ana.id]);
    expect(entries.map((e) => e.contact?.displayName)).toEqual(['José Pérez', 'Luis', 'Ana']);
    const ids = async (filter: Parameters<typeof w.service.inbox>[1]) =>
      (await w.service.inbox(w.tenantA, filter)).map((e) => e.conversation.id);
    expect(await ids({ sort: 'created' })).toEqual([luis.id, jose.id, ana.id]);
    expect(await ids({ sort: 'priority' })).toEqual([luis.id, ana.id, jose.id]);
    expect(await ids({ priority: 'urgent' })).toEqual([luis.id]);
    expect(await codeOf(w.service.inbox(w.tenantA, { sort: 'random' as never }))).toBe(
      'invalid_request',
    );
    expect(await codeOf(w.service.inbox(w.tenantA, { priority: 'asap' as never }))).toBe(
      'invalid_request',
    );
  });

  it('searches names without accents or case, phones by their digits, never message text', async () => {
    const { w, ana, jose, luis } = await three();
    const found = async (q: string) =>
      (await w.service.inbox(w.tenantA, { q })).map((e) => e.conversation.id);
    expect(await found('jose perez')).toEqual([jose.id]);
    expect(await found('PÉR')).toEqual([jose.id]);
    expect(await found('+52 1 55')).toEqual([jose.id]);
    // The WhatsApp id of an identity, with no phone on the contact.
    expect(await found('600 111')).toEqual([luis.id]);
    expect(await found('an')).toEqual([ana.id]);
    // Message text is not searched.
    expect(await found('información')).toEqual([]);
    for (const q of ['a', ' ', 'x'.repeat(101), 'a\u0000b']) {
      expect(await codeOf(w.service.inbox(w.tenantA, { q }))).toBe('invalid_request');
    }
  });

  it('never finds, lists or opens another organization’s conversations or contacts', async () => {
    const { w } = await three();
    const theirs = await w.ingress.receive(
      inbound(w.orgB, { from: { externalId: '15550001111', displayName: 'Bea' } }),
    );
    expect(await w.service.inbox(w.tenantA, { q: 'bea' })).toEqual([]);
    expect(await w.service.inbox(w.tenantA, { q: '1555000' })).toEqual([]);
    expect((await w.service.inbox(w.tenantB)).map((e) => e.contact?.displayName)).toEqual(['Bea']);
    expect(await codeOf(w.service.detail(w.tenantA, theirs.conversation.id))).toBe(
      'conversation_not_found',
    );
    expect(await codeOf(w.service.changePriority(w.tenantA, theirs.conversation.id, 'high'))).toBe(
      'conversation_not_found',
    );
  });

  it('opens a conversation with its contact, identity and latest messages, and no secret', async () => {
    const { w, jose } = await three();
    await w.ingress.receive(
      inbound(w.orgA, {
        externalMessageId: 'wamid.jose2',
        from: { externalId: '5215512345678' },
        text: '¿Tienen envío?',
        sentAt: '2026-09-27T12:06:00.000Z' as IsoTimestamp,
      }),
    );
    const detail = await w.service.detail(w.tenantA, jose.id);
    expect(detail.conversation.id).toBe(jose.id);
    expect(detail.contact.displayName).toBe('José Pérez');
    expect(detail.identity.externalId).toBe('5215512345678');
    expect(detail.messages.map((m) => m.text)).toEqual([
      'Hola, quiero información',
      '¿Tienen envío?',
    ]);
    expect((await w.service.detail(w.tenantA, jose.id, { limit: 1 })).messages).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toMatch(/secret|token/i);
    expect(await codeOf(w.service.detail(w.tenantA, 'not-an-id'))).toBe('conversation_not_found');
  });

  it('changes priority by a person only, audited from and to, and refuses a no-op', async () => {
    const { w, ana } = await three();
    const changed = await w.service.changePriority(w.tenantA, ana.id, 'urgent');
    expect(changed.priority).toBe('urgent');
    expect(changed.revision).toBe(ana.revision + 1);
    const [event] = w.events('conversation.priority_changed');
    expect(event?.transition).toEqual({ from: 'normal', to: 'urgent' });
    expect(event?.actor).toMatchObject({ type: 'user', userId: ALICE });
    expect(await codeOf(w.service.changePriority(w.tenantA, ana.id, 'urgent'))).toBe(
      'invalid_transition',
    );
    expect(await codeOf(w.service.changePriority(w.tenantA, ana.id, 'critical'))).toBe(
      'invalid_request',
    );
    const gia = await resolveTenant(as(ALICE, 'gia'), w.orgA, w.tenancy);
    expect(await codeOf(w.service.changePriority(gia, ana.id, 'low'))).toBe('requires_user');
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(await codeOf(w.service.changePriority(runtime, ana.id, 'low'))).toBe('requires_user');
  });

  it('needs contact.read to see contacts, search or open a conversation', async () => {
    const { w, ana } = await three();
    const readerOnly = createConversationService({
      repository: w.repository,
      organizations: w.tenancy,
      departments: new InMemoryDepartmentRepository(),
      authorization: createAuthorizationService({ owner: ['conversation.read'] } as never),
    });
    const entries = await readerOnly.inbox(w.tenantA);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.contact === undefined)).toBe(true);
    expect(await codeOf(readerOnly.inbox(w.tenantA, { q: 'ana' }))).toBe('permission_denied');
    expect(await codeOf(readerOnly.detail(w.tenantA, ana.id))).toBe('permission_denied');
    expect(await codeOf(readerOnly.changePriority(w.tenantA, ana.id, 'high'))).toBe(
      'permission_denied',
    );
  });
});

describe('outbound (CV-2, ADR-0034)', () => {
  async function withConversation() {
    const w = await world();
    const { conversation } = await w.ingress.receive(inbound(w.orgA));
    const reserve = (clientMessageId = 'reply-1', text = 'Hola Ana') =>
      newOutboundMessage(
        { organizationId: w.orgA, conversation, userId: ALICE, clientMessageId, text },
        T0,
      );
    return { w, conversation, reserve };
  }

  it('reserves a queued text from the person, with an id from the sender’s key', async () => {
    const { w, conversation, reserve } = await withConversation();
    const message = reserve();
    expect(message).toMatchObject({
      id: outboundMessageIdFor(w.orgA, conversation.id, 'reply-1'),
      organizationId: w.orgA,
      conversationId: conversation.id,
      connectionId: conversation.connectionId,
      channel: 'whatsapp',
      direction: 'outbound',
      sender: { kind: 'user', userId: ALICE },
      status: 'queued',
      text: 'Hola Ana',
    });
    expect(reserve().id).toBe(message.id);
    expect(reserve('reply-2').id).not.toBe(message.id);
  });

  it('refuses an empty, too long, control-character or foreign message', async () => {
    const { w, conversation, reserve } = await withConversation();
    for (const text of ['', '   ', 'x'.repeat(4097), 'a\u0000b']) {
      expect(await codeOf(() => reserve('reply-1', text))).toBe('invalid_request');
    }
    expect(await codeOf(() => reserve('bad key'))).toBe('invalid_request');
    expect(
      await codeOf(() =>
        newOutboundMessage(
          { organizationId: w.orgB, conversation, userId: ALICE, clientMessageId: 'x', text: 'y' },
          T0,
        ),
      ),
    ).toBe('invalid_request');
    // A line break is text, not a control character.
    expect(reserve('reply-1', 'Hola\nAna').text).toBe('Hola\nAna');
  });

  it('settles a queued message once: sent, failed or unknown, never twice', async () => {
    const { reserve } = await withConversation();
    const queued = reserve();
    const sent = settleOutbound(queued, { status: 'sent', externalMessageId: 'wamid.sent' });
    expect(sent).toMatchObject({ status: 'sent', externalMessageId: 'wamid.sent' });
    expect(settleOutbound(queued, { status: 'failed', failureCode: 'rate_limited' })).toMatchObject(
      { status: 'failed', failureCode: 'rate_limited' },
    );
    expect(
      settleOutbound(queued, { status: 'unknown', failureCode: 'outcome_unknown' }),
    ).toMatchObject({ status: 'unknown', failureCode: 'outcome_unknown' });
    for (const done of [sent as Message]) {
      expect(settleOutbound(done, { status: 'failed', failureCode: 'x' })).toBeUndefined();
    }
    expect(
      await codeOf(() => settleOutbound(queued, { status: 'failed', failureCode: 'Not A Code' })),
    ).toBe('invalid_request');
    expect(
      await codeOf(() => settleOutbound(queued, { status: 'sent', externalMessageId: 'a b' })),
    ).toBe('invalid_request');
  });

  it('an unknown message takes no delivery report: nothing can name it', () => {
    const unknown = {
      ...newOutboundMessage(
        {
          organizationId: ORG,
          conversation: {
            id: conversationIdFor(ORG, CONNECTION_A, channelIdentityIdFor(ORG, 'whatsapp', '1')),
            organizationId: ORG,
            channel: 'whatsapp',
            connectionId: CONNECTION_A,
          } as never,
          userId: ALICE,
          clientMessageId: 'k',
          text: 'Hola',
        },
        T0,
      ),
      status: 'unknown' as const,
    };
    expect(
      applyStatus(unknown, {
        organizationId: ORG,
        connectionId: CONNECTION_A,
        channel: 'whatsapp',
        externalMessageId: 'wamid.x',
        status: 'delivered',
        at: T0.toISOString() as IsoTimestamp,
      }),
    ).toBeUndefined();
  });

  it('records a sent message as the conversation’s last outbound activity', async () => {
    const { conversation, reserve } = await withConversation();
    const sent = settleOutbound(reserve(), {
      status: 'sent',
      externalMessageId: 'wamid.sent',
    }) as Message;
    const next = applyOutbound(conversation, sent, T0);
    expect(next).toMatchObject({
      revision: conversation.revision + 1,
      lastOutboundAt: sent.sentAt,
      lastMessage: { id: sent.id, direction: 'outbound', preview: 'Hola Ana' },
    });
    expect(await codeOf(() => applyOutbound(conversation, reserve(), T0))).toBe('invalid_request');
  });

  it('stores a reservation once, settles it once, and keeps organizations apart', async () => {
    const { w, conversation, reserve } = await withConversation();
    const repository = w.repository;
    const first = await repository.reserveOutbound(reserve());
    const again = await repository.reserveOutbound(reserve());
    expect([first.created, again.created]).toEqual([true, false]);
    expect(again.message.id).toBe(first.message.id);
    expect(await repository.findMessage(w.orgB, first.message.id)).toBeUndefined();
    expect(
      await repository.settleOutbound(
        w.orgB,
        first.message.id,
        { status: 'failed', failureCode: 'x' },
        [],
        T0,
      ),
    ).toEqual({ applied: false });
    const settled = await repository.settleOutbound(
      w.orgA,
      first.message.id,
      { status: 'sent', externalMessageId: 'wamid.one' },
      [],
      T0,
    );
    expect(settled).toMatchObject({ applied: true, message: { status: 'sent' } });
    expect(
      await repository.settleOutbound(
        w.orgA,
        first.message.id,
        { status: 'unknown', failureCode: 'outcome_unknown' },
        [],
        T0,
      ),
    ).toMatchObject({ applied: false, message: { status: 'sent' } });
    expect((await repository.findConversation(w.orgA, conversation.id))?.lastOutboundAt).toBe(
      T0.toISOString(),
    );
    // Delivery reports now reach it by the provider's id.
    expect(
      await repository.applyStatus({
        organizationId: w.orgA,
        connectionId: CONNECTION_A,
        channel: 'whatsapp',
        externalMessageId: 'wamid.one',
        status: 'delivered',
        at: T0.toISOString() as IsoTimestamp,
      }),
    ).toEqual({ applied: true });
    // Reserving in a conversation that is not the organization's is refused.
    await expect(
      repository.reserveOutbound({ ...reserve('other'), organizationId: w.orgB }),
    ).rejects.toMatchObject({ code: 'conversation_not_found' });
    expect(await repository.findIdentity(w.orgB, conversation.channelIdentityId)).toBeUndefined();
    expect((await repository.findIdentity(w.orgA, conversation.channelIdentityId))?.id).toBe(
      conversation.channelIdentityId,
    );
  });
});
