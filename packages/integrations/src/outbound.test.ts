import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  createConversationIngress,
  InMemoryConversationRepository,
  newOutboundMessage,
} from '@melonoffice/conversations';
import { openWallet } from '@melonoffice/credits';
import type {
  ChannelConnection,
  ChannelConnectionId,
  Conversation,
  ExecutionId,
  ExecutionNodeId,
  InitialBilling,
  IsoTimestamp,
  Message,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, InMemoryExecutionRepository } from '@melonoffice/execution';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import type { ToolExecutionContext, ToolResult } from '@melonoffice/tools';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryChannelConnectionRepository } from './connections.js';
import { IntegrationError } from './errors.js';
import {
  createChannelMessageExecutor,
  createMessageSendService,
  settlementOfError,
  withinServiceWindow,
  type ToolInvoker,
} from './outbound.js';
import { InMemorySecretStore, secretRefsFor } from './secrets.js';
import { createWhatsAppAdapter, WHATSAPP_SERVICE_WINDOW_MS } from './whatsapp.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CONNECTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const CONNECTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as ChannelConnectionId;
const PHONE_A = '106540352242922';
const PHONE_B = '206540352242922';
// Test values only: stand-ins for what Secret Manager would hold.
const TOKEN_A = 'test-access-token-a';
const TOKEN_B = 'test-access-token-b';

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

