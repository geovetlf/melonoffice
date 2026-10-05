import {
  createProviderRegistry,
  type AIOutput,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import type { AIModelDefinition, AIProviderDefinition } from '@melonoffice/domain';
import { PLANNER_INSTRUCTIONS, PLANNER_MAX_OUTPUT_TOKENS } from '@melonoffice/planning';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareRuns } from './compare.js';
import { evalTaskPolicy } from './dev.js';
import {
  PLANNER_EVAL,
  PLANNER_EVAL_AGENTS,
  PLANNER_EVAL_CANDIDATES,
  PLANNER_V1_EVAL,
  PLANNER_V1_INSTRUCTIONS,
  PLANNER_V2_EVAL,
  PLANNER_V2_INSTRUCTIONS,
  PLANNER_V3_EVAL,
  PLANNER_V3_INSTRUCTIONS,
  PLANNER_V4_EVAL,
  PLANNER_V4_INSTRUCTIONS,
  PLANNER_V5_EVAL,
  PLANNER_V5_INSTRUCTIONS,
  PLANNER_V6_EVAL,
  PLANNER_V6_INSTRUCTIONS,
  PLANNER_V7_EVAL,
  PLANNER_V7_INSTRUCTIONS,
  plannerRefusalOf,
  PLANNER_EVAL_CASES,
  keptPlan,
  languageOf,
  plannerBreakdown,
  plannerComparisonText,
  scorePlannerAnswer,
  type PlannerEvalCase,
} from './planner.js';
import { runEvals } from './run.js';

/**
 * The planner's evals (Block 3 F1, ADR-0169): the cases, the scoring of good and bad plans by the
 * plan pipeline itself, and a run against a scripted model (no real model in CI).
 */

const find = (id: string): PlannerEvalCase => {
  const c = PLANNER_EVAL_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(id);
  return c;
};

const [SALES, MARKETING, RESEARCH, FINANCE] = PLANNER_EVAL_CANDIDATES.map((s) => s.specialistId);
const VERIFY = { policy: 'checks', expectedOutput: 'report', requiredChecks: [] };

type Step = Record<string, unknown>;
const agent = (id: string, who: string | undefined, label: string, dependsOn: string[] = []) => ({
  id,
  kind: 'specialist',
  label,
  dependsOn,
  specialistId: who,
  verification: VERIFY,
});
const plan = (summary: string, objective: string, steps: Step[]): AIOutput => ({
  structured: { summary, objective, steps },
});

