import { describe, expect, it } from 'vitest';
import type { PlannerAgentView, PlannerToolView } from './planner-context.js';
import { planningAnswerOf } from './planner-context.js';
import { checkProposal } from './proposal.js';
import { resolveToolSteps } from './tool-steps.js';
import { checkStepStructure } from './validate.js';

/** Reading a planner's tool steps (ADR-0173): agent → the agent's step → tool, or left as is. */

const SALES = '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0001';
const MARKETING = '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0002';
const RESEARCH = '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0003';
const FINANCE = '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0004';
const SALES_2 = '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0005';

const tool = (id: string, version = 1): PlannerToolView => ({
  id,
  version,
  action: 'read',
  changesData: false,
  riskLevel: 'low',
  usableAsStep: true,
});
const agent = (
  specialistId: string,
  departmentType: string,
  tools: PlannerToolView[] = [],
): PlannerAgentView => ({ specialistId, departmentType, roleId: `${departmentType}_agent`, tools });

const OFFICE: readonly PlannerAgentView[] = [
  agent(SALES, 'sales', [tool('knowledge_search'), tool('customer_records_summary')]),
  agent(MARKETING, 'marketing', [tool('knowledge_search')]),
  agent(RESEARCH, 'research'),
  agent(FINANCE, 'finance'),
];

const specialist = (id: string, who: string, dependsOn: string[] = []) => ({
  id,
  kind: 'specialist',
  label: id,
  dependsOn,
  specialistId: who,
});
const toolStep = (
  id: string,
  performedBy: string | undefined,
  ref: string,
  dependsOn: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind: 'tool',
  label: id,
  dependsOn,
  ...(performedBy === undefined ? {} : { performedBy }),
  tool: { id: ref, version: 1 },
  input: ref === 'knowledge_search' ? { query: 'política de descuentos' } : {},
  ...extra,
});
const plan = (steps: unknown[]) => ({ summary: 'S', objective: 'O', steps });

type Steps = { id: string; dependsOn: string[]; performedBy?: string; inputFrom?: unknown }[];
const stepsOf = (p: Readonly<Record<string, unknown>>) => p.steps as Steps;
const byId = (p: Readonly<Record<string, unknown>>, id: string) =>
  stepsOf(p).find((s) => s.id === id);

/** The schema and the structure the plan stage checks, as the validator would run them. */
function structure(p: Readonly<Record<string, unknown>>) {
  const checked = checkProposal(p);
  if (!checked.ok) return `${checked.reason}:${checked.detail}`;
  const s = checkStepStructure(checked.proposal.steps);
  return s.ok ? 'ok' : s.reason;
}