async function world() {
  let clock = T0;
  const now = () => clock;
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(now, audit);
  const options = { billing: BILLING, credits: openWallet };
  const orgA = (await createOrganization(as(ALICE), { name: 'A' }, tenancy, options)).organization
    .id;
  const orgB = (await createOrganization(as(BOB), { name: 'B' }, tenancy, options)).organization.id;
  const conversations = new InMemoryConversationRepository(audit);
  const connections = new InMemoryChannelConnectionRepository(audit);
  const secrets = new InMemorySecretStore();
  const connect = (organizationId: OrganizationId, id: ChannelConnectionId, phone: string) => {
    const connection: ChannelConnection = {
      id,
      organizationId,
      channel: 'whatsapp',
      status: 'active',
      displayName: 'Ventas',
      account: { phoneNumberId: phone },
      secrets: secretRefsFor('melonoffice-test', id),
      createdAt: T0.toISOString() as IsoTimestamp,
      createdBy: ALICE,
      updatedAt: T0.toISOString() as IsoTimestamp,
      revision: 1,
    };
    connections.put(connection);
    return connection;
  };
  const connectionA = connect(orgA, CONNECTION_A, PHONE_A);
  const connectionB = connect(orgB, CONNECTION_B, PHONE_B);
  secrets.put(connectionA.secrets.access_token, TOKEN_A);
  secrets.put(connectionB.secrets.access_token, TOKEN_B);
  const ingress = createConversationIngress({ repository: conversations, now });
  const receive = async (
    organizationId: OrganizationId,
    connectionId: ChannelConnectionId,
    from = '15551234567',
  ): Promise<Conversation> =>
    (
      await ingress.receive({
        organizationId,
        connectionId,
        channel: 'whatsapp',
        externalMessageId: `wamid.in${from}${connectionId.slice(0, 4)}`,
        from: { externalId: from, phone: `+${from}` },
        type: 'text',
        text: 'Hola',
        attachments: [],
        sentAt: new Date(clock.getTime() - 60_000).toISOString() as IsoTimestamp,
      })
    ).conversation;
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: () => Promise<Response> = async () =>
    new Response(JSON.stringify({ messages: [{ id: `wamid.out${calls.length}` }] }));
  const whatsapp = createWhatsAppAdapter({
    graphApiVersion: 'v23.0',
    fetch: vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answer();
    }),
  });
  const executor = createChannelMessageExecutor({
    conversations,
    connections,
    secrets,
    adapters: { whatsapp },
    now,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const reserve = async (conversation: Conversation, clientMessageId = 'reply-1') =>
    (
      await conversations.reserveOutbound(
        newOutboundMessage(
          {
            organizationId: conversation.organizationId,
            conversation,
            userId: conversation.organizationId === orgA ? ALICE : BOB,
            clientMessageId,
            text: 'Hola Ana',
          },
          clock,
        ),
      )
    ).message;
  const contextOf = (message: Message, overrides: Partial<ToolExecutionContext> = {}) =>
    ({
      organizationId: message.organizationId,
      executionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as ExecutionId,
      nodeId: 'send' as ExecutionNodeId,
      toolId: 'message_send',
      toolVersion: 1,
      action: 'send',
      actor: { userId: message.organizationId === orgA ? ALICE : BOB, via: 'direct' },
      riskLevel: 'medium',
      idempotencyKey: 'k'.repeat(64),
      environment: 'dev',
      deadline: new Date(clock.getTime() + 15_000),
      ...overrides,
    }) as ToolExecutionContext;
  const run = (message: Message, overrides: Partial<ToolExecutionContext> = {}) =>
    executor.execute(contextOf(message, overrides), {
      conversationId: message.conversationId,
      messageId: message.id,
    });
  return {
    audit,
    tenancy,
    orgA,
    orgB,
    tenantA,
    tenantB,
    conversations,
    connections,
    connectionA,
    secrets,
    receive,
    reserve,
    run,
    executor,
    whatsapp,
    calls,
    answerWith: (next: () => Promise<Response>) => {
      answer = next;
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now,
  };
}

describe('WhatsApp service window', () => {
  it('allows a free-form reply only within 24 hours of the contact’s last message', () => {
    const adapter = { serviceWindowMs: WHATSAPP_SERVICE_WINDOW_MS };
    const at = (ms: number) => ({
      lastInboundAt: new Date(T0.getTime() - ms).toISOString() as IsoTimestamp,
    });
    expect(withinServiceWindow(at(60_000), adapter, T0)).toBe(true);
    expect(withinServiceWindow(at(WHATSAPP_SERVICE_WINDOW_MS - 1), adapter, T0)).toBe(true);
    expect(withinServiceWindow(at(WHATSAPP_SERVICE_WINDOW_MS), adapter, T0)).toBe(false);
    expect(withinServiceWindow({}, adapter, T0)).toBe(false);
    // A last message "from the future" is not trusted to open the window.
    expect(withinServiceWindow(at(-60_000), adapter, T0)).toBe(false);
    expect(withinServiceWindow({}, {}, T0)).toBe(true);
    expect(createWhatsAppAdapter().serviceWindowMs).toBe(WHATSAPP_SERVICE_WINDOW_MS);
  });
});

describe('provider answers', () => {
  it('maps documented Meta error codes to stable codes, never the message', async () => {
    const connection = {
      account: { phoneNumberId: PHONE_A },
    } as ChannelConnection;
    const rejecting = (body: unknown, status = 400) =>
      createWhatsAppAdapter({
        graphApiVersion: 'v23.0',
        fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status })),
      });
    const detailOf = async (body: unknown, status?: number) => {
      const error = await rejecting(body, status)
        .send(connection, TOKEN_A, { to: '15551234567', text: 'Hola' })
        .catch((e: unknown) => e);
      return error instanceof IntegrationError ? `${error.code}:${error.detail}` : 'none';
    };
    expect(await detailOf({ error: { code: 131047, message: 'Re-engagement' } })).toBe(
      'provider_rejected:outside_messaging_window',
    );
    expect(await detailOf({ error: { code: 131026 } })).toBe(
      'provider_rejected:invalid_destination',
    );
    expect(await detailOf({ error: { code: 131051 } })).toBe(
      'provider_rejected:unsupported_message',
    );
    expect(await detailOf({ error: { code: 190 } }, 401)).toBe(
      'provider_rejected:channel_unauthorized',
    );
    expect(await detailOf({ error: { code: 368 } }, 403)).toBe(
      'provider_rejected:policy_restricted',
    );
    expect(await detailOf({ error: { code: 130429 } })).toBe('provider_rejected:rate_limited');
    expect(await detailOf({ error: { code: 999999 } })).toBe('provider_rejected:provider_rejected');
    expect(await detailOf('not json')).toBe('provider_rejected:provider_rejected');
    expect(await detailOf({}, 429)).toBe('provider_unavailable:rate_limited');
    expect(await detailOf({}, 503)).toBe('provider_unavailable:server_error');
  });

  it('fails what surely was not sent, and leaves unknown what may have been', () => {
    expect(settlementOfError(new IntegrationError('provider_rejected', 'rate_limited'))).toEqual({
      status: 'failed',
      failureCode: 'rate_limited',
    });
    expect(settlementOfError(new IntegrationError('provider_unavailable', 'rate_limited'))).toEqual(
      { status: 'failed', failureCode: 'rate_limited' },
    );
    expect(
      settlementOfError(new IntegrationError('provider_unavailable', 'graph_api_version')),
    ).toEqual({ status: 'failed', failureCode: 'channel_not_available' });
    expect(settlementOfError(new IntegrationError('invalid_outbound'))).toEqual({
      status: 'failed',
      failureCode: 'invalid_message',
    });
    for (const detail of ['no_answer', 'server_error', 'response']) {
      expect(settlementOfError(new IntegrationError('provider_unavailable', detail))).toEqual({
        status: 'unknown',
        failureCode: 'outcome_unknown',
      });
    }
    expect(settlementOfError(new Error('boom'))).toEqual({
      status: 'unknown',
      failureCode: 'outcome_unknown',
    });
  });
});

