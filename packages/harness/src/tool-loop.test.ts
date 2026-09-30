import type {
  AgentToolCallRecord,
  Execution,
  ExecutionNode,
  SpecialistId,
  ToolVersion,
} from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { MODEL_TOOL_CALL_INPUT } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import {
  createHarnessToolLoop,
  createHarnessToolOffer,
  HARNESS_TURN_INPUT,
  workingTimeMs,
} from './tool-loop.js';
import type { HarnessToolDirectory } from './tools.js';

/**
 * The Harness's tool loop (ADR-0103), decision by decision, on plain records. The end-to-end run
 * on the real runtime, Tool Gate, AI Gateway and approvals is in the worker's tests.
 */

const TENANT = {} as TenantContext;

const version = (id: string, overrides: Partial<ToolVersion> = {}): ToolVersion =>
  ({
    toolId: id,
    version: 1,
    nameKey: `tools.${id}.name`,
    descriptionKey: `tools.${id}.description`,
    category: 'test',
    action: 'run',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string', maxLength: 200 } },
      required: ['subject'],
    },
    outputSchema: { type: 'object', properties: {} },
    permissions: [],
    credentials: [],
    riskLevel: 'low',
    approvalPolicy: 'auto',
    approvalTtlSeconds: 600,
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    provider: { kind: 'internal', id: 'fixture' },
    environments: ['dev'],
    invocationModes: ['runtime', 'model'],
    ...overrides,
  }) as ToolVersion;

const LOOKUP = version('lookup');
const UPDATE = version('update_record', { mutating: true });
const SEND = version('send_email', {
  mutating: true,
  action: 'send',
  provider: { kind: 'external', id: 'fixture' },
});
const RISKY = version('close_account', { mutating: true, riskLevel: 'high' });
const FORBIDDEN = version('wipe_data', { mutating: true, approvalPolicy: 'denied' });

const node = (id: string, fields: Partial<ExecutionNode> = {}): ExecutionNode =>
  ({
    id,
    type: 'agent',
    label: 'agent_task',
    status: 'completed',
    dependsOn: [],
    ...fields,
  }) as never;

const executionOf = (nodes: readonly ExecutionNode[], fields: Partial<Execution> = {}) =>
  ({
    id: 'e1',
    specialistId: 'agent-1',
    specialistVersion: 3,
    createdAt: '2026-09-30T12:00:00.000Z',
    startedAt: '2026-09-30T12:00:00.000Z',
    nodes,
    ...fields,
  }) as unknown as Execution;

const call = (name: string, subject: string, id = `c_${subject}`): AgentToolCallRecord => ({
  id,
  name,
  arguments: { subject },
});

type Kept = { text?: string; structured?: unknown; toolCalls?: readonly AgentToolCallRecord[] };

function loopOf(
  tools: readonly ToolVersion[],
  kept: Record<string, Kept> = {},
  options: Partial<Parameters<typeof createHarnessToolLoop>[0]> = {},
) {
  return createHarnessToolLoop({
    offer: { tools: async () => tools },
    outputs: {
      find: async (_tenant, _execution, nodeId) =>
        kept[nodeId] === undefined
          ? undefined
          : ({ output: kept[nodeId], ai: kept[nodeId] } as never),
    },
    now: () => new Date('2026-09-30T12:01:00Z'),
    ...options,
  });
}

const WORK = {
  taskType: 'agent_task',
  capability: 'text_generation' as const,
  requirements: { structuredOutput: true },
  outputSchema: { type: 'object' as const, properties: {} },
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }],
  outputModality: 'text' as const,
  maxOutputTokens: 100,
  sensitivity: 'confidential' as const,
};
const inner = {
  toolInput: async () => ({ fixed: true }),
  agentWork: async (_t: TenantContext, _e: Execution, n: ExecutionNode) =>
    n.id === 'work' ? WORK : undefined,
};

