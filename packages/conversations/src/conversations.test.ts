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
  applyStatus,
  channelIdentityIdFor,
  checkInbound,
  CONVERSATION_TRANSITIONS,
  conversationIdFor,
  inboundMessageIdFor,
  normalizeTags,
  outboundMessageIdFor,
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