/** A good plan, or question, for each case: what the planner should answer. */
const GOOD: Readonly<Record<string, AIOutput>> = {
  p01_research_then_campaign: plan(
    'Investigar el mercado y preparar la campaña con lo encontrado',
    'Campaña de jugos naturales en Lima',
    [
      agent('research', RESEARCH, 'Investigar el mercado de los jugos naturales'),
      agent('campaign', MARKETING, 'Preparar la campaña con la investigación', ['research']),
    ],
  ),
  p02_search_company_memory: plan(
    'Buscar la política de descuentos y redactar la propuesta para el cliente',
    'Propuesta con la política de descuentos',
    [
      agent('sales', SALES, 'Redactar la propuesta para el cliente'),
      {
        id: 'search',
        kind: 'tool',
        label: 'Buscar la política de descuentos en la memoria',
        dependsOn: ['sales'],
        performedBy: 'sales',
        tool: { id: 'knowledge_search', version: 1 },
        input: { query: 'política de descuentos' },
      },
    ],
  ),
  p03_pipeline_counts: plan(
    'Contar los clientes por etapa del embudo y proponer a cuáles priorizar',
    'Prioridades de la semana',
    [
      agent('sales', SALES, 'Proponer los clientes a priorizar de la semana'),
      {
        id: 'counts',
        kind: 'tool',
        label: 'Contar los clientes de cada etapa del embudo',
        dependsOn: ['sales'],
        performedBy: 'sales',
        tool: { id: 'customer_records_summary', version: 1 },
        input: {},
      },
    ],
  ),
  p04_input_from_earlier_step: plan(
    'Write the query, search the company memory with it and draft the reply',
    'Reply to the customer about the refund policy',
    [
      agent('query', SALES, 'Write a short search query for the refund policy'),
      {
        id: 'search',
        kind: 'tool',
        label: 'Search the company memory with that query',
        dependsOn: ['query'],
        performedBy: 'query',
        tool: { id: 'knowledge_search', version: 1 },
        // Every Harness tool step asks a person first, with its exact input: so it is fixed.
        input: { query: 'refund policy' },
      },
      // Nothing waits on a tool step: the reply waits on the agent whose work used it.
      agent('reply', SALES, 'Draft the reply to the customer', ['query']),
    ],
  ),
  p05_ordered_chain: plan(
    'El presupuesto de finanzas, después la campaña y al final el mensaje de los clientes',
    'Campaña con presupuesto',
    [
      agent('budget', FINANCE, 'Calcular el presupuesto de la campaña'),
      agent('campaign', MARKETING, 'Preparar la campaña con el presupuesto', ['budget']),
      agent('message', SALES, 'Preparar el mensaje para los clientes', ['campaign']),
    ],
  ),
  p06_parallel_then_join: plan(
    'Research the market and estimate the costs, then combine both into the launch plan',
    'Launch plan',
    [
      agent('market', RESEARCH, 'Research the market for the launch'),
      agent('costs', FINANCE, 'Estimate the costs of the launch'),
      agent('launch', MARKETING, 'Combine both into the launch plan', ['market', 'costs']),
    ],
  ),
  p07_review_before_continuing: plan(
    'Preparar la respuesta a la queja para que la revises antes de nada más',
    'Respuesta a la queja de un cliente',
    [
      {
        ...agent('reply', SALES, 'Preparar la respuesta a la queja del cliente'),
        approvalRequired: true,
      },
    ],
  ),
  p08_impossible_es: {
    structured: {
      summary: '¿Quieres que prepare el texto de la oferta? No puedo enviar WhatsApp ni cobrar.',
      objective: 'Oferta por WhatsApp',
      steps: [],
      question: '¿Preparo solo el texto de la oferta para que lo envíes tú?',
    },
  },
  p09_impossible_en: plan(
    'Draft the offer post and the email for the team to send',
    'Share the new offer',
    [agent('draft', MARKETING, 'Draft the post and the email of the offer')],
  ),
  p10_vague_es: {
    structured: {
      summary: '¿Qué quieres que haga?',
      objective: 'Repetir una tarea anterior',
      steps: [],
      question: '¿Qué tarea quieres que repita?',
    },
  },
  p11_vague_en: {
    structured: {
      summary: 'What should be fixed?',
      objective: 'Fix something',
      steps: [],
      question: 'What would you like me to fix?',
    },
  },
  p12_personal_data: plan(
    'Preparar el seguimiento del cliente que pidió los precios de los jugos',
    'Seguimiento de un cliente',
    [agent('follow', SALES, 'Preparar el seguimiento para el cliente de la tienda')],
  ),
  p13_circular_request: plan(
    'Marketing drafts the campaign and then sales reviews it',
    'Campaign with a review',
    [
      agent('draft', MARKETING, 'Draft the campaign'),
      agent('review', SALES, 'Review the campaign from marketing', ['draft']),
    ],
  ),
  p14_english_plan: plan(
    'Analyze the sales of the last month and plan to win back the inactive customers',
    'Win back inactive customers',
    [
      agent('analysis', FINANCE, 'Analyze the sales of the last month'),
      agent('winback', SALES, 'Plan to win back the inactive customers', ['analysis']),
    ],
  ),
  p15_unknown_department: {
    structured: {
      summary: '¿Quién revisa el contrato? No hay un departamento legal en la oficina.',
      objective: 'Revisión del contrato',
      steps: [],
      question: '¿Quieres que ventas prepare el envío cuando el contrato esté revisado?',
    },
  },
  p16_write_tool_with_review: plan(
    'Preparar la lista de los clientes para que la apruebes antes de agendar nada',
    'Seguimientos de la semana',
    [
      {
        ...agent('list', SALES, 'Preparar la lista de los clientes que pidieron precios'),
        approvalRequired: true,
      },
    ],
  ),
};

const good = (id: string): AIOutput => {
  const output = GOOD[id];
  if (output === undefined) throw new Error(id);
  return output;
};
const failed = async (c: PlannerEvalCase, output: AIOutput) =>
  (await scorePlannerAnswer(c, output)).checks.filter((k) => !k.passed).map((k) => k.check);

