import type {
  Execution,
  ExecutionStatus,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { ExecutionError } from './errors.js';
import {
  canTransition,
  EXECUTION_MODES,
  EXECUTION_STATUSES,
  EXECUTION_TRANSITIONS,
  isTerminal,
  TERMINAL_STATUSES,
} from './lifecycle.js';
import {
  addNodes,
  applyNodeChange,
  attachApproval,
  applyStatusChange,
  checkSnapshot,
  checkStoredExecution,
  executionIdFor,
  isExecutionId,
  MAX_NODES,
  newExecution,
  recordVerification,
  startExecution,
  type NewExecution,
  type NodeInput,
} from './model.js';

const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId;
const ALICE = '22222222-2222-4222-8222-222222222222' as UserId;
const T0 = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
const T1 = '2026-09-27T12:00:01.000Z' as IsoTimestamp;
const SNAPSHOT = {
  schemaVersion: 1,
  components: [
    { kind: 'specialist', id: 'spec-1', version: '4' },
    { kind: 'role', id: 'meta_ads', version: '2' },
    { kind: 'skill', id: 'copywriting', version: '7' },
  ],
} as const;

const request = (extra: Partial<NewExecution> = {}): NewExecution => ({
  organizationId: ORG,
  userId: ALICE,
  mode: 'execute',
  input: { type: 'task', id: 'task-1' },
  versionSnapshot: SNAPSHOT,
  ...extra,
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ExecutionError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** Runs every pending node to completion, as work that finished would. */
function finishNodes(execution: Execution): Execution {
  let next = execution;
  for (const node of execution.nodes.filter((n) => n.status === 'pending')) {
    next = applyNodeChange(next, { nodeId: node.id, from: 'pending', to: 'running' }, T1);
    next = applyNodeChange(next, { nodeId: node.id, from: 'running', to: 'completed' }, T1);
  }
  return next;
}

/** Records a passing verification of every completed node. */
function verified(execution: Execution): Execution {
  return recordVerification(
    execution,
    {
      correlationId: 'req-verify',
      nodes: execution.nodes
        .filter((n) => n.status === 'completed')
        .map((n) => ({
          nodeId: n.id,
          policy: 'checks',
          checks: [
            { code: 'output_present', result: 'passed', evidence: { type: 'check', id: 'e1' } },
          ],
        })),
    },
    T1,
  );
}

/**
 * Moves a new execution through the given statuses, as its callers would: a user starts it, its
 * work finishes before `verifying`, and a verification passes before `completed`. A path that
 * does not start with `running` reaches it as a planning execution, through its plan.
 */
function through(...statuses: ExecutionStatus[]): Execution {
  let execution = newExecution(
    request({
      mode: statuses[0] === 'running' ? 'execute' : 'plan',
      nodes: [{ id: 'n', type: 'condition', label: 'Check' }],
    }),
    T0,
  );
  for (const to of statuses) {
    if (to === 'running' && execution.status === 'pending') {
      execution = startExecution(execution, T1);
      continue;
    }
    if (to === 'verifying') execution = finishNodes(execution);
    if (to === 'completed') execution = verified(execution);
    execution = applyStatusChange(
      execution,
      {
        from: execution.status,
        to,
        ...(to === 'failed' ? { failure: { code: 'tool_error' } } : {}),
        ...(to === 'cancelled' ? { reason: 'director_request' } : {}),
      },
      ALICE,
      T1,
    );
  }
  return execution;
}

describe('creation', () => {
  it('creates a frozen pending execution at revision 1 with a UUID', () => {
    const execution = newExecution(request({ requestId: 'req-1' }), T0);
    expect(execution).toMatchObject({
      organizationId: ORG,
      userId: ALICE,
      mode: 'execute',
      status: 'pending',
      input: { type: 'task', id: 'task-1' },
      nodes: [],
      requestId: 'req-1',
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(execution.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(execution)).toBe(true);
    expect(newExecution(request(), T0).id).not.toBe(execution.id);
    expect(execution).not.toHaveProperty('startedAt');
    expect(execution).not.toHaveProperty('completedAt');
  });

  it('keeps only known fields, so nothing else reaches storage', () => {
    const execution = newExecution(
      {
        ...request(),
        prompt: 'secret prompt',
        apiKey: 'sk-123',
        headers: { authorization: 'Bearer x' },
        input: { type: 'task', id: 'task-1', body: 'large payload' },
      } as never,
      T0,
    );
    expect(JSON.stringify(execution)).not.toMatch(/secret|sk-123|Bearer|payload/);
  });

  it.each(EXECUTION_MODES)('accepts the %s mode', (mode) => {
    expect(newExecution(request({ mode }), T0).mode).toBe(mode);
  });

  it.each([
    ['an unknown mode', { mode: 'run' }],
    ['an uppercase mode', { mode: 'EXECUTE' }],
    ['an input without id', { input: { type: 'task' } }],
    ['an input with a bad type', { input: { type: 'Task Type', id: 'x' } }],
    ['an input id with spaces', { input: { type: 'task', id: 'a b' } }],
    ['a malformed parent', { parentExecutionId: 'not-a-uuid' }],
    ['a malformed workflow id', { workflowId: 'a/b' }],
    ['a malformed specialist id', { specialistId: '' }],
  ])('refuses %s', (_, extra) => {
    expect(codeOf(() => newExecution(request(extra as Partial<NewExecution>), T0))).toBe(
      'invalid_execution',
    );
  });

  it('drops a malformed request id instead of storing it', () => {
    expect(newExecution(request({ requestId: 'bad id\n' }), T0)).not.toHaveProperty('requestId');
  });
});

describe('state machine', () => {
  it('has exactly the ten statuses, three of them terminal', () => {
    expect(EXECUTION_STATUSES).toEqual([
      'pending',
      'planning',
      'waiting_approval',
      'running',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'paused',
      'retrying',
    ]);
    expect(TERMINAL_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
    for (const status of TERMINAL_STATUSES) expect(EXECUTION_TRANSITIONS[status]).toEqual([]);
  });

  it('allows every listed transition and refuses every other one without changing anything', () => {
    let allowed = 0;
    let refused = 0;
    const paths: Record<ExecutionStatus, ExecutionStatus[]> = {
      pending: [],
      planning: ['planning'],
      waiting_approval: ['waiting_approval'],
      running: ['running'],
      verifying: ['running', 'verifying'],
      paused: ['running', 'paused'],
      retrying: ['running', 'retrying'],
      completed: ['running', 'verifying', 'completed'],
      failed: ['failed'],
      cancelled: ['cancelled'],
    };
    for (const from of EXECUTION_STATUSES) {
      const reached = through(...paths[from]);
      expect(reached.status).toBe(from);
      for (const to of EXECUTION_STATUSES) {
        const change = {
          from,
          to,
          ...(to === 'failed' ? { failure: { code: 'tool_error' } } : {}),
          ...(to === 'cancelled' ? { reason: 'director_request' } : {}),
        };
        // What each caller does first: work finishes before verifying, a verifier passes before
        // completing. Neither changes the status.
        const before =
          to === 'verifying' && !isTerminal(from)
            ? finishNodes(reached)
            : to === 'completed' && from === 'verifying'
              ? verified(reached)
              : reached;
        const code = codeOf(() => applyStatusChange(before, change, ALICE, T1));
        if (from === 'pending' && to === 'running') {
          // Allowed by the table, but only a user's start takes it (ADR-0029).
          expect(code).toBe('execution_not_started');
          refused += 1;
        } else if (canTransition(from, to)) {
          expect(code).toBe('accepted');
          allowed += 1;
        } else {
          expect(code).toBe(
            isTerminal(from) ? 'execution_already_terminal' : 'invalid_execution_transition',
          );
          refused += 1;
        }
        expect(before.status).toBe(from);
      }
    }
    expect(allowed + refused).toBe(100);
  });

  it('reaches completed only through verifying', () => {
    expect(codeOf(() => through('running', 'completed'))).toBe('invalid_execution_transition');
    expect(through('running', 'verifying', 'completed').status).toBe('completed');
  });

  it('records start and end times, and bumps the revision on every change', () => {
    const done = through('planning', 'running', 'verifying', 'completed');
    // Created, planning, running, the node's two changes, verifying, verified, completed.
    expect(done).toMatchObject({ startedAt: T1, completedAt: T1, revision: 8 });
    const paused = through('running', 'paused', 'running');
    expect(paused.startedAt).toBe(T1);
    expect(paused).not.toHaveProperty('completedAt');
  });

  it('refuses a change when the execution is no longer in the status the caller saw', () => {
    const running = through('running');
    expect(
      codeOf(() => applyStatusChange(running, { from: 'pending', to: 'running' }, ALICE, T1)),
    ).toBe('execution_concurrency_conflict');
  });

  it('requires a failure for failed and a reason code for cancelled, and nothing else', () => {
    const running = finishNodes(through('running'));
    const refuse = (change: object) =>
      codeOf(() => applyStatusChange(running, { from: 'running', ...change } as never, ALICE, T1));
    expect(refuse({ to: 'failed' })).toBe('invalid_execution');
    expect(refuse({ to: 'failed', failure: { code: 'Bad Code' } })).toBe('invalid_execution');
    expect(refuse({ to: 'cancelled' })).toBe('invalid_execution');
    expect(refuse({ to: 'cancelled', reason: 'free text reason' })).toBe('invalid_execution');
    expect(refuse({ to: 'verifying', reason: 'x' })).toBe('invalid_execution');
    expect(refuse({ to: 'verifying', result: { type: 'document', id: 'd1' } })).toBe(
      'invalid_execution',
    );
    const done = applyStatusChange(
      verified(through('running', 'verifying')),
      { from: 'verifying', to: 'completed', result: { type: 'document', id: 'd1' } },
      ALICE,
      T1,
    );
    expect(done.result).toEqual({ type: 'document', id: 'd1' });
  });
});

describe('cancellation', () => {
  it('is terminal: nothing moves a cancelled execution, and it records who and why', () => {
    const cancelled = through('running', 'cancelled');
    expect(cancelled.cancellation).toEqual({ at: T1, by: ALICE, reason: 'director_request' });
    for (const to of EXECUTION_STATUSES) {
      expect(
        codeOf(() =>
          applyStatusChange(cancelled, { from: 'cancelled', to, reason: 'x' }, ALICE, T1),
        ),
      ).toBe('execution_already_terminal');
    }
    expect(codeOf(() => addNodes(cancelled, [{ id: 'n9', type: 'tool', label: 'Late' }], T1))).toBe(
      'execution_already_terminal',
    );
  });

  it('is reachable from every non-terminal status', () => {
    for (const from of EXECUTION_STATUSES.filter((s) => !isTerminal(s))) {
      expect(canTransition(from, 'cancelled')).toBe(true);
    }
  });

  it('cancels every unfinished node, and keeps finished ones as they were', () => {
    let execution = newExecution(
      request({
        nodes: [
          { id: 'a', type: 'agent', label: 'Research' },
          {
            id: 'b',
            type: 'tool',
            label: 'Search',
            dependsOn: ['a'],
            tool: { id: 'web_search', version: 1 },
          },
          { id: 'c', type: 'verification', label: 'Check', dependsOn: ['b'] },
        ],
      }),
      T0,
    );
    execution = startExecution(execution, T1);
    execution = applyNodeChange(execution, { nodeId: 'a', from: 'pending', to: 'running' }, T1);
    execution = applyNodeChange(execution, { nodeId: 'a', from: 'running', to: 'completed' }, T1);
    execution = applyNodeChange(execution, { nodeId: 'b', from: 'pending', to: 'running' }, T1);
    const cancelled = applyStatusChange(
      execution,
      { from: 'running', to: 'cancelled', reason: 'director_request' },
      ALICE,
      T1,
    );
    expect(cancelled.nodes.map((n) => n.status)).toEqual(['completed', 'cancelled', 'cancelled']);
    expect(
      codeOf(() =>
        applyNodeChange(cancelled, { nodeId: 'c', from: 'cancelled', to: 'running' }, T1),
      ),
    ).toBe('execution_already_terminal');
  });
});

describe('graph', () => {
  const nodes: NodeInput[] = [
    {
      id: 'research',
      type: 'agent',
      label: 'Research',
      owner: { kind: 'specialist', id: 's1', version: '3' },
    },
    { id: 'approve', type: 'approval', label: 'Director approval', dependsOn: ['research'] },
    {
      id: 'publish',
      type: 'tool',
      label: 'Publish',
      dependsOn: ['approve'],
      input: { type: 'draft', id: 'd1' },
      tool: { id: 'publish_post', version: 2 },
    },
    { id: 'verify', type: 'verification', label: 'Verify', dependsOn: ['publish'] },
  ];

  it('stores typed nodes, all pending, and is plain serializable data', () => {
    const execution = newExecution(request({ nodes }), T0);
    expect(execution.nodes.map((n) => [n.id, n.type, n.status])).toEqual([
      ['research', 'agent', 'pending'],
      ['approve', 'approval', 'pending'],
      ['publish', 'tool', 'pending'],
      ['verify', 'verification', 'pending'],
    ]);
    expect(JSON.parse(JSON.stringify(execution))).toEqual(execution);
  });

  it.each([
    'agent',
    'workflow',
    'tool',
    'approval',
    'condition',
    'verification',
    'parallel',
    'delay',
    'event',
  ])('accepts a %s node', (type) => {
    expect(
      newExecution(
        request({
          nodes: [
            {
              id: 'n',
              type,
              label: 'x',
              ...(type === 'tool' ? { tool: { id: 'web_search', version: 1 } } : {}),
            } as NodeInput,
          ],
        }),
        T0,
      ).nodes,
    ).toHaveLength(1);
  });

  it('names the exact tool version on tool nodes, and only on them (ADR-0026)', () => {
    const tool = { id: 'web_search', version: 3 };
    const [node] = newExecution(
      request({ nodes: [{ id: 't', type: 'tool', label: 'Search', tool }] }),
      T0,
    ).nodes;
    expect(node?.tool).toEqual(tool);
    for (const bad of [
      { id: 't', type: 'tool', label: 'x' },
      { id: 't', type: 'tool', label: 'x', tool: { id: 'Web Search', version: 1 } },
      { id: 't', type: 'tool', label: 'x', tool: { id: 'web_search', version: 0 } },
      { id: 't', type: 'agent', label: 'x', tool },
    ]) {
      expect(codeOf(() => newExecution(request({ nodes: [bad as NodeInput] }), T0))).toBe(
        'invalid_execution',
      );
    }
  });

  it('attaches one approval to a pending tool node, never a second one', () => {
    const approval = '33333333-3333-4333-8333-333333333333';
    const execution = newExecution(
      request({
        nodes: [
          { id: 't', type: 'tool', label: 'Send', tool: { id: 'send_email', version: 1 } },
          { id: 'a', type: 'agent', label: 'Write' },
        ],
      }),
      T0,
    );
    const attached = attachApproval(execution, 't', approval, T1);
    expect(attached.nodes[0]?.approvalId).toBe(approval);
    expect(attached.revision).toBe(2);
    expect(checkStoredExecution(attached)).toBe(attached);
    const other = '44444444-4444-4444-8444-444444444444';
    expect(codeOf(() => attachApproval(attached, 't', other, T1))).toBe(
      'execution_concurrency_conflict',
    );
    expect(codeOf(() => attachApproval(execution, 'a', approval, T1))).toBe('invalid_execution');
    expect(codeOf(() => attachApproval(execution, 't', 'not-a-uuid', T1))).toBe(
      'invalid_execution',
    );
  });

  it.each([
    ['an unknown type', [{ id: 'a', type: 'script', label: 'x' }]],
    [
      'a duplicate id',
      [
        { id: 'a', type: 'tool', label: 'x' },
        { id: 'a', type: 'tool', label: 'y' },
      ],
    ],
    ['an unknown dependency', [{ id: 'a', type: 'tool', label: 'x', dependsOn: ['b'] }]],
    ['a self dependency', [{ id: 'a', type: 'tool', label: 'x', dependsOn: ['a'] }]],
    [
      'a cycle',
      [
        { id: 'a', type: 'tool', label: 'x', dependsOn: ['c'] },
        { id: 'b', type: 'tool', label: 'y', dependsOn: ['a'] },
        { id: 'c', type: 'tool', label: 'z', dependsOn: ['b'] },
      ],
    ],
    ['an empty label', [{ id: 'a', type: 'tool', label: '  ' }]],
    ['a label with control characters', [{ id: 'a', type: 'tool', label: 'x\ny' }]],
    ['a long label', [{ id: 'a', type: 'tool', label: 'x'.repeat(121) }]],
    ['a malformed id', [{ id: 'a b', type: 'tool', label: 'x' }]],
    [
      'a malformed owner',
      [{ id: 'a', type: 'agent', label: 'x', owner: { kind: 'specialist', id: 's1' } }],
    ],
    [
      'too many nodes',
      Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, type: 'tool', label: 'x' })),
    ],
  ])('refuses %s', (_, graph) => {
    expect(codeOf(() => newExecution(request({ nodes: graph as NodeInput[] }), T0))).toBe(
      'invalid_execution',
    );
  });

  it('starts a node only when its dependencies are done, and tracks the current node', () => {
    let execution = newExecution(request({ nodes }), T0);
    expect(
      codeOf(() =>
        applyNodeChange(execution, { nodeId: 'approve', from: 'pending', to: 'running' }, T1),
      ),
    ).toBe('invalid_execution_transition');
    execution = applyNodeChange(
      execution,
      { nodeId: 'research', from: 'pending', to: 'running' },
      T1,
    );
    expect(execution.currentNodeId).toBe('research');
    execution = applyNodeChange(
      execution,
      {
        nodeId: 'research',
        from: 'running',
        to: 'completed',
        output: { type: 'report', id: 'r1' },
      },
      T1,
    );
    expect(execution.nodes[0]).toMatchObject({
      status: 'completed',
      output: { type: 'report', id: 'r1' },
      startedAt: T1,
      completedAt: T1,
    });
    execution = applyNodeChange(
      execution,
      { nodeId: 'approve', from: 'pending', to: 'skipped' },
      T1,
    );
    expect(
      applyNodeChange(execution, { nodeId: 'publish', from: 'pending', to: 'running' }, T1)
        .currentNodeId,
    ).toBe('publish');
  });

  it('refuses unknown nodes, stale node states, final nodes and misplaced details', () => {
    const execution = newExecution(request({ nodes }), T0);
    expect(
      codeOf(() => applyNodeChange(execution, { nodeId: 'x', from: 'pending', to: 'running' }, T1)),
    ).toBe('invalid_execution');
    expect(
      codeOf(() =>
        applyNodeChange(execution, { nodeId: 'research', from: 'running', to: 'completed' }, T1),
      ),
    ).toBe('execution_concurrency_conflict');
    const failed = applyNodeChange(
      applyNodeChange(execution, { nodeId: 'research', from: 'pending', to: 'running' }, T1),
      { nodeId: 'research', from: 'running', to: 'failed', error: { code: 'provider_timeout' } },
      T1,
    );
    expect(
      codeOf(() =>
        applyNodeChange(failed, { nodeId: 'research', from: 'failed', to: 'running' }, T1),
      ),
    ).toBe('invalid_execution_transition');
    const running = applyNodeChange(
      execution,
      { nodeId: 'research', from: 'pending', to: 'running' },
      T1,
    );
    expect(
      codeOf(() =>
        applyNodeChange(running, { nodeId: 'research', from: 'running', to: 'failed' }, T1),
      ),
    ).toBe('invalid_execution');
    expect(
      codeOf(() =>
        applyNodeChange(
          running,
          { nodeId: 'research', from: 'running', to: 'cancelled', output: { type: 'x', id: 'y' } },
          T1,
        ),
      ),
    ).toBe('invalid_execution');
  });

  it('adds nodes to a running graph, keeping it acyclic and unique', () => {
    const execution = newExecution(request({ nodes }), T0);
    const grown = addNodes(
      execution,
      [{ id: 'report', type: 'agent', label: 'Report', dependsOn: ['verify'] }],
      T1,
    );
    expect(grown.nodes).toHaveLength(5);
    expect(grown.revision).toBe(2);
    expect(
      codeOf(() => addNodes(execution, [{ id: 'research', type: 'agent', label: 'Again' }], T1)),
    ).toBe('invalid_execution');
    expect(codeOf(() => addNodes(execution, [], T1))).toBe('invalid_execution');
  });
});

describe('version snapshot', () => {
  it('is recorded at creation, frozen, and never changes with later changes', () => {
    const role = { kind: 'role', id: 'meta_ads', version: '2' };
    const components = [SNAPSHOT.components[0], role, SNAPSHOT.components[2]].map((c) => ({
      ...c,
    }));
    const [, mutable] = components;
    const execution = newExecution(
      request({ versionSnapshot: { schemaVersion: 1, components } }),
      T0,
    );
    if (mutable !== undefined) mutable.version = '99';
    role.version = '98';
    components.push({ kind: 'tool', id: 'new', version: '1' });
    expect(execution.versionSnapshot).toEqual(SNAPSHOT);
    expect(Object.isFrozen(execution.versionSnapshot.components)).toBe(true);
    const later = through('running', 'verifying', 'completed');
    expect(later.versionSnapshot).toEqual(SNAPSHOT);
  });

  it('grows with new kinds of components without a schema change', () => {
    const snapshot = checkSnapshot({
      schemaVersion: 1,
      components: [
        { kind: 'workflow', id: 'wf-1', version: '3' },
        { kind: 'tool', id: 'gmail_send', version: '1.2.0' },
        { kind: 'policy', id: 'approval_default', version: '5' },
        { kind: 'model', id: 'provider:model-name', version: '2026-09-01' },
      ],
    });
    expect(snapshot.components).toHaveLength(4);
  });

  it.each([
    ['another schema version', { schemaVersion: 2, components: [] }],
    ['a component without version', { schemaVersion: 1, components: [{ kind: 'role', id: 'r' }] }],
    [
      'the same component twice',
      {
        schemaVersion: 1,
        components: [
          { kind: 'role', id: 'r', version: '1' },
          { kind: 'role', id: 'r', version: '2' },
        ],
      },
    ],
    [
      'a malformed kind',
      { schemaVersion: 1, components: [{ kind: 'Role', id: 'r', version: '1' }] },
    ],
    ['no components list', { schemaVersion: 1 }],
  ])('refuses %s', (_, snapshot) => {
    expect(codeOf(() => checkSnapshot(snapshot))).toBe('invalid_execution');
  });
});

describe('stored records', () => {
  it('refuses a record with an unknown status, mode or node status', () => {
    const execution = through('running');
    expect(checkStoredExecution(execution)).toBe(execution);
    for (const broken of [
      { ...execution, status: 'done' },
      { ...execution, mode: 'EXECUTE' },
      { ...execution, revision: 0 },
      {
        ...execution,
        nodes: [{ id: 'a', type: 'tool', label: 'x', status: 'weird', dependsOn: [] }],
      },
    ]) {
      expect(codeOf(() => checkStoredExecution(broken as never))).toBe('invalid_execution');
    }
  });
});

describe('specialist assignment (ADR-0025)', () => {
  const assigned = {
    specialistId: 'spec-1',
    specialistVersion: 4,
    departmentId: `${ORG}_research`,
  };

  it('records specialist, version and department together, matching the snapshot', () => {
    const execution = newExecution(request(assigned), T0);
    expect(execution).toMatchObject(assigned);
    expect(checkStoredExecution(execution)).toBe(execution);
  });

  it.each([
    ['only a specialist', { specialistId: 'spec-1' }],
    ['no department', { specialistId: 'spec-1', specialistVersion: 4 }],
    ['no version', { specialistId: 'spec-1', departmentId: `${ORG}_research` }],
    ['a version that is not a positive integer', { ...assigned, specialistVersion: 1.5 }],
    ['a version the snapshot does not record', { ...assigned, specialistVersion: 3 }],
    ['a specialist the snapshot does not record', { ...assigned, specialistId: 'spec-2' }],
  ])('refuses %s', (_name, extra) => {
    expect(codeOf(() => newExecution(request(extra as Partial<NewExecution>), T0))).toBe(
      'invalid_execution',
    );
  });

  it('refuses a stored execution whose assignment disagrees with its snapshot', () => {
    const execution = newExecution(request(assigned), T0);
    expect(codeOf(() => checkStoredExecution({ ...execution, specialistVersion: 9 }))).toBe(
      'invalid_execution',
    );
    const partial = { ...execution } as Record<string, unknown>;
    delete partial.departmentId;
    expect(codeOf(() => checkStoredExecution(partial as unknown as Execution))).toBe(
      'invalid_execution',
    );
  });
});

describe('idempotent execution ids', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333' as OrganizationId;

  it('gives one key in one organization always the same id', () => {
    const a = newExecution(request({ idempotencyKey: 'plan:p1:step:research' }), T0);
    const b = newExecution(request({ idempotencyKey: 'plan:p1:step:research' }), T1);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(executionIdFor(ORG, 'plan:p1:step:research'));
    expect(isExecutionId(a.id)).toBe(true);
    expect(a.id[14]).toBe('8');
  });

  it('gives another key or another organization another id', () => {
    const id = executionIdFor(ORG, 'plan:p1:step:research');
    expect(executionIdFor(ORG, 'plan:p1:step:campaign')).not.toBe(id);
    expect(executionIdFor(OTHER, 'plan:p1:step:research')).not.toBe(id);
  });

  it('keeps random ids without a key', () => {
    expect(newExecution(request(), T0).id).not.toBe(newExecution(request(), T0).id);
  });

  it.each(['', 'has space', 'x'.repeat(201), 'slash/no'])('refuses the key %j', (key) => {
    expect(codeOf(() => newExecution(request({ idempotencyKey: key }), T0))).toBe(
      'invalid_execution',
    );
  });
});

describe('company context (ADR-0029)', () => {
  it('lets an execution carry one Company Context version, never two', () => {
    const one = {
      schemaVersion: 1,
      components: [
        ...SNAPSHOT.components,
        { kind: 'company_context', id: 'ctx-acme', version: '3' },
      ],
    };
    expect(checkSnapshot(one).components.at(-1)).toEqual({
      kind: 'company_context',
      id: 'ctx-acme',
      version: '3',
    });
    const two = {
      ...one,
      components: [...one.components, { kind: 'company_context', id: 'ctx-other', version: '1' }],
    };
    expect(codeOf(() => checkSnapshot(two))).toBe('invalid_execution');
  });
});
