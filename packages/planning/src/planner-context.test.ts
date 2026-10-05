import { describe, expect, it } from 'vitest';
import {
  AGENT_STEP_VERIFICATION,
  MAX_PLANNER_MESSAGE,
  PLANNER_INSTRUCTIONS,
  plannerMessages,
  plannerToolOf,
  planningAnswerOf,
} from './planner-context.js';

/** The planner's context and answers (plan_proposal@2, ADR-0171). */

describe('the planner context (ADR-0171)', () => {
  const resolved = {
    definition: { id: 'lookup' },
    version: {
      action: 'search',
      mutating: false,
      riskLevel: 'low',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'object', properties: {} },
    },
  } as never;

  it('describes a tool as the validator judges it, with its schemas only when it is a step', () => {
    expect(
      plannerToolOf({ id: 'lookup', version: 1 }, resolved, {
        usable: true,
        riskLevel: 'low',
        approvalRequired: true,
      }),
    ).toEqual({
      id: 'lookup',
      version: 1,
      action: 'search',
      changesData: false,
      riskLevel: 'low',
      usableAsStep: true,
      approvalRequired: true,
      // A person approves the exact input: it is never read later.
      inputFromAllowed: false,
      input: { type: 'object', properties: { query: { type: 'string' } } },
      output: { type: 'object', properties: {} },
    });
    expect(
      plannerToolOf({ id: 'lookup', version: 1 }, resolved, {
        usable: false,
        reason: 'tool_not_read_only',
      }),
    ).toEqual({
      id: 'lookup',
      version: 1,
      action: 'search',
      changesData: false,
      riskLevel: 'low',
      usableAsStep: false,
      notUsableBecause: 'tool_not_read_only',
    });
    // A tool the registry does not know is taken to change data.
    expect(
      plannerToolOf({ id: 'ghost', version: 1 }, undefined, {
        usable: false,
        reason: 'tool_not_found',
      }),
    ).toMatchObject({ changesData: true, usableAsStep: false });
  });

  it('sends the instructions, the context as data and the request, and checks only when listed', () => {
    const agents = [{ specialistId: 's1', departmentType: 'sales', roleId: 'r', tools: [] }];
    const [system, user] = plannerMessages({ agents }, 'Haz algo');
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_INSTRUCTIONS });
    expect(system?.content[1]).toEqual({ type: 'text', text: JSON.stringify({ agents }) });
    expect(user?.content).toEqual([{ type: 'text', text: 'Haz algo' }]);
    const checked = plannerMessages({ agents, checkActions: ['discount'] }, 'x')[0]?.content[1];
    expect(checked).toEqual({
      type: 'text',
      text: JSON.stringify({ agents, checkActions: ['discount'] }),
    });
    // Only the kinds the engine runs.
    expect(PLANNER_INSTRUCTIONS).toContain('There are no approval, verification or parallel steps');
  });
});

describe('reading the planner answer (ADR-0171)', () => {
  it('reads a plan, and gives every agent step the one way agent work is checked', () => {
    const read = planningAnswerOf({
      structured: {
        summary: 'S',
        objective: 'O',
        steps: [
          { id: 'a', kind: 'specialist', label: 'A', dependsOn: [], specialistId: 'x' },
          {
            id: 'b',
            kind: 'specialist',
            label: 'B',
            dependsOn: [],
            specialistId: 'x',
            verification: { policy: 'human_review', expectedOutput: 'whatever' },
          },
          { id: 'w', kind: 'wait', label: 'W', dependsOn: ['a'], wait: { seconds: 60 } },
        ],
      },
    });
    if (read.kind !== 'proposal') throw new Error(read.kind);
    const steps = read.proposal.steps as Record<string, unknown>[];
    expect(steps[0]?.verification).toEqual(AGENT_STEP_VERIFICATION);
    expect(steps[1]?.verification).toEqual(AGENT_STEP_VERIFICATION);
    expect(steps[2]).not.toHaveProperty('verification');
  });

  it('reads a question or a "cannot be done", from structured output or JSON text', () => {
    expect(planningAnswerOf({ structured: { question: ' ¿Qué cliente? ' } })).toEqual({
      kind: 'question',
      text: '¿Qué cliente?',
    });
    expect(planningAnswerOf({ text: '```json\n{"notPossible":"No email tool."}\n```' })).toEqual({
      kind: 'not_possible',
      text: 'No email tool.',
    });
    const long = planningAnswerOf({ structured: { question: 'x'.repeat(2_000) } });
    expect(long.kind === 'question' && long.text.length).toBe(MAX_PLANNER_MESSAGE);
    // A plan with steps wins over a stray question, which is dropped.
    const both = planningAnswerOf({
      structured: { summary: 'S', objective: 'O', question: '?', steps: [{ kind: 'wait' }] },
    });
    expect(both.kind === 'proposal' && both.proposal).not.toHaveProperty('question');
  });

  it('cannot read prose, an empty answer or a list', () => {
    expect(planningAnswerOf({ text: 'Sure! Here is the plan.' })).toEqual({ kind: 'unreadable' });
    expect(planningAnswerOf(undefined)).toEqual({ kind: 'unreadable' });
    expect(planningAnswerOf({ structured: [] as never })).toEqual({ kind: 'unreadable' });
    expect(planningAnswerOf({ structured: { summary: 'S' } })).toEqual({ kind: 'unreadable' });
  });
});