describe('the planner eval cases (ADR-0169)', () => {
  it('covers the 13 kinds Geovet set, in Spanish and English, with unique ids', () => {
    expect(PLANNER_EVAL_CASES).toHaveLength(16);
    expect(new Set(PLANNER_EVAL_CASES.map((c) => c.id)).size).toBe(16);
    const outcomes = PLANNER_EVAL_CASES.map((c) => c.expect.outcome);
    expect(outcomes.filter((o) => o === 'ask')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'no_invention')).toHaveLength(4);
    const languages = new Set(PLANNER_EVAL_CASES.map((c) => c.expect.language));
    expect(languages).toEqual(new Set(['es', 'en']));
  });

  it('sends the planner its own instructions, the synthetic office and the request', () => {
    const c = find('p01_research_then_campaign');
    const [system, user] = PLANNER_EVAL.messagesOf(c);
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_INSTRUCTIONS });
    expect(system?.content[1]).toEqual({
      type: 'text',
      text: JSON.stringify({ agents: PLANNER_EVAL_AGENTS }),
    });
    expect(user?.content[0]).toEqual({ type: 'text', text: c.request });
    expect(PLANNER_EVAL.prompt).toBe('plan_proposal@3');
  });

  it('ADR-0171: describes each tool as the validator judges it under the Harness’s policy', () => {
    const sales = PLANNER_EVAL_AGENTS.find((a) => a.departmentType === 'sales');
    const search = sales?.tools.find((t) => t.id === 'knowledge_search');
    // Every Harness tool step asks a person first, so its input is never read from a step.
    expect(search).toMatchObject({
      usableAsStep: true,
      changesData: false,
      approvalRequired: true,
      inputFromAllowed: false,
    });
    expect(search?.input).toBeDefined();
    const schedule = sales?.tools.find((t) => t.id === 'follow_up_schedule');
    expect(schedule).toMatchObject({ changesData: true });
    // Research and finance have no tool; no agent is given an id that names an organization.
    expect(PLANNER_EVAL_AGENTS.find((a) => a.departmentType === 'research')?.tools).toEqual([]);
    expect(JSON.stringify(PLANNER_EVAL_AGENTS)).not.toContain('eval_office');
  });

  it('ADR-0171: keeps @1 exactly as it was sent, to measure it again beside @2', () => {
    // The digest pinned for plan_proposal@1 in the API's prompt catalogue (ADR-0133).
    expect(createHash('sha256').update(PLANNER_V1_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      '650c44eda6d62802',
    );
    const c = find('p01_research_then_campaign');
    const [system, user] = PLANNER_V1_EVAL.messagesOf(c);
    expect(system?.content[1]).toEqual({
      type: 'text',
      text: JSON.stringify({ candidates: PLANNER_EVAL_CANDIDATES }),
    });
    expect(user?.content[0]).toEqual({ type: 'text', text: c.request });
    expect(PLANNER_V1_EVAL.prompt).toBe('plan_proposal@1');
    // The same cases, so the two runs compare.
    expect(PLANNER_V1_EVAL.digest(PLANNER_EVAL_CASES)).toBe(
      PLANNER_EVAL.digest(PLANNER_EVAL_CASES),
    );
  });
  it('ADR-0172: keeps @2 exactly as it was sent, with today’s office, to measure it beside @3', () => {
    expect(createHash('sha256').update(PLANNER_V2_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      '659940b67c5a60e5',
    );
    expect(PLANNER_V2_INSTRUCTIONS).not.toBe(PLANNER_INSTRUCTIONS);
    const c = find('p01_research_then_campaign');
    const [system, user] = PLANNER_V2_EVAL.messagesOf(c);
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_V2_INSTRUCTIONS });
    expect(system?.content[1]).toEqual(PLANNER_EVAL.messagesOf(c)[0]?.content[1]);
    expect(user?.content[0]).toEqual({ type: 'text', text: c.request });
    expect(PLANNER_V2_EVAL.prompt).toBe('plan_proposal@2');
    expect(PLANNER_V2_EVAL.digest(PLANNER_EVAL_CASES)).toBe(
      PLANNER_EVAL.digest(PLANNER_EVAL_CASES),
    );
  });

  it('ADR-0172: keeps @3 exactly as it was sent, to measure it beside @4', () => {
    expect(createHash('sha256').update(PLANNER_V3_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      'a38bf376f7de10e2',
    );
    // The planner went back to @3 (ADR-0176): the frozen copy is the text it sends today.
    expect(PLANNER_V3_INSTRUCTIONS).toBe(PLANNER_INSTRUCTIONS);
    const c = find('p01_research_then_campaign');
    const [system] = PLANNER_V3_EVAL.messagesOf(c);
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_V3_INSTRUCTIONS });
    expect(system?.content[1]).toEqual(PLANNER_EVAL.messagesOf(c)[0]?.content[1]);
    expect(PLANNER_V3_EVAL.prompt).toBe('plan_proposal@3');
  });

  it('ADR-0173: keeps @4 exactly as it was sent, to measure it beside @5', () => {
    expect(createHash('sha256').update(PLANNER_V4_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      'd64ba5b98ca1df85',
    );
    expect(PLANNER_V4_INSTRUCTIONS).not.toBe(PLANNER_INSTRUCTIONS);
    const [system] = PLANNER_V4_EVAL.messagesOf(find('p06_parallel_then_join'));
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_V4_INSTRUCTIONS });
    expect(PLANNER_V4_EVAL.prompt).toBe('plan_proposal@4');
  });

  it('ADR-0174: keeps @5 exactly as it was sent, to measure it beside @6', () => {
    expect(createHash('sha256').update(PLANNER_V5_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      '4cef44b0c049977a',
    );
    expect(PLANNER_V5_INSTRUCTIONS).not.toBe(PLANNER_INSTRUCTIONS);
    const [system] = PLANNER_V5_EVAL.messagesOf(find('p06_parallel_then_join'));
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_V5_INSTRUCTIONS });
    expect(PLANNER_V5_EVAL.prompt).toBe('plan_proposal@5');
  });

  it('ADR-0175: keeps @6 exactly as it was sent, to measure it beside @7', () => {
    expect(createHash('sha256').update(PLANNER_V6_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      '9f1941535f91b13b',
    );
    expect(PLANNER_V6_INSTRUCTIONS).not.toBe(PLANNER_INSTRUCTIONS);
    const [system] = PLANNER_V6_EVAL.messagesOf(find('p06_parallel_then_join'));
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_V6_INSTRUCTIONS });
    expect(PLANNER_V6_EVAL.prompt).toBe('plan_proposal@6');
  });

  it('ADR-0176: keeps @7 exactly as it was sent, though the planner went back to @3', () => {
    expect(createHash('sha256').update(PLANNER_V7_INSTRUCTIONS).digest('hex').slice(0, 16)).toBe(
      '10120331ec22967d',
    );
    expect(PLANNER_V7_INSTRUCTIONS).not.toBe(PLANNER_INSTRUCTIONS);
    const [system] = PLANNER_V7_EVAL.messagesOf(find('p06_parallel_then_join'));
    expect(system?.content[0]).toEqual({ type: 'text', text: PLANNER_V7_INSTRUCTIONS });
    expect(PLANNER_V7_EVAL.prompt).toBe('plan_proposal@7');
  });

  it('ADR-0172: the example in the instructions is a plan the validator accepts', async () => {
    const example = PLANNER_INSTRUCTIONS.slice(PLANNER_INSTRUCTIONS.lastIndexOf('{"summary"'));
    const idOf = (type: string) =>
      PLANNER_EVAL_CANDIDATES.find((x) => x.departmentType === type)?.specialistId ?? '';
    const filled = example.replaceAll('<A>', idOf('research')).replaceAll('<B>', idOf('sales'));
    expect(await plannerRefusalOf({ text: filled })).toBeUndefined();
  });

  it('ADR-0172: keeps why a plan was refused, as codes and paths only', async () => {
    const c = find('p02_search_company_memory');
    const plan = good(c.id).structured as { steps: Record<string, unknown>[] };
    // A tool written into an agent step, as @2 often did.
    const inside = {
      ...plan,
      steps: [{ ...plan.steps[0], tool: { id: 'knowledge_search', version: 1 } }],
    };
    expect(await plannerRefusalOf({ structured: inside })).toMatch(/^[a-z_]+\/[a-z_]+/);
    expect(await PLANNER_EVAL.keep(c, { structured: inside })).toMatch(/^refused: /);
    const unknownKey = { ...plan, steps: [{ ...plan.steps[0], note: 'x' }] };
    expect(await plannerRefusalOf({ structured: unknownKey })).toBe(
      'invalid_proposal:steps.0.note',
    );
    expect(await plannerRefusalOf(good(c.id))).toBeUndefined();
    expect(await plannerRefusalOf({ structured: { question: '¿Qué?' } })).toBeUndefined();
  });
});

