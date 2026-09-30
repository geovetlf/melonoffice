import { ConversationError, FOLLOW_UP_TYPES } from '@melonoffice/conversations';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import {
  FOLLOW_UP_TYPE_CODES,
  type ToolExecutionContext,
  type ToolResult,
} from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import {
  AGENT_FOLLOW_UP_SCHEDULE,
  createAgentFollowUpScheduleExecutor,
  createFollowUpScheduleExecutor,
  createGatedFollowUpCreate,
  FOLLOW_UP_SCHEDULE,
  MODEL_FOLLOW_UP_SCHEDULE,
  modelFollowUpKey,
  SCHEDULE_NODE,
} from './follow-up-tool.js';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const FU = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const context = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext =>
  ({
    organizationId: ORG,
    executionId: 'exec',
    nodeId: SCHEDULE_NODE,
    toolId: FOLLOW_UP_SCHEDULE.toolId,
    toolVersion: 1,
    action: 'schedule',
    actor: { userId: ALICE, via: 'direct' },
    riskLevel: 'low',
    environment: 'dev',
    deadline: new Date(Date.now() + 10_000),
    ...over,
  }) as ToolExecutionContext;

/** A tenancy store where Alice is (or is not) an active member. */
const organizations = (member: boolean) => ({
  findMembership: async () =>
    member
      ? ({ id: 'm1', organizationId: ORG, userId: ALICE, status: 'active', role: 'owner' } as never)
      : undefined,
  findOrganization: async () => ({ id: ORG, status: 'active' }) as never,
});

describe('follow_up_schedule executor (TL-1)', () => {
  it('lists the same follow-up types as the conversations domain', () => {
    expect([...FOLLOW_UP_TYPE_CODES]).toEqual([...FOLLOW_UP_TYPES]);
  });

  it("runs the person's own call as them, and passes the service's refusal code back", async () => {
    const seen: { tenant: TenantContext; input: unknown }[] = [];
    let refuse = false;
    const executor = createFollowUpScheduleExecutor({
      organizations: organizations(true),
      followUps: {
        create: async (tenant, input) => {
          seen.push({ tenant, input });
          if (refuse) throw new ConversationError('contact_not_found');
          return { followUp: { id: FU } as never, created: true };
        },
      },
    });
    expect(await executor.execute(context(), { requestKey: 'key-00000001' })).toEqual({
      status: 'success',
      output: { followUpId: FU, created: true },
    });
    expect(seen[0]?.tenant).toMatchObject({ actor: 'user', userId: ALICE, organizationId: ORG });
    refuse = true;
    expect(await executor.execute(context(), {})).toEqual({
      status: 'failure',
      code: 'contact_not_found',
    });
  });

  it("refuses the runtime, GIA's channel, another version, and a person no longer a member", async () => {
    const create = async () => {
      throw new Error('must not run');
    };
    const executor = createFollowUpScheduleExecutor({
      organizations: organizations(true),
      followUps: { create },
    });
    for (const over of [
      { actor: { userId: ALICE, via: 'runtime' as const } },
      { actor: { userId: ALICE, via: 'gia' as const } },
      { toolVersion: 2 },
    ]) {
      expect(await executor.execute(context(over), {})).toEqual({
        status: 'failure',
        code: 'tool_not_human_invokable',
      });
    }
    const gone = createFollowUpScheduleExecutor({
      organizations: organizations(false),
      followUps: { create },
    });
    expect(await gone.execute(context(), {})).toEqual({
      status: 'failure',
      code: 'permission_denied',
    });
  });
});

describe("follow_up_schedule version 2: an agent's, approved by a person (ADR-0084)", () => {
  const agentContext = (over: Partial<ToolExecutionContext> = {}) =>
    context({
      toolVersion: AGENT_FOLLOW_UP_SCHEDULE.version,
      actor: { userId: ALICE, via: 'runtime' },
      specialistId: 'agent-1' as never,
      specialistVersion: 2,
      approvalId: 'approval-1' as never,
      ...over,
    });

  it('runs as the runtime for the person the task is for, through the service', async () => {
    const seen: { tenant: TenantContext; input: unknown }[] = [];
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: {
        create: async (tenant, input) => {
          seen.push({ tenant, input });
          return { followUp: { id: FU } as never, created: true };
        },
      },
    });
    const input = { requestKey: 'agent-task-1', source: 'agent' };
    expect(await executor.execute(agentContext(), input)).toEqual({
      status: 'success',
      output: { followUpId: FU, created: true },
    });
    expect(seen[0]?.tenant).toMatchObject({ actor: 'runtime', userId: ALICE, organizationId: ORG });
    expect(seen[0]?.input).toEqual(input);
  });

  it("refuses a person's call, GIA's, version 1, a call without an agent or an approval, and a person no longer a member", async () => {
    const create = async () => {
      throw new Error('must not run');
    };
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: { create },
    });
    const refused: Partial<ToolExecutionContext>[] = [
      { actor: { userId: ALICE, via: 'direct' as const } },
      { actor: { userId: ALICE, via: 'gia' as const } },
      { toolVersion: 1 },
      { specialistId: undefined },
      { approvalId: undefined },
    ] as Partial<ToolExecutionContext>[];
    for (const over of refused) {
      expect(await executor.execute(agentContext(over), {})).toEqual({
        status: 'failure',
        code: 'tool_not_runtime_invokable',
      });
    }
    const gone = createAgentFollowUpScheduleExecutor({
      organizations: organizations(false) as never,
      followUps: { create },
    });
    expect(await gone.execute(agentContext(), {})).toEqual({
      status: 'failure',
      code: 'permission_denied',
    });
  });
});