describe('message_send executor', () => {
  it('sends the reserved text to the conversation’s contact, from its own connection', async () => {
    const w = await world();
    const conversation = await w.receive(w.orgA, CONNECTION_A);
    const message = await w.reserve(conversation);
    expect(await w.run(message)).toEqual({
      status: 'success',
      output: { messageId: message.id, status: 'sent' },
    });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.url).toContain(`/${PHONE_A}/messages`);
    expect(w.calls[0]?.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN_A}` });
    expect(JSON.parse(w.calls[0]?.init.body as string)).toMatchObject({
      to: '15551234567',
      text: { body: 'Hola Ana' },
    });
    expect(await w.conversations.findMessage(w.orgA, message.id)).toMatchObject({
      status: 'sent',
      externalMessageId: 'wamid.out1',
    });
    const [event] = w.audit.events().filter((e) => e.action === 'conversation.message_sent');
    expect(event).toMatchObject({
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      target: { type: 'message', id: message.id },
      reason: 'whatsapp',
    });
    // Settled once: running it again sends nothing.
    expect(await w.run(message)).toEqual({ status: 'failure', code: 'message_not_sendable' });
    expect(w.calls).toHaveLength(1);
  });

  it('never acts on another organization’s message, whatever ids it is given', async () => {
    const w = await world();
    const mine = await w.reserve(await w.receive(w.orgA, CONNECTION_A));
    const theirs = await w.reserve(await w.receive(w.orgB, CONNECTION_B));
    // A's context naming B's message, or B's conversation with A's message: nothing is sent.
    expect(
      await w.executor.execute(contextOfA(w, mine), {
        conversationId: theirs.conversationId,
        messageId: theirs.id,
      }),
    ).toEqual({ status: 'failure', code: 'message_not_sendable' });
    expect(
      await w.executor.execute(contextOfA(w, mine), {
        conversationId: theirs.conversationId,
        messageId: mine.id,
      }),
    ).toEqual({ status: 'failure', code: 'message_not_sendable' });
    // Another person of the same organization cannot send a message reserved by Alice.
    expect(await w.run(mine, { actor: { userId: BOB, via: 'direct' } })).toEqual({
      status: 'failure',
      code: 'message_not_sendable',
    });
    // Nor can GIA or the runtime reach this tool at all.
    for (const via of ['gia', 'runtime'] as const) {
      expect(await w.run(mine, { actor: { userId: ALICE, via } })).toEqual({
        status: 'failure',
        code: 'tool_not_human_invokable',
      });
    }
    expect(w.calls).toHaveLength(0);
    expect(await w.conversations.findMessage(w.orgB, theirs.id)).toMatchObject({
      status: 'queued',
    });
  });

  it('refuses outside the window, on a disabled connection or without the token', async () => {
    const w = await world();
    const conversation = await w.receive(w.orgA, CONNECTION_A);
    w.advance(WHATSAPP_SERVICE_WINDOW_MS);
    const late = await w.reserve(conversation, 'late');
    expect(await w.run(late)).toEqual({ status: 'failure', code: 'outside_messaging_window' });
    const x = await world();
    const open = await x.receive(x.orgA, CONNECTION_A);
    x.connections.put({ ...x.connectionA, status: 'disabled' });
    expect(await x.run(await x.reserve(open))).toEqual({
      status: 'failure',
      code: 'channel_not_available',
    });
    const noToken = await world();
    const third = await noToken.receive(noToken.orgA, CONNECTION_A);
    const message = await noToken.reserve(third);
    const empty = new InMemorySecretStore();
    const executor = createChannelMessageExecutor({
      conversations: noToken.conversations,
      connections: noToken.connections,
      secrets: empty,
      adapters: { whatsapp: noToken.whatsapp },
      now: noToken.now,
    });
    expect(
      await executor.execute(contextOfA(noToken, message), {
        conversationId: message.conversationId,
        messageId: message.id,
      }),
    ).toEqual({ status: 'failure', code: 'channel_not_available' });
    expect([...w.calls, ...x.calls, ...noToken.calls]).toHaveLength(0);
    expect(await noToken.conversations.findMessage(noToken.orgA, message.id)).toMatchObject({
      status: 'failed',
      failureCode: 'channel_not_available',
    });
  });

  it('never puts the token in an outcome, an event or an error', async () => {
    const w = await world();
    const message = await w.reserve(await w.receive(w.orgA, CONNECTION_A));
    w.answerWith(async () => new Response('{"error":{"code":190}}', { status: 401 }));
    const outcome = await w.run(message);
    expect(outcome).toEqual({ status: 'failure', code: 'channel_unauthorized' });
    expect(JSON.stringify([outcome, w.audit.events()])).not.toContain(TOKEN_A);
  });
});

function contextOfA(w: Awaited<ReturnType<typeof world>>, message: Message) {
  return {
    organizationId: message.organizationId,
    executionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    nodeId: 'send',
    toolId: 'message_send',
    toolVersion: 1,
    action: 'send',
    actor: { userId: message.organizationId === w.orgA ? ALICE : BOB, via: 'direct' },
    riskLevel: 'medium',
    environment: 'dev',
    deadline: new Date(w.now().getTime() + 15_000),
  } as unknown as ToolExecutionContext;
}

describe('message send service', () => {
  /** The service with a gate that answers `result`, running the executor when it says success. */
  async function service(result?: (w: Awaited<ReturnType<typeof world>>) => Promise<ToolResult>) {
    const w = await world();
    const executions = createExecutionService({
      repository: new InMemoryExecutionRepository(w.audit),
      organizations: w.tenancy,
      authorization: createAuthorizationService(),
      audit: createAuditService(w.audit, w.now),
      now: w.now,
    });
    const invocations: unknown[] = [];
    const gate: ToolInvoker = {
      async invoke(_tenant, invocation) {
        invocations.push(invocation);
        if (result !== undefined) return result(w);
        const outcome = await w.executor.execute(
          contextOfA(
            w,
            (await w.conversations.findMessage(
              w.orgA,
              (invocation.input as { messageId: string }).messageId as never,
            )) as Message,
          ),
          invocation.input,
        );
        return outcome.status === 'success'
          ? { status: 'success', output: outcome.output, durationMs: 1 }
          : { status: 'failure', code: outcome.code, durationMs: 1 };
      },
    };
    const sender = createMessageSendService({
      conversations: w.conversations,
      organizations: w.tenancy,
      authorization: createAuthorizationService(),
      executions,
      gate,
      adapters: { whatsapp: w.whatsapp },
      audit: createAuditService(w.audit, w.now),
      now: w.now,
    });
    const conversation = await w.receive(w.orgA, CONNECTION_A);
    const send = (clientMessageId = 'reply-1', text = 'Hola Ana', tenant = w.tenantA) =>
      sender.send(tenant, conversation.id, { clientMessageId, text });
    return { w, sender, send, conversation, executions, invocations };
  }

  it('reserves, creates one execution with no specialist, invokes the gate once', async () => {
    const s = await service();
    const { message, created } = await s.send();
    expect(created).toBe(true);
    expect(message.status).toBe('sent');
    expect(s.invocations).toEqual([
      {
        executionId: expect.any(String),
        nodeId: 'send',
        input: { conversationId: s.conversation.id, messageId: message.id },
      },
    ]);
    const executionId = (s.invocations[0] as { executionId: string }).executionId;
    const execution = await s.executions.get(s.w.tenantA, executionId);
    expect(execution).toMatchObject({
      userId: ALICE,
      mode: 'execute',
      input: { type: 'message', id: message.id },
      nodes: [{ id: 'send', type: 'tool', tool: { id: 'message_send', version: 1 } }],
    });
    expect(execution.specialistId).toBeUndefined();
    // The same key again: the stored message, no second gate call.
    expect(await s.send()).toMatchObject({ created: false, message: { id: message.id } });
    expect(s.invocations).toHaveLength(1);
  });

  it('refuses GIA, the runtime, and another organization’s conversation', async () => {
    const s = await service();
    const gia = await resolveTenant(as(ALICE, 'gia'), s.w.orgA, s.w.tenancy);
    const runtime = await resolveRuntimeTenant(ALICE, s.w.orgA, s.w.tenancy);
    await expect(s.send('a', 'x', gia)).rejects.toMatchObject({ code: 'requires_user' });
    await expect(s.send('a', 'x', runtime)).rejects.toMatchObject({ code: 'requires_user' });
    await expect(s.send('a', 'x', s.w.tenantB)).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
    expect(s.invocations).toHaveLength(0);
  });

  it('marks failed what the gate refused, and names a tool a person may not use', async () => {
    for (const [code, expected] of [
      ['runtime_only', 'tool_not_human_invokable'],
      ['permission_not_held', 'permission_not_held'],
      ['environment_not_allowed', 'environment_not_allowed'],
    ] as const) {
      const s = await service(async () => ({ status: 'denied', code }));
      expect((await s.send()).message).toMatchObject({ status: 'failed', failureCode: expected });
    }
  });

  it('leaves unknown what timed out or threw, and never re-invokes it', async () => {
    for (const result of [
      { status: 'timeout', durationMs: 15_000 },
      { status: 'failure', code: 'executor_error' },
    ] as const) {
      const s = await service(async () => result);
      expect((await s.send()).message).toMatchObject({
        status: 'unknown',
        failureCode: 'outcome_unknown',
      });
      expect(await s.send()).toMatchObject({ created: false, message: { status: 'unknown' } });
      expect(s.invocations).toHaveLength(1);
    }
  });

  it('answers a repeat while an attempt holds the node, and never resends a stale one', async () => {
    const s = await service(async () => ({ status: 'denied', code: 'node_not_pending' }));
    // Another attempt holds the node: this one is a duplicate, and sends nothing.
    await expect(s.send()).rejects.toMatchObject({ code: 'duplicate_request' });
    const id = (s.invocations[0] as { executionId: string }).executionId;
    // That attempt started the node, then was lost before it settled the message.
    const runtime = await resolveRuntimeTenant(ALICE, s.w.orgA, s.w.tenancy);
    await s.executions.runtimeChangeNode(runtime, id, {
      nodeId: 'send',
      from: 'pending',
      to: 'running',
    });
    await expect(s.send()).rejects.toMatchObject({ code: 'duplicate_request' });
    // Past the tool's time, nobody will settle it: unknown, never sent again.
    s.w.advance(60_000);
    expect(await s.send()).toMatchObject({
      message: { status: 'unknown', failureCode: 'outcome_unknown' },
    });
    expect(await s.send()).toMatchObject({ created: false, message: { status: 'unknown' } });
  });
});