describe('scoring a planner answer (ADR-0169)', () => {
  it('ADR-0173: reads a tool written before its agent’s work as the product does (p02, p14)', async () => {
    // As @3 and @4 answered p02 and p14 in the real runs: the tool first, naming the agent.
    const p02 = plan('Buscar la política de descuentos y redactar la propuesta', 'Propuesta', [
      {
        id: 'buscar_politica',
        kind: 'tool',
        label: 'Buscar la política de descuentos',
        dependsOn: [],
        performedBy: SALES,
        tool: { id: 'knowledge_search', version: 1 },
        input: { query: 'política de descuentos' },
      },
      agent('redactar_propuesta', SALES, 'Redactar la propuesta para el cliente', [
        'buscar_politica',
      ]),
    ]);
    expect(await failed(find('p02_search_company_memory'), p02)).toEqual([]);
    expect(await PLANNER_EVAL.keep(find('p02_search_company_memory'), p02)).toMatch(
      /^tool steps: buscar_politica->redactar_propuesta \| /,
    );
    const p14 = plan('Analyze sales and plan to win back inactive customers', 'Win back', [
      {
        id: 'get_sales_data',
        kind: 'tool',
        label: 'Get the customer and pipeline figures',
        dependsOn: [],
        performedBy: 'sales',
        tool: { id: 'customer_records_summary', version: 1 },
        input: {},
      },
      agent('analyze_sales', SALES, 'Analyze the sales of the last month', ['get_sales_data']),
      agent('plan_win_back', MARKETING, 'Plan how to win back inactive customers', [
        'analyze_sales',
      ]),
    ]);
    expect(await failed(find('p14_english_plan'), p14)).toEqual([]);
    // A reference it cannot resolve is still refused, by the validator.
    const [first, second] = (p02.structured as { steps: Step[] }).steps;
    const unknown = plan('Buscar y redactar', 'Propuesta', [
      { ...first, performedBy: 'legal' },
      second as Step,
    ]);
    expect(await failed(find('p02_search_company_memory'), unknown)).toContain('valid_plan');
    // The run keeps what the model named, so nobody has to guess it (ADR-0175).
    expect(await PLANNER_EVAL.keep(find('p02_search_company_memory'), unknown)).toMatch(
      /tool steps: buscar_politica:unknown_performer="legal" \| /,
    );
    // The role of exactly one agent names it too (ADR-0175).
    const byRole = plan('Buscar y redactar', 'Propuesta', [
      { ...first, performedBy: 'commercial_agent' },
      second as Step,
    ]);
    expect(await failed(find('p02_search_company_memory'), byRole)).toEqual([]);
  });

  it('passes a good answer to every case', async () => {
    for (const c of PLANNER_EVAL_CASES) {
      expect([c.id, await failed(c, good(c.id))]).toEqual([c.id, []]);
    }
  });

  it('reads a plan sent as JSON text, with or without a code fence', async () => {
    const c = find('p01_research_then_campaign');
    const json = JSON.stringify(good(c.id).structured);
    expect(await failed(c, { text: json })).toEqual([]);
    expect(await failed(c, { text: `\`\`\`json\n${json}\n\`\`\`` })).toEqual([]);
    expect(await failed(c, { text: 'Sure! Here is the plan.' })).toEqual(['plan_shape']);
  });

  it('fails a step kind no plan runs, as the conductor would', async () => {
    const c = find('p07_review_before_continuing');
    const answer = plan('Preparar la respuesta y revisarla', 'Respuesta', [
      agent('reply', SALES, 'Preparar la respuesta a la queja'),
      { id: 'review', kind: 'approval', label: 'Revisar la respuesta', dependsOn: ['reply'] },
    ]);
    expect(await failed(c, answer)).toEqual(
      expect.arrayContaining(['runnable_kinds', 'valid_plan', 'approval']),
    );
  });

  it('fails an agent that is not a candidate, and a tool its agent does not list', async () => {
    const c = find('p02_search_company_memory');
    const ghost = plan('Redactar la propuesta del cliente', 'Propuesta', [
      agent('sales', '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0099', 'Redactar la propuesta'),
    ]);
    expect(await failed(c, ghost)).toEqual(
      expect.arrayContaining(['valid_roles', 'valid_plan', 'uses_tool']),
    );
    const borrowed = plan('Buscar la política y redactar la propuesta', 'Propuesta', [
      agent('research', RESEARCH, 'Buscar la política de descuentos'),
      {
        id: 'search',
        kind: 'tool',
        label: 'Buscar en la memoria de la empresa',
        dependsOn: ['research'],
        performedBy: 'research',
        tool: { id: 'knowledge_search', version: 1 },
        input: { query: 'política de descuentos' },
      },
    ]);
    expect(await failed(c, borrowed)).toEqual(['tools_assigned', 'valid_plan']);
  });

  it('fails a tool no candidate has, and a tool that writes', async () => {
    const c = find('p08_impossible_es');
    const send = plan('Enviar la oferta por WhatsApp', 'Oferta', [
      agent('sales', SALES, 'Preparar la oferta para los clientes'),
      {
        id: 'send',
        kind: 'tool',
        label: 'Enviar el WhatsApp a los clientes',
        dependsOn: ['sales'],
        performedBy: 'sales',
        tool: { id: 'whatsapp_send', version: 1 },
        input: {},
      },
    ]);
    expect(await failed(c, send)).toEqual(
      expect.arrayContaining(['tools_assigned', 'no_invented_tools', 'valid_plan']),
    );
    const schedule = plan('Agendar los seguimientos de la semana', 'Seguimientos', [
      { ...agent('sales', SALES, 'Preparar la lista de los clientes'), approvalRequired: true },
      {
        id: 'schedule',
        kind: 'tool',
        label: 'Agendar el seguimiento de los clientes',
        dependsOn: ['sales'],
        performedBy: 'sales',
        tool: { id: 'follow_up_schedule', version: 2 },
        input: {},
      },
    ]);
    // Sales lists the tool, but no plan takes a tool that writes as a step (D2).
    expect(await failed(find('p16_write_tool_with_review'), schedule)).toEqual(['valid_plan']);
  });

  it('fails bad tool input and a reference to a step that is not earlier', async () => {
    const c = find('p04_input_from_earlier_step');
    const steps = (good(c.id).structured as { steps: Step[] }).steps;
    const withSearch = (search: Step) =>
      plan('Write the query and search the company memory', 'Reply', [
        steps[0] as Step,
        { ...(steps[1] as Step), ...search },
        steps[2] as Step,
      ]);
    const bad = await failed(c, withSearch({ inputFrom: undefined, input: { query: 7 } }));
    expect(bad).toEqual(expect.arrayContaining(['valid_inputs', 'valid_plan']));
    const later = await failed(
      c,
      withSearch({ input: undefined, inputFrom: { query: { step: 'reply' } } }),
    );
    expect(later).toEqual(expect.arrayContaining(['valid_input_refs', 'valid_plan']));
    // Even a reference to an earlier step: a person approves the Harness's tool calls with
    // their exact input, so the input is never read later (ADR-0151, ADR-0161).
    const earlier = await failed(
      c,
      withSearch({ input: undefined, inputFrom: { query: { step: 'query' } } }),
    );
    expect(earlier).toEqual(['valid_input_refs', 'valid_plan']);
  });

  it('fails a cycle, a missing dependency and the wrong order', async () => {
    const c = find('p13_circular_request');
    const cycle = plan('Marketing drafts the campaign and sales reviews it', 'Campaign', [
      agent('draft', MARKETING, 'Draft the campaign', ['review']),
      agent('review', SALES, 'Review the campaign', ['draft']),
    ]);
    expect(await failed(c, cycle)).toEqual(expect.arrayContaining(['no_cycles', 'valid_plan']));
    const missing = plan('Marketing drafts the campaign and sales reviews it', 'Campaign', [
      agent('draft', MARKETING, 'Draft the campaign'),
      agent('review', SALES, 'Review the campaign', ['nowhere']),
    ]);
    expect(await failed(c, missing)).toEqual(
      expect.arrayContaining(['valid_dependencies', 'valid_plan']),
    );
    const p05 = find('p05_ordered_chain');
    const unordered = plan('El presupuesto, la campaña y el mensaje de los clientes', 'Campaña', [
      agent('budget', FINANCE, 'Calcular el presupuesto'),
      agent('campaign', MARKETING, 'Preparar la campaña con el presupuesto'),
      agent('message', SALES, 'Preparar el mensaje para los clientes', ['campaign']),
    ]);
    expect(await failed(p05, unordered)).toEqual(['order']);
  });

  it('fails a missing department, a missing review and a plan in the wrong language', async () => {
    const p06 = find('p06_parallel_then_join');
    const alone = plan('Research the market and plan the launch', 'Launch', [
      agent('market', RESEARCH, 'Research the market for the launch'),
      agent('launch', MARKETING, 'Plan the launch with the research', ['market']),
    ]);
    expect(await failed(p06, alone)).toEqual(['departments', 'order']);
    const p07 = find('p07_review_before_continuing');
    const unreviewed = plan('Preparar la respuesta a la queja del cliente', 'Respuesta', [
      agent('reply', SALES, 'Preparar la respuesta a la queja del cliente'),
    ]);
    expect(await failed(p07, unreviewed)).toEqual(['approval']);
    const p14 = find('p14_english_plan');
    const spanish = plan('Analizar las ventas del mes y recuperar a los clientes', 'Clientes', [
      agent('analysis', FINANCE, 'Analizar las ventas del mes pasado'),
    ]);
    expect(await failed(p14, spanish)).toEqual(['language']);
  });

  it('fails a plan for a vague request, and personal data copied into a plan', async () => {
    const vague = await failed(find('p10_vague_es'), good('p01_research_then_campaign'));
    expect(vague).toEqual(['asks_back']);
    const c = find('p12_personal_data');
    const leaky = plan('Preparar el seguimiento de Juan, al 987-654-321, de la tienda', 'Cliente', [
      agent('follow', SALES, 'Escribir a juan.perez@example.com con los precios'),
    ]);
    expect(await failed(c, leaky)).toEqual(['no_personal_data']);
    // The name alone is not what the case counts: the phone and the email are.
    const named = plan('Preparar el seguimiento de Juan Pérez para su tienda', 'Cliente', [
      agent('follow', SALES, 'Preparar el seguimiento con los precios de los jugos'),
    ]);
    expect(await failed(c, named)).toEqual([]);
  });

  it('ADR-0171: scores a "cannot be done" as no invention, and never as a plan or a question', async () => {
    const cannot: AIOutput = {
      structured: { notPossible: 'No hay herramienta de WhatsApp ni de cobros.' },
    };
    expect(await scorePlannerAnswer(find('p08_impossible_es'), cannot)).toMatchObject({
      passed: true,
      checks: [
        { check: 'says_not_possible', passed: true },
        { check: 'no_invented_tools', passed: true },
      ],
    });
    expect(await failed(find('p01_research_then_campaign'), cannot)).toEqual(['plan_shape']);
    expect(await failed(find('p10_vague_es'), cannot)).toEqual(['asks_back']);
    // @1 had no question form: a summary that asks, with no steps, still counts as one.
    const old: AIOutput = { structured: { summary: '¿Qué tarea?', objective: 'x', steps: [] } };
    expect(await failed(find('p10_vague_es'), old)).toEqual([]);
  });

  it('tells the language of a plan by its commonest words', () => {
    expect(languageOf('Preparar la campaña con los resultados de la investigación')).toBe('es');
    expect(languageOf('Prepare the campaign with the results of the research')).toBe('en');
    expect(languageOf('OK')).toBeUndefined();
  });

  it('keeps the shape of a plan, never its words beyond the summary', () => {
    const kept = keptPlan(good('p04_input_from_earlier_step'));
    expect(kept).toBe(
      'Write the query, search the company memory with it and draft the reply | ' +
        'query:specialist/sales ; search:tool/knowledge_search@1<-query ; ' +
        'reply:specialist/sales<-query',
    );
    expect(keptPlan(good('p11_vague_en'))).toContain('question: What would you like me to fix?');
  });
});

