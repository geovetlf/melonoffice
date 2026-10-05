import { describe, expect, it } from 'vitest';
import type { ToolView } from '../agents/agentsClient.js';
import type { WorkflowAgentDraft, WorkflowStepDraft } from './automationsClient.js';
import {
  sourcesFor,
  tidy,
  toolAvailability,
  toolChoicesOf,
  toolStepComplete,
} from './toolSteps.js';

/** Tool steps in the workflow editor (ADR-0165): only what a plan would accept is offered. */

const version = (
  n: number,
  riskLevel: string,
  step: NonNullable<ToolView['versions'][number]['step']> | null,
) => ({
  version: n,
  nameKey: 'n',
  descriptionKey: 'd',
  category: 'c',
  action: 'read',
  mutating: false,
  riskLevel,
  approvalPolicy: 'auto',
  environments: ['dev'],
  step,
});

const TOOLS: ToolView[] = [
  {
    id: 'count_lookup',
    status: 'active',
    versions: [
      version(1, 'low', {
        input: [],
        output: [
          { name: 'count', type: 'integer', required: true },
          { name: 'topic', type: 'string', required: true, maxLength: 50 },
          { name: 'names', type: 'array', required: true },
        ],
      }),
    ],
  },
  {
    id: 'ranked_lookup',
    status: 'active',
    versions: [
      version(1, 'medium', {
        input: [
          { name: 'topic', type: 'string', required: true, maxLength: 50 },
          { name: 'size', type: 'number', required: false },
        ],
        output: [],
      }),
    ],
  },
  // Not offered: a version a plan may not run, a list input the editor cannot fill, a paused tool.
  { id: 'send', status: 'active', versions: [version(1, 'low', null)] },
  {
    id: 'bulk',
    status: 'active',
    versions: [
      version(1, 'low', { input: [{ name: 'ids', type: 'array', required: true }], output: [] }),
    ],
  },
  {
    id: 'paused',
    status: 'paused',
    versions: [version(1, 'low', { input: [], output: [] })],
  },
];

const agent = (key: string, after: string[] = []): WorkflowStepDraft => ({
  kind: 'agent',
  key,
  label: key,
  after,
  departmentTypeId: 'sales',
  roleId: 'commercial_agent',
  approvalRequired: false,
});
const tool = (
  key: string,
  performer: string,
  toolId: string,
  values: Extract<WorkflowStepDraft, { kind: 'tool' }>['values'] = {},
): WorkflowStepDraft => ({
  kind: 'tool',
  key,
  label: key,
  after: [performer],
  performer,
  toolId,
  toolVersion: 1,
  values,
});

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

describe('tool steps in the workflow editor (ADR-0165)', () => {
  const choices = toolChoicesOf(TOOLS);

  it('offers only active tools a plan may run whose input the editor can fill', () => {
    expect(choices.map((c) => c.id)).toEqual(['count_lookup', 'ranked_lookup']);
  });

  it('offers results of the same type from another agent’s earlier tool step, and no answer to a riskier tool', () => {
    const steps = [
      agent('a'),
      tool('count', 'a', 'count_lookup'),
      agent('b', ['a']),
      tool('rank', 'b', 'ranked_lookup'),
    ];
    const ranked = must(choices[1]);
    const sources = (name: string) =>
      sourcesFor(steps, 3, ranked, must(ranked.input.find((f) => f.name === name)), choices).map(
        (s) => s.value,
      );
    // An agent's answer is model text: never for a medium-risk tool.
    expect(sources('topic')).toEqual([{ from: 'result', step: 'count', field: 'topic' }]);
    // An integer fills a number; a list never fills a plain value.
    expect(sources('size')).toEqual([{ from: 'result', step: 'count', field: 'count' }]);
  });

  it('drops what a move or removal leaves invalid', () => {
    const steps = [
      agent('a'),
      tool('count', 'a', 'count_lookup'),
      agent('b', ['a', 'count']),
      tool('rank', 'b', 'ranked_lookup', {
        topic: { from: 'result', step: 'count', field: 'topic' },
        size: { from: 'fixed', value: 3 },
      }),
    ];
    const tidied = tidy(steps, choices);
    // Nothing waits for a tool step.
    expect(tidied[2]?.after).toEqual(['a']);
    expect(tidied[3]).toMatchObject({ values: { topic: { from: 'result' } } });
    // Without the first agent step, the tool step after it loses it, and the reference goes.
    const without = tidy(steps.slice(1), choices);
    expect(without[0]).toMatchObject({ performer: '', after: [] });
    expect(without[2]).toMatchObject({ values: { size: { from: 'fixed', value: 3 } } });
    expect(toolStepComplete(without[2] as never, choices)).toBe(false);
  });
});

describe('toolAvailability (ADR-0167)', () => {
  const search = { id: 'knowledge_search', version: 1 };
  const lucia = { id: 'agent-sales', displayName: 'Lucía' };
  const assignee = (tools: { id: string; version: number }[]) => ({
    departmentTypeId: 'sales',
    roleId: 'commercial_agent',
    agent: lucia,
    tools,
  });
  const steps = [agent('a'), tool('t', 'a', 'knowledge_search')];

  it('is available only when the agent the plan would pick lists that exact version', () => {
    expect(toolAvailability(steps, 'a', search, [assignee([search])])).toEqual({
      ok: true,
      agent: lucia,
    });
    expect(
      toolAvailability(steps, 'a', search, [assignee([{ id: 'knowledge_search', version: 2 }])]),
    ).toEqual({ ok: false, why: 'not_granted', agent: lucia });
  });

  it('says why when there is no agent step, no agent for its role, or nothing could be read', () => {
    expect(toolAvailability(steps, 'missing', search, [assignee([search])])).toEqual({
      ok: false,
      why: 'no_performer',
    });
    expect(
      toolAvailability([{ ...(agent('a') as WorkflowAgentDraft), roleId: '' }], 'a', search, []),
    ).toEqual({
      ok: false,
      why: 'no_performer',
    });
    expect(toolAvailability(steps, 'a', search, [])).toEqual({ ok: false, why: 'no_agent' });
    expect(toolAvailability(steps, 'a', search, undefined)).toEqual({ ok: false, why: 'unknown' });
  });
});