describe('resolving tool steps to their agent’s step (ADR-0173)', () => {
  it('p02: a tool first, performed by the agent’s specialistId, becomes part of its step', () => {
    const answer = plan([
      toolStep('buscar_politica', SALES, 'knowledge_search'),
      specialist('redactar_propuesta', SALES, ['buscar_politica']),
    ]);
    expect(structure(answer)).toBe('invalid_proposal:steps.0.performedBy');
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['buscar_politica->redactar_propuesta']);
    expect(read.unresolved).toEqual([]);
    expect(stepsOf(read.proposal).map((s) => s.id)).toEqual([
      'redactar_propuesta',
      'buscar_politica',
    ]);
    expect(byId(read.proposal, 'buscar_politica')).toMatchObject({
      performedBy: 'redactar_propuesta',
      dependsOn: ['redactar_propuesta'],
      input: { query: 'política de descuentos' },
    });
    expect(byId(read.proposal, 'redactar_propuesta')?.dependsOn).toEqual([]);
    expect(structure(read.proposal)).toBe('ok');
    // The model's answer itself is never changed.
    expect(answer.steps[0]).toMatchObject({ performedBy: SALES });
  });

  it('p14: a tool performed by the agent’s department, and later work waiting on it', () => {
    const answer = plan([
      toolStep('get_sales_data', 'sales', 'customer_records_summary'),
      specialist('analyze_sales', SALES, ['get_sales_data']),
      specialist('plan_win_back', MARKETING, ['analyze_sales', 'get_sales_data']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['get_sales_data->analyze_sales']);
    // Work that waited on the tool waits on the step that ends with it.
    expect(byId(read.proposal, 'plan_win_back')?.dependsOn).toEqual(['analyze_sales']);
    expect(structure(read.proposal)).toBe('ok');
  });

  it('leaves a plan that already names its steps exactly as it is', () => {
    const answer = plan([
      specialist('draft', SALES),
      toolStep('search', 'draft', 'knowledge_search', ['draft']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.proposal).toBe(answer);
    expect(read).toMatchObject({ resolved: [], unresolved: [] });
  });

  it('p12: the agent’s own step, named as performer, waiting on its own tool, ends with it', () => {
    // p12 as plan_proposal@5 answered it: performedBy right, the dependency backwards.
    const answer = plan([
      specialist('research', RESEARCH),
      toolStep('get_customer_data', 'prepare_follow_up', 'customer_records_summary', ['research']),
      { ...specialist('prepare_follow_up', SALES, ['get_customer_data']), approvalRequired: true },
    ]);
    expect(structure(answer)).toBe('invalid_tool_dependency');
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['get_customer_data->prepare_follow_up']);
    expect(read.unresolved).toEqual([]);
    // Nothing invented or removed; the step keeps its approval and waits on what the tool did.
    expect(stepsOf(read.proposal).map((s) => s.id)).toEqual([
      'research',
      'prepare_follow_up',
      'get_customer_data',
    ]);
    expect(byId(read.proposal, 'prepare_follow_up')).toMatchObject({
      dependsOn: ['research'],
      approvalRequired: true,
    });
    expect(byId(read.proposal, 'get_customer_data')).toMatchObject({
      dependsOn: ['prepare_follow_up'],
      performedBy: 'prepare_follow_up',
    });
    expect(structure(read.proposal)).toBe('ok');
  });

  it('p12: later work waiting on a tool already in its agent’s step waits on that step', () => {
    const answer = plan([
      specialist('prepare', SALES),
      toolStep('counts', 'prepare', 'customer_records_summary', ['prepare']),
      specialist('campaign', MARKETING, ['counts', 'prepare']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['counts->prepare']);
    expect(byId(read.proposal, 'campaign')?.dependsOn).toEqual(['prepare']);
    expect(byId(read.proposal, 'counts')?.dependsOn).toEqual(['prepare']);
    expect(structure(read.proposal)).toBe('ok');
  });

  it('p12: keeps inputFrom, and the tool’s earlier tool of the same step, as they were', () => {
    const answer = plan([
      specialist('research', RESEARCH),
      toolStep('first', 'prepare', 'knowledge_search', [], {}),
      toolStep('counts', 'prepare', 'customer_records_summary', ['first'], {
        inputFrom: { segment: { step: 'research' } },
      }),
      specialist('prepare', SALES, ['research', 'first', 'counts']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['first->prepare', 'counts->prepare']);
    expect(byId(read.proposal, 'prepare')?.dependsOn).toEqual(['research']);
    expect(byId(read.proposal, 'counts')).toMatchObject({
      dependsOn: ['prepare', 'first'],
      inputFrom: { segment: { step: 'research' } },
    });
    expect(byId(read.proposal, 'first')?.dependsOn).toEqual(['prepare']);
    expect(structure(read.proposal)).toBe('ok');
  });

  it('p12: never guesses: a step whose agent lacks the tool, or is unknown, stays refused', () => {
    const notHeld = plan([
      toolStep('counts', 'estimate', 'customer_records_summary'),
      specialist('estimate', FINANCE, ['counts']),
    ]);
    const read = resolveToolSteps(notHeld, OFFICE);
    expect(read.proposal).toBe(notHeld);
    expect(read).toMatchObject({ resolved: [], unresolved: ['counts:tool_not_held'] });
    expect(structure(read.proposal)).toBe('invalid_dependency');

    const stranger = '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0099';
    const unknown = plan([
      toolStep('counts', 'estimate', 'customer_records_summary'),
      specialist('estimate', stranger, ['counts']),
    ]);
    expect(resolveToolSteps(unknown, OFFICE)).toMatchObject({
      proposal: unknown,
      resolved: [],
      unresolved: ['counts:unknown_performer'],
    });
  });

  it('never guesses: an agent named twice, or by nothing it knows, is left for the validator', () => {
    const twoSales = [...OFFICE, agent(SALES_2, 'sales', [tool('knowledge_search')])];
    const byDepartment = plan([
      toolStep('search', 'sales', 'knowledge_search'),
      specialist('draft', SALES, ['search']),
    ]);
    const ambiguous = resolveToolSteps(byDepartment, twoSales);
    expect(ambiguous.unresolved).toEqual(['search:ambiguous_agent']);
    expect(ambiguous.proposal).toBe(byDepartment);
    const unknown = resolveToolSteps(
      plan([toolStep('search', 'legal', 'knowledge_search'), specialist('draft', SALES)]),
      OFFICE,
    );
    expect(unknown.unresolved).toEqual(['search:unknown_performer']);
    // With no reference, the one agent in the plan holding the tool; two of them, nothing.
    const none = plan([
      toolStep('search', undefined, 'knowledge_search'),
      specialist('draft', SALES, ['search']),
    ]);
    expect(resolveToolSteps(none, OFFICE).resolved).toEqual(['search->draft']);
    const both = plan([
      toolStep('search', undefined, 'knowledge_search'),
      specialist('draft', SALES, ['search']),
      specialist('campaign', MARKETING, ['search']),
    ]);
    expect(resolveToolSteps(both, OFFICE).unresolved).toEqual(['search:ambiguous_agent']);
  });

  it('never invents a step or a tool: no agent step, or an agent without the tool, stays refused', () => {
    const noStep = plan([
      toolStep('counts', SALES, 'customer_records_summary'),
      specialist('campaign', MARKETING, ['counts']),
    ]);
    const read = resolveToolSteps(noStep, OFFICE);
    expect(read.unresolved).toEqual(['counts:no_agent_step']);
    expect(stepsOf(read.proposal)).toHaveLength(2);
    const notHeld = resolveToolSteps(
      plan([
        toolStep('counts', 'marketing', 'customer_records_summary'),
        specialist('campaign', MARKETING, ['counts']),
      ]),
      OFFICE,
    );
    expect(notHeld.unresolved).toEqual(['counts:tool_not_held']);
    expect(structure(notHeld.proposal)).not.toBe('ok');
  });

  it('with several steps of one agent, takes the one tied to the tool or none', () => {
    const tied = plan([
      specialist('intro', SALES),
      toolStep('search', SALES, 'knowledge_search'),
      specialist('draft', SALES, ['intro', 'search']),
    ]);
    const read = resolveToolSteps(tied, OFFICE);
    expect(read.resolved).toEqual(['search->draft']);
    expect(byId(read.proposal, 'draft')?.dependsOn).toEqual(['intro']);
    expect(structure(read.proposal)).toBe('ok');
    const loose = plan([
      specialist('intro', SALES),
      toolStep('search', SALES, 'knowledge_search'),
      specialist('draft', SALES, ['intro']),
    ]);
    expect(resolveToolSteps(loose, OFFICE).unresolved).toEqual(['search:ambiguous_step']);
  });

  it('keeps every dependency and inputFrom: what the tool waited on, its agent’s step waits on', () => {
    const answer = plan([
      specialist('brief', RESEARCH),
      specialist('costs', FINANCE),
      toolStep('search', SALES, 'knowledge_search', ['brief', 'costs'], {
        input: {},
        inputFrom: { query: { step: 'brief' } },
      }),
      specialist('draft', SALES, ['search']),
      specialist('campaign', MARKETING, ['draft', 'search']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['search->draft']);
    expect(byId(read.proposal, 'draft')?.dependsOn).toEqual(['brief', 'costs']);
    expect(byId(read.proposal, 'search')).toMatchObject({
      dependsOn: ['draft'],
      inputFrom: { query: { step: 'brief' } },
    });
    expect(byId(read.proposal, 'campaign')?.dependsOn).toEqual(['draft']);
    // The reference still reads a result that comes first.
    expect(structure(read.proposal)).toBe('ok');
  });

  it('waits on another agent’s tool through that agent’s own step', () => {
    const answer = plan([
      specialist('market', MARKETING),
      toolStep('m_search', 'market', 'knowledge_search', ['market']),
      toolStep('s_search', SALES, 'knowledge_search', ['m_search']),
      specialist('draft', SALES, ['s_search']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['s_search->draft']);
    expect(byId(read.proposal, 'draft')?.dependsOn).toEqual(['market']);
    expect(structure(read.proposal)).toBe('ok');
  });

  it('does not hide a cycle: the plan stage still refuses it', () => {
    const answer = plan([
      toolStep('search', SALES, 'knowledge_search', ['review']),
      specialist('draft', SALES, ['search']),
      specialist('review', MARKETING, ['draft']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['search->draft']);
    expect(structure(read.proposal)).toBe('plan_cycle');
  });

  it('several agents, one tool each: each tool goes to its own agent’s step', () => {
    const answer = plan([
      specialist('research', RESEARCH),
      toolStep('counts', 'sales', 'customer_records_summary'),
      specialist('prioritize', SALES, ['research', 'counts']),
      toolStep('ideas', MARKETING, 'knowledge_search'),
      specialist('campaign', MARKETING, ['prioritize', 'ideas']),
    ]);
    const read = resolveToolSteps(answer, OFFICE);
    expect(read.resolved).toEqual(['counts->prioritize', 'ideas->campaign']);
    expect(stepsOf(read.proposal).map((s) => s.id)).toEqual([
      'research',
      'prioritize',
      'counts',
      'campaign',
      'ideas',
    ]);
    expect(structure(read.proposal)).toBe('ok');
  });

  it('leaves malformed answers to the schema stage', () => {
    const duplicate = plan([specialist('a', SALES), specialist('a', SALES)]);
    expect(resolveToolSteps(duplicate, OFFICE).proposal).toBe(duplicate);
    const badDeps = plan([{ ...specialist('a', SALES), dependsOn: 'x' }]);
    expect(resolveToolSteps(badDeps, OFFICE).proposal).toBe(badDeps);
  });

  it('is what the product reads when it knows the agents, and nothing more without them', () => {
    const answer = plan([
      toolStep('search', SALES, 'knowledge_search'),
      specialist('draft', SALES, ['search']),
    ]);
    const withAgents = planningAnswerOf({ structured: answer }, OFFICE);
    expect(withAgents).toMatchObject({
      kind: 'proposal',
      toolSteps: { resolved: ['search->draft'], unresolved: [] },
    });
    const without = planningAnswerOf({ structured: answer });
    expect(without).not.toHaveProperty('toolSteps');
    if (without.kind !== 'proposal') throw new Error(without.kind);
    expect((without.proposal.steps as { performedBy?: string }[])[0]?.performedBy).toBe(SALES);
  });
});