// ---------------------------------------------------------------------------------------------
// A run against a scripted model

const provider = (id: string): AIProviderDefinition => ({
  id,
  name: `Test ${id}`,
  status: 'active',
  access: 'official',
  capabilities: ['text_generation', 'structured_output'],
  modalities: ['text'],
  environments: ['dev'],
  credential: { provider: `${id}_api`, scopes: [] },
  maxSensitivity: 'confidential',
});

const model = (providerId: string): AIModelDefinition => ({
  providerId,
  modelId: `${providerId}-model`,
  version: 'v1',
  status: 'active',
  capabilities: ['text_generation'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  structuredOutput: true,
  toolUse: false,
  streaming: false,
  quality: 'standard',
  latency: 'standard',
  pricing: {
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 100_000,
    outputMicroUsdPerMillionTokens: 400_000,
    source: 'test fixture',
    asOf: '2026-10-05',
  },
  environments: ['dev'],
  maxSensitivity: 'confidential',
  priority: 10,
});

/** A model that answers each case as `script` says, from the case id in the request id. */
const scripted = (
  script: (c: PlannerEvalCase) => AIOutput,
  calls: ProviderCall[],
): ProviderAdapter => ({
  providerId: 'alpha',
  adapterVersion: '1',
  capabilities: () => ['text_generation', 'structured_output'],
  health: async () => 'available',
  generate: async (call): Promise<ProviderOutcome> => {
    calls.push(call);
    return {
      status: 'success',
      output: script(find(call.requestId.replace(/^eval-/, ''))),
      usage: { inputTokens: 1_000, outputTokens: 500 },
      finishReason: 'stop',
    };
  },
});

let tick = 0;
const clock = () => (tick += 100);

describe('running the planner evals (ADR-0169)', () => {
  const runWith = (
    script: (c: PlannerEvalCase) => AIOutput,
    calls: ProviderCall[] = [],
    task = PLANNER_EVAL,
  ) =>
    runEvals(
      {
        cases: PLANNER_EVAL_CASES,
        registry: createProviderRegistry({
          providers: [provider('alpha')],
          models: [model('alpha')],
          adapters: [scripted(script, calls)],
        }),
        policy: evalTaskPolicy(),
        environment: 'dev',
        budgetCredits: 5,
        now: () => new Date('2026-10-05T09:00:00.000Z'),
        clock,
      },
      task,
    );

  it('asks the planner as the Harness does, scores each case and records the cost', async () => {
    const calls: ProviderCall[] = [];
    const run = await runWith((c) => good(c.id), calls);
    expect(run).toMatchObject({ prompt: 'plan_proposal@3', policy: 'agent_task@2' });
    expect(run.cases.map((c) => [c.suite, c.status, c.score?.passed])).toEqual(
      PLANNER_EVAL_CASES.map(() => ['planner', 'scored', true]),
    );
    // 1,000 input tokens at US$0.10 and 500 output at US$0.40 per million: 300 micro-USD a case.
    expect(run.totals).toMatchObject({ cases: 16, passed: 16, costMicroUsd: 4_800 });
    // The planner's output cap and JSON answer, with no agent answer schema.
    expect(calls[0]).toMatchObject({
      capability: 'text_generation',
      structuredOutput: true,
      maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
    });
    expect(calls[0]?.outputSchema).toBeUndefined();
    expect(run.cases[0]?.answer).toContain('research:specialist/research');
  });

  it('ADR-0171: runs @1 again under the same scoring, and compares it with @2 case by case', async () => {
    const v1Calls: ProviderCall[] = [];
    const v1 = await runWith((c) => good(c.id), v1Calls, PLANNER_V1_EVAL);
    expect(v1.prompt).toBe('plan_proposal@1');
    expect(JSON.stringify(v1Calls[0]?.messages)).toContain('candidates');
    const v2 = await runWith((c) => good(c.id));
    expect(v2.dataset).toBe(v1.dataset);
    const comparison = compareRuns(v1, v2);
    expect(comparison).toMatchObject({ sameDataset: true, verdict: 'accept', regressions: [] });
    // The figures side by side: totals, each check, outcomes and languages, and each case.
    const vague = await runWith(() => good('p10_vague_es'));
    expect(plannerBreakdown(vague)).toMatchObject({
      prompt: 'plan_proposal@3',
      passed: 6,
      scored: 16,
      outcomes: { ask: { passed: 2, of: 2 }, no_invention: { passed: 4, of: 4 } },
      languages: { es: { passed: 4, of: 10 }, en: { passed: 2, of: 6 } },
    });
    const text = plannerComparisonText(v2, vague);
    expect(text).toContain('total                16/16              6/16');
    expect(text).toMatch(/p01_research_then_campaign\s+PASS\s+FAIL plan_shape/);
  });

  it('shows a worse planner as a drop in planning against the baseline', async () => {
    const baseline = await runWith((c) => good(c.id));
    const answerOnly = await runWith(() => good('p10_vague_es'));
    // A question back passes only where nothing should be planned: the vague and impossible cases.
    expect(answerOnly.totals.passed).toBe(6);
    const comparison = compareRuns(baseline, answerOnly);
    expect(comparison.verdict).toBe('revert');
    const { baseline: before, current: after } = comparison.categories.planning;
    expect(after.passed / after.checks).toBeLessThan(before.passed / before.checks);
  });
});