describe("follow_up_schedule version 3: asked for by an agent's model, approved by a person (ADR-0104)", () => {
  const OTHER = '9b2e4c1d-0000-4000-8000-000000000001';
  const CALL = {
    contact: 'c_abcdefghij',
    type: 'call',
    title: 'Llamar para confirmar el pedido',
    date: '2026-10-02',
    time: '10:30',
  };
  const modelContext = (over: Partial<ToolExecutionContext> = {}) =>
    context({
      toolVersion: MODEL_FOLLOW_UP_SCHEDULE.version,
      nodeId: 'work_t0' as never,
      actor: { userId: ALICE, via: 'runtime' },
      specialistId: 'agent-1' as never,
      specialistVersion: 3,
      approvalId: 'approval-1' as never,
      ...over,
    });

  /** The service, recording what it is asked, and keeping one follow-up per request key. */
  function service(fail?: Error) {
    const seen: { tenant: TenantContext; input: Record<string, unknown> }[] = [];
    const made = new Map<string, string>();
    return {
      seen,
      made,
      followUps: {
        create: async (tenant: TenantContext, input: Record<string, unknown>) => {
          seen.push({ tenant, input });
          if (fail !== undefined) throw fail;
          const key = String(input.requestKey);
          const created = !made.has(key);
          if (created) made.set(key, `${FU.slice(0, 30)}${String(made.size).padStart(6, '0')}`);
          return { followUp: { id: made.get(key) } as never, created };
        },
      },
    };
  }

  /** The resolver, as the worker builds it: the organization's contacts this person may read. */
  const resolver = (contacts: Record<string, readonly string[]>) => ({
    seen: [] as { tenant: TenantContext; ref: string }[],
    async resolve(tenant: TenantContext, ref: string) {
      this.seen.push({ tenant, ref });
      const found = contacts[ref] ?? [];
      if (found.length === 0) return { problem: 'contact_not_found' as const };
      if (found.length > 1) return { problem: 'contact_ref_ambiguous' as const };
      return { contactId: found[0] as string };
    },
  });

  it('resolves the reference on the server, makes the key there, and schedules as the runtime', async () => {
    const s = service();
    const contacts = resolver({ c_abcdefghij: [FU] });
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: s.followUps,
      contacts,
    });
    const result = await executor.execute(modelContext(), CALL);
    expect(result).toMatchObject({ status: 'success', output: { created: true } });
    // Resolved for the task's person, in the execution's organization.
    expect(contacts.seen[0]?.tenant).toMatchObject({
      actor: 'runtime',
      userId: ALICE,
      organizationId: ORG,
    });
    expect(contacts.seen[0]?.ref).toBe('c_abcdefghij');
    // The service is given the real contact, a key the server made, and source `agent`, never
    // anything the model could choose: no assignee, no opportunity.
    expect(s.seen[0]?.input).toEqual({
      requestKey: modelFollowUpKey('exec', { ...CALL, contactId: FU }),
      contactId: FU,
      type: 'call',
      title: 'Llamar para confirmar el pedido',
      date: '2026-10-02',
      time: '10:30',
      source: 'agent',
    });
    expect(String(s.seen[0]?.input.requestKey)).toMatch(/^agent-task-exec-[0-9a-f]{32}$/);
  });

  it('is idempotent: a retry or a repeated call makes one follow-up; another request, another', async () => {
    const s = service();
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: s.followUps,
      contacts: resolver({ c_abcdefghij: [FU] }),
    });
    const first = await executor.execute(modelContext(), CALL);
    const retry = await executor.execute(modelContext(), CALL);
    const again = await executor.execute(modelContext({ nodeId: 'work_turn2_t0' as never }), {
      ...CALL,
      title: `  ${CALL.title} `,
    });
    expect(first).toMatchObject({ output: { created: true } });
    expect(retry).toEqual({
      ...first,
      output: { ...(first as { output: object }).output, created: false },
    });
    expect(again).toMatchObject({ output: { created: false } });
    expect(s.made.size).toBe(1);
    await executor.execute(modelContext(), { ...CALL, time: '11:00' });
    expect(s.made.size).toBe(2);
    // Another task, the same words: its own follow-up.
    await executor.execute(modelContext({ executionId: 'exec-2' as never }), CALL);
    expect(s.made.size).toBe(3);
  });

  it('schedules nothing for a contact it cannot resolve: unknown, another organization’s, or ambiguous', async () => {
    const s = service();
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: s.followUps,
      // c_bbbbbbbbbb names a contact of another organization: not among this person's.
      contacts: resolver({ c_abcdefghij: [FU, OTHER] }),
    });
    expect(await executor.execute(modelContext(), CALL)).toEqual({
      status: 'failure',
      code: 'contact_ref_ambiguous',
    });
    expect(await executor.execute(modelContext(), { ...CALL, contact: 'c_bbbbbbbbbb' })).toEqual({
      status: 'failure',
      code: 'contact_not_found',
    });
    expect(s.seen).toHaveLength(0);
  });

  it('never runs without an approval, outside the runtime, without an agent or a resolver', async () => {
    const s = service();
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: s.followUps,
      contacts: resolver({ c_abcdefghij: [FU] }),
    });
    expect(
      await executor.execute(
        modelContext({ approvalId: undefined } as unknown as Partial<ToolExecutionContext>),
        CALL,
      ),
    ).toEqual({
      status: 'failure',
      code: 'approval_missing',
    });
    for (const over of [
      { actor: { userId: ALICE, via: 'direct' as const } },
      { actor: { userId: ALICE, via: 'gia' as const } },
      { specialistId: undefined },
    ] as Partial<ToolExecutionContext>[]) {
      expect(await executor.execute(modelContext(over), CALL)).toEqual({
        status: 'failure',
        code: 'tool_not_runtime_invokable',
      });
    }
    const unresolved = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: s.followUps,
    });
    expect(await unresolved.execute(modelContext(), CALL)).toEqual({
      status: 'failure',
      code: 'tool_not_runtime_invokable',
    });
    const gone = createAgentFollowUpScheduleExecutor({
      organizations: organizations(false) as never,
      followUps: s.followUps,
      contacts: resolver({ c_abcdefghij: [FU] }),
    });
    expect(await gone.execute(modelContext(), CALL)).toEqual({
      status: 'failure',
      code: 'permission_denied',
    });
    expect(s.seen).toHaveLength(0);
  });

  it('refuses a malformed call: an id instead of a reference, extra fields, bad dates and times', async () => {
    const s = service();
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: s.followUps,
      contacts: resolver({ c_abcdefghij: [FU] }),
    });
    for (const input of [
      { ...CALL, contact: FU },
      { ...CALL, contactId: FU },
      { ...CALL, requestKey: 'mine-00000001' },
      { ...CALL, source: 'manual' },
      { ...CALL, type: 'meeting' },
      { ...CALL, title: '   ' },
      { ...CALL, title: 'a\u0007b' },
      { ...CALL, date: '02/10/2026' },
      { ...CALL, date: '2026-13-45' },
      { ...CALL, time: '25:00' },
      null,
      'c_abcdefghij',
    ]) {
      expect(await executor.execute(modelContext(), input)).toEqual({
        status: 'failure',
        code: 'invalid_input',
      });
    }
    expect(s.seen).toHaveLength(0);
  });

  it('passes the service’s refusal back as a code, and lets a server error surface to the gate', async () => {
    const refused = service(new ConversationError('invalid_request'));
    const executor = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: refused.followUps,
      contacts: resolver({ c_abcdefghij: [FU] }),
    });
    expect(await executor.execute(modelContext(), CALL)).toEqual({
      status: 'failure',
      code: 'invalid_request',
    });
    const broken = service(new Error('database unavailable'));
    const failing = createAgentFollowUpScheduleExecutor({
      organizations: organizations(true) as never,
      followUps: broken.followUps,
      contacts: resolver({ c_abcdefghij: [FU] }),
    });
    await expect(failing.execute(modelContext(), CALL)).rejects.toThrow('database unavailable');
  });
});

describe('a new follow-up through the gate (TL-1)', () => {
  it('refuses a context resolveTenant did not issue, before anything is recorded', async () => {
    const recorded: string[] = [];
    const service = createGatedFollowUpCreate({
      followUps: {
        checkCreate: async () => void recorded.push('check'),
        get: async () => ({ id: FU }) as never,
      },
      authorization: { authorize: () => ({ allowed: true }) as never },
      executions: {
        create: async () => (recorded.push('execution'), { id: 'e', status: 'pending' }) as never,
        start: async () => ({}) as never,
      },
      gate: {
        invoke: async (): Promise<ToolResult> => {
          recorded.push('gate');
          return { status: 'denied', code: 'runtime_only' };
        },
      },
    });
    const forged = {
      actor: 'user',
      userId: ALICE,
      organizationId: ORG,
    } as unknown as TenantContext;
    await expect(service.create(forged, { requestKey: 'key-00000001' })).rejects.toMatchObject({
      code: 'unresolved_tenant',
    });
    expect(recorded).toEqual([]);
  });
});
