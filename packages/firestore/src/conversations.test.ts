import type { Firestore } from '@google-cloud/firestore';
import { buildAuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import {
  InMemoryConversationRepository,
  type ConversationRepository,
  type InboundMessage,
} from '@melonoffice/conversations';
import type {
  ChannelConnection,
  ChannelConnectionId,
  ContactId,
  IsoTimestamp,
  Message,
  MessageId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import {
  InMemoryChannelConnectionRepository,
  secretRefsFor,
  type ChannelConnectionRepository,
} from '@melonoffice/integrations';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS } from './audit.js';
import {
  CHANNEL_CONNECTIONS,
  FirestoreChannelConnectionRepository,
  toConnectionDocument,
} from './channels.js';
import {
  CONVERSATIONS,
  FirestoreConversationRepository,
  MESSAGES,
  putOutboundMessage,
} from './conversations.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const ORG_A = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ORG_B = '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const CONNECTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const CONNECTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as ChannelConnectionId;
const contactId = (n: number) =>
  `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}` as ContactId;

const inbound = (
  organizationId: OrganizationId,
  overrides: Partial<InboundMessage> = {},
): InboundMessage => ({
  organizationId,
  connectionId: organizationId === ORG_A ? CONNECTION_A : CONNECTION_B,
  channel: 'whatsapp',
  externalMessageId: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTAx',
  from: { externalId: '15551234567', displayName: 'Ana', phone: '+15551234567' },
  type: 'text',
  text: 'Hola',
  attachments: [],
  sentAt: '2026-09-27T11:59:00.000Z' as IsoTimestamp,
  ...overrides,
});

interface Stores {
  readonly conversations: ConversationRepository;
  readonly connections: ChannelConnectionRepository;
  readonly putOutbound: (message: Message) => Promise<void>;
  readonly putConnection: (connection: ChannelConnection) => Promise<void>;
  readonly auditActions: () => Promise<readonly string[]>;
  readonly db?: Firestore;
}

const STORES: [string, () => Stores][] = [
  [
    'memory',
    () => {
      const audit = new InMemoryAuditStore();
      const conversations = new InMemoryConversationRepository(audit);
      const connections = new InMemoryChannelConnectionRepository(audit);
      return {
        conversations,
        connections,
        putOutbound: async (m) => conversations.putOutbound(m),
        putConnection: async (c) => connections.put(c),
        auditActions: async () => audit.events().map((e) => e.action),
      };
    },
  ],
  ...(emulatorHost
    ? [
        [
          'firestore',
          (): Stores => {
            const db = emulatorFirestore();
            return {
              db,
              conversations: new FirestoreConversationRepository(db),
              connections: new FirestoreChannelConnectionRepository(db),
              putOutbound: (m) => putOutboundMessage(db, m),
              putConnection: async (c) => {
                await db.collection(CHANNEL_CONNECTIONS).doc(c.id).set(toConnectionDocument(c));
              },
              auditActions: async () =>
                (await db.collection(AUDIT_LOGS).get()).docs.map((d) => d.get('action') as string),
            };
          },
        ] as [string, () => Stores],
      ]
    : []),
];

const connectionOf = (
  organizationId: OrganizationId,
  id: ChannelConnectionId,
): ChannelConnection => ({
  id,
  organizationId,
  channel: 'whatsapp',
  status: 'active',
  displayName: 'Ventas',
  account: { phoneNumberId: '106540352242922', displayPhoneNumber: '+1 555 078 3881' },
  secrets: secretRefsFor('melonoffice-test', id),
  createdAt: T0.toISOString() as IsoTimestamp,
  createdBy: ALICE,
  updatedAt: T0.toISOString() as IsoTimestamp,
  revision: 1,
});

describe.each(STORES)('conversation storage in %s', (name, create) => {
  it('stores an inbound message once however often it is delivered', async () => {
    const s = create();
    const first = await s.conversations.receive(inbound(ORG_A), contactId(1), T0);
    const again = await s.conversations.receive(inbound(ORG_A), contactId(2), T0);
    expect(again.duplicate).toBe(true);
    expect(again.message).toEqual(first.message);
    expect(await s.conversations.listContacts(ORG_A)).toHaveLength(1);
    expect(await s.conversations.listMessages(ORG_A, first.conversation.id)).toHaveLength(1);
  });

  it('stores one message when the same delivery arrives concurrently', async () => {
    const s = create();
    const results = await Promise.all(
      [1, 2, 3].map((n) => s.conversations.receive(inbound(ORG_A), contactId(n), T0)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const [conversation] = await s.conversations.listConversations(ORG_A);
    expect(await s.conversations.listMessages(ORG_A, conversation?.id as never)).toHaveLength(1);
    expect(await s.conversations.listContacts(ORG_A)).toHaveLength(1);
    expect(conversation?.revision).toBe(1);
  });

  it('keeps a colliding number and provider id apart across organizations', async () => {
    const s = create();
    const a = await s.conversations.receive(inbound(ORG_A), contactId(1), T0);
    const b = await s.conversations.receive(inbound(ORG_B), contactId(2), T0);
    expect(b.duplicate).toBe(false);
    expect(b.message.id).not.toBe(a.message.id);
    expect(await s.conversations.findConversation(ORG_B, a.conversation.id)).toBeUndefined();
    expect(await s.conversations.listMessages(ORG_B, a.conversation.id)).toEqual([]);
    expect(await s.conversations.findContact(ORG_B, a.conversation.contactId)).toBeUndefined();
    expect(await s.conversations.listIdentities(ORG_B, a.conversation.contactId)).toEqual([]);
    expect((await s.conversations.listConversations(ORG_A)).map((c) => c.id)).toEqual([
      a.conversation.id,
    ]);
  });

  it('round-trips every field it stores', async () => {
    const s = create();
    const received = await s.conversations.receive(
      inbound(ORG_A, {
        type: 'image',
        text: 'foto',
        attachments: [{ providerMediaId: '1234567890', mimeType: 'image/jpeg' }],
        replyToExternalId: 'wamid.previous',
      }),
      contactId(1),
      T0,
    );
    const [message] = await s.conversations.listMessages(ORG_A, received.conversation.id);
    expect(message).toEqual(received.message);
    expect(await s.conversations.findConversation(ORG_A, received.conversation.id)).toEqual(
      received.conversation,
    );
    const contact = await s.conversations.findContact(ORG_A, received.conversation.contactId);
    expect(contact).toMatchObject({ displayName: 'Ana', phone: '+15551234567' });
    const identities = await s.conversations.listIdentities(ORG_A, received.conversation.contactId);
    expect(identities.map((i) => i.externalId)).toEqual(['15551234567']);
  });

  it('applies delivery statuses forward only, found by the provider id', async () => {
    const s = create();
    const { conversation } = await s.conversations.receive(inbound(ORG_A), contactId(1), T0);
    const outbound: Message = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as MessageId,
      organizationId: ORG_A,
      conversationId: conversation.id,
      channel: 'whatsapp',
      connectionId: CONNECTION_A,
      direction: 'outbound',
      externalMessageId: 'wamid.out',
      sender: { kind: 'user', userId: ALICE },
      type: 'text',
      text: 'Hola',
      attachments: [],
      status: 'sent',
      sentAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
      createdAt: '2026-09-27T12:00:00.000Z' as IsoTimestamp,
    };
    await s.putOutbound(outbound);
    const update = (status: 'delivered' | 'read', organizationId = ORG_A) => ({
      organizationId,
      connectionId: CONNECTION_A,
      channel: 'whatsapp' as const,
      externalMessageId: 'wamid.out',
      status,
      at: '2026-09-27T12:01:00.000Z' as IsoTimestamp,
    });
    expect(await s.conversations.applyStatus(update('read', ORG_B))).toEqual({ applied: false });
    expect(await s.conversations.applyStatus(update('read'))).toEqual({ applied: true });
    expect(await s.conversations.applyStatus(update('delivered'))).toEqual({ applied: false });
    const messages = await s.conversations.listMessages(ORG_A, conversation.id);
    expect(messages.find((m) => m.id === outbound.id)).toMatchObject({
      status: 'read',
      readAt: '2026-09-27T12:01:00.000Z',
    });
  });

  it('updates a conversation with its audit events together, in its organization only', async () => {
    const s = create();
    const { conversation } = await s.conversations.receive(inbound(ORG_A), contactId(1), T0);
    const change = (current: typeof conversation) => ({
      conversation: { ...current, tags: ['vip'], revision: current.revision + 1 },
      events: [
        buildAuditEvent(
          {
            action: 'conversation.tags_changed',
            result: 'success',
            actor: { type: 'user', userId: ALICE, via: 'direct' },
            organizationId: ORG_A,
            target: { type: 'conversation', id: current.id },
            source: 'api',
          },
          T0,
        ),
      ],
    });
    await expect(
      s.conversations.updateConversation(ORG_B, conversation.id, change),
    ).rejects.toMatchObject({ code: 'conversation_not_found' });
    const updated = await s.conversations.updateConversation(ORG_A, conversation.id, change);
    expect(updated.tags).toEqual(['vip']);
    expect(await s.auditActions()).toEqual(['conversation.tags_changed']);
    // A change that skips a revision is refused and stores nothing.
    await expect(
      s.conversations.updateConversation(ORG_A, conversation.id, (current) => ({
        conversation: { ...current, revision: current.revision + 2 },
        events: [],
      })),
    ).rejects.toMatchObject({ code: 'conversation_concurrency_conflict' });
  });

  it('stores channel connections with references only, and finds them for delivery', async () => {
    const s = create();
    const a = connectionOf(ORG_A, CONNECTION_A);
    await s.putConnection(a);
    expect(await s.connections.find(ORG_A, CONNECTION_A)).toEqual(a);
    expect(await s.connections.find(ORG_B, CONNECTION_A)).toBeUndefined();
    expect(await s.connections.findForDelivery(CONNECTION_A)).toEqual(a);
    expect(await s.connections.list(ORG_B)).toEqual([]);
    if (s.db !== undefined) {
      const stored = JSON.stringify(
        (await s.db.collection(CHANNEL_CONNECTIONS).doc(a.id).get()).data(),
      );
      expect(stored).toContain('/secrets/channel-');
      expect(stored).not.toMatch(/token"\s*:\s*"(?!projects\/)/);
    }
    expect(name).toBeDefined();
  });

  it("refuses a stored connection pointing at another connection's secrets", async () => {
    const s = create();
    await s.putConnection({
      ...connectionOf(ORG_A, CONNECTION_A),
      secrets: secretRefsFor('melonoffice-test', CONNECTION_B),
    });
    await expect(s.connections.findForDelivery(CONNECTION_A)).rejects.toThrow();
  });
});

describe.runIf(emulatorHost)('FirestoreConversationRepository (emulator)', () => {
  it('refuses a stored conversation with bad data instead of passing it on', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreConversationRepository(db);
    const { conversation } = await repository.receive(inbound(ORG_A), contactId(1), T0);
    await db.collection(CONVERSATIONS).doc(conversation.id).update({ status: 'spam' });
    await expect(repository.findConversation(ORG_A, conversation.id)).rejects.toThrow();
  });

  it('never reads a message across organizations, even by its id', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreConversationRepository(db);
    const { message, conversation } = await repository.receive(inbound(ORG_A), contactId(1), T0);
    await db.collection(MESSAGES).doc(message.id).update({ organizationId: ORG_B });
    expect(await repository.listMessages(ORG_A, conversation.id)).toEqual([]);
  });
});