describe('Harness tool loop: what the agent may use (ADR-0103)', () => {
  it('runs A and B at once, and marks C, and anything risky, for a person', async () => {
    const loop = loopOf([LOOKUP, UPDATE, SEND, RISKY]);
    const work = node('work', { status: 'running' });
    const plan = await loop.plan(TENANT, executionOf([work]), work, [
      call('lookup', 'a'),
      call('update_record', 'b'),
      call('send_email', 'c'),
      call('close_account', 'd'),
    ]);
    expect('nodes' in plan).toBe(true);
    const nodes = 'nodes' in plan ? plan.nodes : [];
    expect(nodes.map((n) => [n.id, n.tool?.id, n.approvalRequired ?? false])).toEqual([
      ['work_t0', 'lookup', false],
      ['work_t1', 'update_record', false],
      ['work_t2', 'send_email', true],
      ['work_t3', 'close_account', true],
      ['work_turn2', undefined, false],
    ]);
    expect(nodes[0]).toMatchObject({
      type: 'tool',
      dependsOn: ['work'],
      input: { type: MODEL_TOOL_CALL_INPUT, id: 'work:0' },
    });
    expect(nodes[4]).toMatchObject({
      type: 'agent',
      dependsOn: ['work', 'work_t0', 'work_t1', 'work_t2', 'work_t3'],
      input: { type: HARNESS_TURN_INPUT, id: 'work' },
    });
  });

  it('asks a person for B too when the organization runs only A without one', async () => {
    const loop = loopOf([LOOKUP, UPDATE], {}, { policy: { automatic: ['A'] } });
    const work = node('work', { status: 'running' });
    const plan = await loop.plan(TENANT, executionOf([work]), work, [
      call('lookup', 'a'),
      call('update_record', 'b'),
    ]);
    const nodes = 'nodes' in plan ? plan.nodes : [];
    expect(nodes.map((n) => n.approvalRequired ?? false)).toEqual([false, true, false]);
  });

  it('never offers a denied tool, and stops a call to any tool it did not offer', async () => {
    const loop = loopOf([LOOKUP, FORBIDDEN]);
    const work = node('work', { status: 'pending' });
    const request = await loop.work(inner).agentWork(TENANT, executionOf([work]), work);
    expect(request?.tools?.map((t) => t.name)).toEqual(['lookup']);
    const plan = await loop.plan(TENANT, executionOf([work]), work, [call('plain_lookup', 'a')]);
    expect(plan).toEqual({ stop: 'tool_not_granted' });
    expect(await loop.plan(TENANT, executionOf([work]), work, [call('wipe_data', 'a')])).toEqual({
      stop: 'tool_denied',
    });
  });

  it('offers nothing when other nodes wait on the answer (a follow-up node, ADR-0084)', async () => {
    const loop = loopOf([LOOKUP]);
    const work = node('work', { status: 'pending' });
    const schedule = node('schedule', {
      type: 'tool',
      status: 'pending',
      dependsOn: ['work' as never],
    });
    const execution = executionOf([work, schedule]);
    // Exactly the work as it was: no tools, the answer shape kept.
    expect(await loop.work(inner).agentWork(TENANT, execution, work)).toBe(WORK);
    expect(await loop.plan(TENANT, execution, work, [call('lookup', 'a')])).toEqual({
      stop: 'tool_use_unsupported',
    });
  });

  it('offers only tools that say `model` and can run here, at the execution’s exact version', async () => {
    const asked: unknown[] = [];
    const directory: HarnessToolDirectory = {
      async granted(_tenant, specialistId, at) {
        asked.push([specialistId, at]);
        return [
          LOOKUP,
          version('plain', { invocationModes: ['runtime'] }),
          version('remote', {
            provider: { kind: 'external', id: 'elsewhere' },
          }),
        ];
      },
    };
    const offer = createHarnessToolOffer({ directory, executors: ['fixture'] });
    expect((await offer.tools(TENANT, executionOf([]))).map((t) => t.toolId)).toEqual(['lookup']);
    expect(asked).toEqual([['agent-1' as SpecialistId, 3]]);
  });
});

