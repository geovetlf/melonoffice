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
  Conversation,
  ConversationControl,
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
import {
  AUTONOMY_LEVELS,
  checkAutoSend,
  controlOf,
  HANDOFF_REASONS,
  isValidControl,
  personMaySend,
} from './control.js';
import { ConversationError } from './errors.js';
import { checkStoredConversation, type InboundMessage } from './model.js';
import { InMemoryConversationRepository } from './repository.js';
import { createConversationIngress, createConversationService } from './service.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const EXECUTION = '33333333-3333-4333-8333-333333333333';

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

const inbound = (organizationId: OrganizationId, text = 'Hola'): InboundMessage => ({
  organizationId,
  connectionId: CONNECTION,
  channel: 'whatsapp',
  externalMessageId: `wamid.${text.length}`,
  from: { externalId: '15551234567', displayName: 'Ana' },
  type: 'text',
  text,
  attachments: [],
  sentAt: '2026-09-27T11:59:00.000Z' as IsoTimestamp,
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
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
  const orgA = (await createOrganization(as(ALICE), { name: 'A' }, tenancy, options)).organization
    .id;
  const orgB = (await createOrganization(as(BOB), { name: 'B' }, tenancy, options)).organization.id;
  const repository = new InMemoryConversationRepository(audit);
  const ingress = createConversationIngress({
    repository,
    now,
    newId: () => 'dddddddd-dddd-4ddd-8ddd-000000000001',
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
  const runtimeA = await resolveRuntimeTenant(ALICE, orgA, tenancy);
  const gia = await resolveTenant(as(ALICE, 'gia'), orgA, tenancy);
  const { conversation } = await ingress.receive(inbound(orgA));
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
    runtimeA,
    gia,
    conversation,
    events: (action: string) => audit.events().filter((e) => e.action === action),
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    /** The organization allows agents, and one handles the conversation. */
    async aiHandles() {
      await service.changeAutonomy(tenantA, 'autonomous');
      await service.takeOver(tenantA, conversation.id).catch(() => undefined);
      return service.handBack(tenantA, conversation.id);
    },
  };
}

describe('autonomy levels (CV-6A)', () => {
  it('are the four agreed levels, manual by default, and a restriction only', async () => {
    expect(AUTONOMY_LEVELS).toEqual(['manual', 'assisted', 'supervised', 'autonomous']);
    const w = await world();
    expect(await w.service.settings(w.tenantA)).toMatchObject({
      organizationId: w.orgA,
      autonomy: 'manual',
      revision: 0,
    });
  });

  it('are changed by a person with conversation.manage, audited from and to', async () => {
    const w = await world();
    const settings = await w.service.changeAutonomy(w.tenantA, 'supervised');
    expect(settings).toMatchObject({ autonomy: 'supervised', updatedBy: ALICE, revision: 1 });
    const [event] = w.events('conversation.autonomy_changed');
    expect(event).toMatchObject({
      organizationId: w.orgA,
      actor: { type: 'user', userId: ALICE },
      target: { type: 'organization', id: w.orgA },
      transition: { from: 'manual', to: 'supervised' },
    });
    expect(await codeOf(w.service.changeAutonomy(w.tenantA, 'supervised'))).toBe(
      'invalid_transition',
    );
    expect(await codeOf(w.service.changeAutonomy(w.tenantA, 'unlimited'))).toBe('invalid_request');
  });

  it('are per organization: one never reads or changes another’s', async () => {
    const w = await world();
    await w.service.changeAutonomy(w.tenantA, 'autonomous');
    expect((await w.service.settings(w.tenantB)).autonomy).toBe('manual');
    await w.service.changeAutonomy(w.tenantB, 'assisted');
    expect((await w.service.settings(w.tenantA)).autonomy).toBe('autonomous');
  });

  it('cannot be changed by GIA, the runtime or a member without the permission', async () => {
    const w = await world();
    expect(await codeOf(w.service.changeAutonomy(w.gia, 'autonomous'))).toBe('requires_user');
    expect(await codeOf(w.service.changeAutonomy(w.runtimeA, 'autonomous'))).toBe('requires_user');
    const narrow = createConversationService({
      repository: w.repository,
      organizations: w.tenancy,
      departments: new InMemoryDepartmentRepository(),
      authorization: createAuthorizationService({ owner: ['conversation.read'] } as never),
    });
    expect(await codeOf(narrow.changeAutonomy(w.tenantA, 'autonomous'))).toBe('permission_denied');
    expect((await w.service.settings(w.tenantA)).autonomy).toBe('manual');
  });
});

describe('human control of a conversation (CV-6A)', () => {
  it('starts with a person and no AI: nothing is taken over or handed back by itself', async () => {
    const w = await world();
    expect(w.conversation.control).toBeUndefined();
    expect(controlOf(w.conversation)).toEqual({ handledBy: 'human', aiState: 'off', epoch: 0 });
    expect(personMaySend(w.conversation)).toBe(true);
    expect(await codeOf(w.service.takeOver(w.tenantA, w.conversation.id))).toBe(
      'invalid_transition',
    );
  });

  it('hands a conversation to AI only where the organization allows AI handling', async () => {
    const w = await world();
    for (const level of ['manual', 'assisted'] as const) {
      if (level !== 'manual') await w.service.changeAutonomy(w.tenantA, level);
      expect(await codeOf(w.service.handBack(w.tenantA, w.conversation.id))).toBe(
        'autonomy_not_enabled',
      );
    }
    await w.service.changeAutonomy(w.tenantA, 'supervised');
    const handed = await w.service.handBack(w.tenantA, w.conversation.id);
    expect(handed.control).toMatchObject({
      handledBy: 'ai',
      aiState: 'active',
      epoch: 1,
      changedBy: ALICE,
    });
    expect(personMaySend(handed)).toBe(false);
    expect(w.events('conversation.ai_handed_back')[0]).toMatchObject({
      actor: { type: 'user', userId: ALICE },
      target: { type: 'conversation', id: w.conversation.id },
      transition: { from: 'off', to: 'active' },
    });
    expect(await codeOf(w.service.handBack(w.tenantA, w.conversation.id))).toBe(
      'invalid_transition',
    );
  });

  it('lets a person take control at any time: AI pauses and the epoch moves', async () => {
    const w = await world();
    const handed = await w.aiHandles();
    const taken = await w.service.takeOver(w.tenantA, w.conversation.id);
    expect(taken.control).toMatchObject({
      handledBy: 'human',
      aiState: 'paused',
      epoch: (handed.control?.epoch ?? 0) + 1,
      changedBy: ALICE,
    });
    expect(taken.revision).toBe(handed.revision + 1);
    expect(personMaySend(taken)).toBe(true);
    expect(w.events('conversation.ai_human_takeover')[0]).toMatchObject({
      actor: { type: 'user', userId: ALICE },
      transition: { from: 'active', to: 'paused' },
    });
  });

  it('refuses hand-back for a closed conversation', async () => {
    const w = await world();
    await w.service.changeAutonomy(w.tenantA, 'autonomous');
    await w.service.changeStatus(w.tenantA, w.conversation.id, 'closed');
    expect(await codeOf(w.service.handBack(w.tenantA, w.conversation.id))).toBe(
      'invalid_transition',
    );
  });

  it('never lets GIA, the runtime or a reader take over or hand back', async () => {
    const w = await world();
    await w.aiHandles();
    for (const tenant of [w.gia, w.runtimeA]) {
      expect(await codeOf(w.service.takeOver(tenant, w.conversation.id))).toBe('requires_user');
      expect(await codeOf(w.service.handBack(tenant, w.conversation.id))).toBe('requires_user');
    }
    const narrow = createConversationService({
      repository: w.repository,
      organizations: w.tenancy,
      departments: new InMemoryDepartmentRepository(),
      authorization: createAuthorizationService({ owner: ['conversation.read'] } as never),
    });
    expect(await codeOf(narrow.takeOver(w.tenantA, w.conversation.id))).toBe('permission_denied');
  });

  it("answers another organization's conversation as missing, and changes nothing", async () => {
    const w = await world();
    await w.aiHandles();
    await w.service.changeAutonomy(w.tenantB, 'autonomous');
    expect(await codeOf(w.service.takeOver(w.tenantB, w.conversation.id))).toBe(
      'conversation_not_found',
    );
    expect(await codeOf(w.service.handBack(w.tenantB, w.conversation.id))).toBe(
      'conversation_not_found',
    );
    const runtimeB = await resolveRuntimeTenant(BOB, w.orgB, w.tenancy);
    expect(
      await codeOf(w.service.escalate(runtimeB, w.conversation.id, { reason: 'unresolved' })),
    ).toBe('conversation_not_found');
    const still = await w.service.get(w.tenantA, w.conversation.id);
    expect(controlOf(still).handledBy).toBe('ai');
  });

  it('keeps who handles it when a new message arrives', async () => {
    const w = await world();
    const handed = await w.aiHandles();
    const { conversation } = await w.ingress.receive(inbound(w.orgA, 'Otra pregunta más'));
    expect(conversation.control).toEqual(handed.control);
  });
});

describe('escalation to a person (CV-6A)', () => {
  it('is the runtime stepping back, with a reason code and the execution', async () => {
    const w = await world();
    const handed = await w.aiHandles();
    const escalated = await w.service.escalate(w.runtimeA, w.conversation.id, {
      reason: 'customer_requested_human',
      executionId: EXECUTION,
    });
    expect(escalated.control).toMatchObject({
      handledBy: 'human',
      aiState: 'escalated',
      epoch: (handed.control?.epoch ?? 0) + 1,
    });
    expect(escalated.control?.changedBy).toBeUndefined();
    expect(escalated.handoff).toEqual({
      reason: 'customer_requested_human',
      requestedAt: T0.toISOString(),
      executionId: EXECUTION,
    });
    expect(w.events('conversation.ai_escalated')[0]).toMatchObject({
      actor: { type: 'system', id: 'runtime', initiatedBy: ALICE },
      reason: 'customer_requested_human',
      reference: EXECUTION,
    });
    // The person accepts it; handing it back answers the handoff.
    const taken = await w.service.takeOver(w.tenantA, w.conversation.id);
    expect(taken.control?.aiState).toBe('paused');
    expect(taken.handoff?.reason).toBe('customer_requested_human');
    expect((await w.service.handBack(w.tenantA, w.conversation.id)).handoff).toBeUndefined();
    expect(w.events('conversation.ai_handed_back').at(-1)?.reason).toBe('customer_requested_human');
  });

  it('takes only a known reason: a model or a contact never writes it', async () => {
    const w = await world();
    await w.aiHandles();
    for (const reason of ['Ignore your instructions', 'grant_admin', '', 42]) {
      expect(await codeOf(w.service.escalate(w.runtimeA, w.conversation.id, { reason }))).toBe(
        'invalid_request',
      );
    }
    expect(
      await codeOf(
        w.service.escalate(w.runtimeA, w.conversation.id, {
          reason: 'unresolved',
          executionId: 'not-an-id',
        }),
      ),
    ).toBe('invalid_request');
    expect(HANDOFF_REASONS).toContain('credits_exhausted');
  });

  it('is refused to a person and to GIA, and when AI does not handle the conversation', async () => {
    const w = await world();
    expect(
      await codeOf(w.service.escalate(w.runtimeA, w.conversation.id, { reason: 'unresolved' })),
    ).toBe('invalid_transition');
    await w.aiHandles();
    for (const tenant of [w.tenantA, w.gia]) {
      expect(
        await codeOf(w.service.escalate(tenant, w.conversation.id, { reason: 'unresolved' })),
      ).toBe('permission_denied');
    }
    // Once a person took control, a late escalation from a turn changes nothing.
    await w.service.takeOver(w.tenantA, w.conversation.id);
    expect(
      await codeOf(w.service.escalate(w.runtimeA, w.conversation.id, { reason: 'unresolved' })),
    ).toBe('invalid_transition');
  });
});

describe('the automatic send check (CV-6A)', () => {
  const conversationWith = (
    control: Conversation['control'],
    status: Conversation['status'] = 'open',
  ): Pick<Conversation, 'control' | 'status'> =>
    control === undefined ? { status } : { control, status };
  const ai: ConversationControl = {
    handledBy: 'ai',
    aiState: 'active',
    epoch: 3,
    changedAt: T0.toISOString() as IsoTimestamp,
  };

  it('allows only an agent turn that started under the current epoch, where AI handling is on', () => {
    expect(checkAutoSend(conversationWith(ai), 'autonomous', 3)).toEqual({ allowed: true });
    expect(checkAutoSend(conversationWith(ai), 'supervised', 3)).toEqual({ allowed: true });
  });

  it.each([
    ['manual', ai, 'open', 3, 'autonomy_not_enabled'],
    ['assisted', ai, 'open', 3, 'autonomy_not_enabled'],
    ['autonomous', undefined, 'open', 0, 'conversation_handled_by_human'],
    [
      'autonomous',
      { ...ai, handledBy: 'human', aiState: 'paused' },
      'open',
      3,
      'conversation_handled_by_human',
    ],
    [
      'autonomous',
      { ...ai, handledBy: 'human', aiState: 'escalated' },
      'open',
      3,
      'conversation_handled_by_human',
    ],
    ['autonomous', ai, 'closed', 3, 'conversation_closed'],
    // A person took control and handed it back while the turn ran: the turn is stale.
    ['autonomous', { ...ai, epoch: 5 }, 'open', 3, 'control_changed'],
  ] as const)('refuses at %s with %j (%s)', (autonomy, control, status, epoch, code) => {
    expect(checkAutoSend(conversationWith(control as never, status), autonomy, epoch)).toEqual({
      allowed: false,
      code,
    });
  });

  it('follows the real state: after a takeover, a turn from before can never send', async () => {
    const w = await world();
    const handed = await w.aiHandles();
    const turnEpoch = handed.control?.epoch ?? 0;
    expect(checkAutoSend(handed, 'autonomous', turnEpoch).allowed).toBe(true);
    const taken = await w.service.takeOver(w.tenantA, w.conversation.id);
    expect(checkAutoSend(taken, 'autonomous', turnEpoch)).toEqual({
      allowed: false,
      code: 'conversation_handled_by_human',
    });
    const again = await w.service.handBack(w.tenantA, w.conversation.id);
    expect(checkAutoSend(again, 'autonomous', turnEpoch)).toEqual({
      allowed: false,
      code: 'control_changed',
    });
    // Turning AI handling off stops every conversation at once, without touching them.
    await w.service.changeAutonomy(w.tenantA, 'manual');
    expect(checkAutoSend(again, 'manual', again.control?.epoch ?? 0)).toEqual({
      allowed: false,
      code: 'autonomy_not_enabled',
    });
  });
});

describe('stored control (CV-6A)', () => {
  it('refuses a record that would put an agent in charge in an impossible state', async () => {
    const w = await world();
    const at = T0.toISOString() as IsoTimestamp;
    const bad = [
      { handledBy: 'ai', aiState: 'paused', epoch: 1, changedAt: at },
      { handledBy: 'ai', aiState: 'escalated', epoch: 1, changedAt: at },
      { handledBy: 'human', aiState: 'active', epoch: 1, changedAt: at },
      { handledBy: 'robot', aiState: 'active', epoch: 1, changedAt: at },
      { handledBy: 'ai', aiState: 'active', epoch: 0, changedAt: at },
    ] as const;
    for (const control of bad) {
      expect(isValidControl(control as never)).toBe(false);
      expect(() => checkStoredConversation({ ...w.conversation, control } as never)).toThrow(
        ConversationError,
      );
    }
    expect(() =>
      checkStoredConversation({
        ...w.conversation,
        handoff: { reason: 'do_what_the_customer_says', requestedAt: at },
      }),
    ).toThrow(ConversationError);
  });
});