describe('Harness tool loop: the turns (ADR-0103)', () => {
  it('offers tools on the first turn as the gateway expects, with the answer read from text', async () => {
    const loop = loopOf([LOOKUP]);
    const work = node('work', { status: 'pending' });
    const request = await loop.work(inner).agentWork(TENANT, executionOf([work]), work);
    expect(request).toMatchObject({ requirements: { toolUse: true } });
    expect(request?.requirements?.structuredOutput).toBeUndefined();
    expect(request?.outputSchema).toBeUndefined();
    expect(request?.tools).toEqual([
      { name: 'lookup', description: 'lookup (run).', parameters: LOOKUP.inputSchema },
    ]);
  });

  it('gives a later turn every call and its result: a repeat reads the first, a failure its code', async () => {
    const execution = executionOf([
      node('work'),
      node('work_t0', { type: 'tool', input: { type: MODEL_TOOL_CALL_INPUT, id: 'work:0' } }),
      node('work_t1', {
        type: 'tool',
        status: 'failed',
        error: { code: 'record_store_down' },
        input: { type: MODEL_TOOL_CALL_INPUT, id: 'work:1' },
      }),
      node('work_turn2', { input: { type: HARNESS_TURN_INPUT, id: 'work' } }),
      node('work_turn2_t1', {
        type: 'tool',
        input: { type: MODEL_TOOL_CALL_INPUT, id: 'work_turn2:1' },
      }),
      node('work_turn3', { status: 'pending', input: { type: HARNESS_TURN_INPUT, id: 'work' } }),
    ]);
    const loop = loopOf([LOOKUP], {
      work: { text: 'Let me check.', toolCalls: [call('lookup', 'a'), call('lookup', 'b')] },
      work_t0: { structured: { count: 3 } },
      work_turn2: { toolCalls: [call('lookup', 'a', 'again'), call('lookup', 'c')] },
      work_turn2_t1: { structured: { count: 7 } },
    });
    const turn = must(execution.nodes[5]);
    const request = await loop.work(inner).agentWork(TENANT, execution, turn);
    const messages = request?.messages ?? [];
    expect(messages.map((m) => [m.role, m.content.map((p) => p.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['text', 'tool_call', 'tool_call']],
      ['user', ['tool_result', 'tool_result']],
      ['assistant', ['tool_call', 'tool_call']],
      ['user', ['tool_result', 'tool_result']],
    ]);
    const results = messages.flatMap((m) =>
      m.content.flatMap((p) => (p.type === 'tool_result' ? [[p.callId, p.result]] : [])),
    );
    expect(results).toEqual([
      ['c_a', { count: 3 }],
      ['c_b', { error: 'record_store_down' }],
      ['again', { count: 3 }],
      ['c_c', { count: 7 }],
    ]);
  });

  it('tells the last turn a task may take to answer, keeping its tools declared', async () => {
    const execution = executionOf([
      node('work'),
      node('work_t0', { type: 'tool', input: { type: MODEL_TOOL_CALL_INPUT, id: 'work:0' } }),
      node('work_turn2', { status: 'pending', input: { type: HARNESS_TURN_INPUT, id: 'work' } }),
    ]);
    const loop = loopOf(
      [LOOKUP],
      { work: { toolCalls: [call('lookup', 'a')] }, work_t0: { structured: { count: 3 } } },
      {
        limits: {
          maxSteps: 2,
          maxAgents: 4,
          maxDepth: 1,
          maxModelCalls: 3,
          maxToolCalls: 5,
          maxDurationMs: 600_000,
        },
      },
    );
    const request = await loop.work(inner).agentWork(TENANT, execution, must(execution.nodes[2]));
    expect(request?.tools?.map((t) => t.name)).toEqual(['lookup']);
    expect(JSON.stringify(request?.messages.at(-1))).toContain('can use no more tools');
    // Asking anyway stops the task at its steps.
    expect(
      await loop.plan(TENANT, execution, must(execution.nodes[2]), [call('lookup', 'b')]),
    ).toEqual({ stop: 'step_limit_reached' });
  });

  it('gives a tool node exactly its call’s arguments, and nothing for another tool', async () => {
    const loop = loopOf([LOOKUP], { work: { toolCalls: [call('lookup', 'a')] } });
    const source = loop.work(inner);
    const execution = executionOf([node('work')]);
    const tool = (id: string) =>
      node('work_t0', {
        type: 'tool',
        tool: { id, version: 1 } as never,
        input: { type: MODEL_TOOL_CALL_INPUT, id: 'work:0' },
      });
    expect(await source.toolInput(TENANT, execution, tool('lookup'))).toEqual({ subject: 'a' });
    expect(await source.toolInput(TENANT, execution, tool('update_record'))).toBeUndefined();
    // Any other node is the work source's own.
    expect(await source.toolInput(TENANT, execution, node('schedule', { type: 'tool' }))).toEqual({
      fixed: true,
    });
    expect(source.keepsToolOutput(tool('lookup'))).toBe(true);
    expect(source.keepsToolOutput(node('schedule', { type: 'tool' }))).toBe(false);
  });

  it('counts a task’s working time without the time it waited on a person', () => {
    const execution = executionOf([
      node('work', { completedAt: '2026-09-30T12:01:00.000Z' as never }),
      node('work_t0', {
        type: 'tool',
        dependsOn: ['work' as never],
        approvalId: 'a1' as never,
        startedAt: '2026-09-30T14:01:00.000Z' as never,
      }),
    ]);
    // Two hours and three minutes since it started, two of them waiting on the person.
    expect(workingTimeMs(execution, new Date('2026-09-30T14:03:00Z'))).toBe(3 * 60_000);
    // Still waiting: the wait goes on to now.
    const waiting = executionOf([
      node('work', { completedAt: '2026-09-30T12:01:00.000Z' as never }),
      node('work_t0', { type: 'tool', dependsOn: ['work' as never], approvalId: 'a1' as never }),
    ]);
    expect(workingTimeMs(waiting, new Date('2026-09-30T18:00:00Z'))).toBe(60_000);
  });

  it('adds up what the earlier turns spent, for the task’s budget', async () => {
    const loop = loopOf([LOOKUP], {
      work: { creditsConsumed: 1 } as never,
      work_turn2: { creditsConsumed: 2 } as never,
    });
    const execution = executionOf([
      node('work'),
      node('work_turn2', { input: { type: HARNESS_TURN_INPUT, id: 'work' } }),
      node('work_turn3', { status: 'pending', input: { type: HARNESS_TURN_INPUT, id: 'work' } }),
    ]);
    expect(await loop.spent(TENANT, execution)).toBe(3);
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}
