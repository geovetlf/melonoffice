import { createHash } from 'node:crypto';
import { promptLabel, redactSecretText, type AIOutput } from '@melonoffice/ai-gateway';
import type { DepartmentId, PlanVersion, Specialist } from '@melonoffice/domain';
import { HARNESS_RISK_POLICY } from '@melonoffice/harness';
import {
  checkProposal,
  checkStepStructure,
  createPlanValidator,
  PLANNER_MAX_OUTPUT_TOKENS,
  PLANNER_PROMPT,
  plannerMessages,
  unrunnableStepOf,
  type PlanningCandidate,
  type ProposalStep,
} from '@melonoffice/planning';
import { ROLES } from '@melonoffice/rbac';
import { SpecialistError } from '@melonoffice/specialists';
import { defaultToolRegistry } from '@melonoffice/tools';
import type { EvalTask } from './run.js';
import type { EvalCheck, EvalScore } from './score.js';

/**
 * The planner's evals (Block 3 F1, ADR-0169): what `plan_proposal` makes of a person's request,
 * scored without a model by the plan pipeline itself. The schema is `checkProposal`; the
 * structure, dependencies and cycles are `checkStepStructure`; runnable kinds are the conductor's
 * `unrunnableStepOf`; and the plan is the validator's (`createPlanValidator`) over one synthetic
 * office, with the Harness's risk policy, in DEV. Nothing here is a real company's data.
 */

/** The synthetic office: four agents, as their templates make them, with fixed ids. */
const AGENT = {
  sales: '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0001',
  marketing: '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0002',
  research: '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0003',
  finance: '7d0c1a52-3b8e-4f6a-9c21-5e4b7a9d0004',
} as const;

type Department = keyof typeof AGENT;

const tool = (id: string, version: number) => ({ id, version }) as PlanningCandidate['tools'][0];

/**
 * What the planner sees: each agent's department type, role and the tools its skills grant. Sales
 * has company_knowledge@3, customer_follow_up@2 and pipeline_analysis@2; marketing has
 * company_knowledge@3; research and finance have no tool.
 */
export const PLANNER_EVAL_CANDIDATES: readonly PlanningCandidate[] = Object.freeze([
  {
    specialistId: AGENT.sales,
    departmentType: 'sales',
    roleId: 'commercial_agent',
    capabilities: [],
    tools: [
      tool('knowledge_search', 1),
      tool('follow_up_schedule', 2),
      tool('customer_records_summary', 1),
    ],
  },
  {
    specialistId: AGENT.marketing,
    departmentType: 'marketing',
    roleId: 'marketing_agent',
    capabilities: [],
    tools: [tool('knowledge_search', 1)],
  },
  {
    specialistId: AGENT.research,
    departmentType: 'research',
    roleId: 'research_agent',
    capabilities: [],
    tools: [],
  },
  {
    specialistId: AGENT.finance,
    departmentType: 'finance',
    roleId: 'finance_agent',
    capabilities: [],
    tools: [],
  },
]);

/** What a good plan for a case must do, beyond what every plan must (see `PLANNER_CHECKS`). */
export interface PlannerExpectation {
  readonly language: 'es' | 'en';
  /** `plan`: a plan the validator accepts. `ask`: the request is too vague, a question back. */
  readonly outcome: 'plan' | 'ask' | 'no_invention';
  /** Departments that must each do a step. */
  readonly departments?: readonly Department[];
  /** A tool some tool step must use. */
  readonly usesTool?: string;
  /** Each pair: a step of the first department waits, directly or not, on one of the second. */
  readonly after?: readonly (readonly [Department, Department])[];
  /** The person asked to review before anything else: some step asks for approval. */
  readonly approval?: boolean;
  /** Personal data in the request that must not be copied into the plan. */
  readonly pii?: readonly string[];
}

export interface PlannerEvalCase {
  readonly id: string;
  readonly suite: 'planner';
  readonly request: string;
  readonly expect: PlannerExpectation;
}

const c = (id: string, request: string, expect: PlannerExpectation): PlannerEvalCase =>
  Object.freeze({ id, suite: 'planner', request, expect: Object.freeze(expect) });

/**
 * The cases, in the 13 kinds Geovet set (2026-10-05 07:45Z): runnable kinds, valid roles, tools
 * really assigned, valid inputs, valid references to earlier results, valid dependencies, no
 * cycles, approval where asked, an impossible request without invention, a vague request asked
 * back, no needless personal data, Spanish and English.
 */
export const PLANNER_EVAL_CASES: readonly PlannerEvalCase[] = Object.freeze([
  c(
    'p01_research_then_campaign',
    'Investiga el mercado de jugos naturales en Lima y luego prepara una campaña de marketing con lo que encuentres.',
    {
      language: 'es',
      outcome: 'plan',
      departments: ['research', 'marketing'],
      after: [['marketing', 'research']],
    },
  ),
  c(
    'p02_search_company_memory',
    'Busca en la memoria de la empresa nuestra política de descuentos y redacta una propuesta para un cliente con ella.',
    { language: 'es', outcome: 'plan', usesTool: 'knowledge_search' },
  ),
  c(
    'p03_pipeline_counts',
    'Dime cuántos clientes tenemos en cada etapa del embudo de ventas y propón a cuáles priorizar esta semana.',
    { language: 'es', outcome: 'plan', usesTool: 'customer_records_summary' },
  ),
  // Under the Harness's risk policy every tool step asks a person first, with its exact input, so
  // the valid answer fixes the query: a reference to the earlier step is refused.
  c(
    'p04_input_from_earlier_step',
    'Have sales write a short search query about our refund policy, search the company memory with exactly that query, then draft the reply to the customer.',
    { language: 'en', outcome: 'plan', usesTool: 'knowledge_search' },
  ),
  c(
    'p05_ordered_chain',
    'Primero que finanzas calcule el presupuesto, después marketing prepara la campaña con ese presupuesto y al final ventas prepara el mensaje para los clientes.',
    {
      language: 'es',
      outcome: 'plan',
      departments: ['finance', 'marketing', 'sales'],
      after: [
        ['marketing', 'finance'],
        ['sales', 'marketing'],
      ],
    },
  ),
  c(
    'p06_parallel_then_join',
    'Research the market and, at the same time, have finance estimate the launch costs; then marketing combines both into a launch plan.',
    {
      language: 'en',
      outcome: 'plan',
      departments: ['research', 'finance', 'marketing'],
      after: [
        ['marketing', 'research'],
        ['marketing', 'finance'],
      ],
    },
  ),
  c(
    'p07_review_before_continuing',
    'Prepara la respuesta a la queja de un cliente por un pedido tardío, pero quiero revisarla yo antes de que se haga nada más.',
    { language: 'es', outcome: 'plan', approval: true },
  ),
  c(
    'p08_impossible_es',
    'Envía un WhatsApp a todos nuestros clientes con la nueva oferta y cóbrales con tarjeta a los que acepten.',
    { language: 'es', outcome: 'no_invention' },
  ),
  c('p09_impossible_en', 'Post our new offer on Instagram and email it to every customer today.', {
    language: 'en',
    outcome: 'no_invention',
  }),
  c('p10_vague_es', 'Hazlo como la otra vez.', { language: 'es', outcome: 'ask' }),
  c('p11_vague_en', 'Fix it.', { language: 'en', outcome: 'ask' }),
  c(
    'p12_personal_data',
    'Prepara un seguimiento para Juan Pérez, teléfono +51 987 654 321, correo juan.perez@example.com, que pidió precios de jugos para su tienda.',
    {
      language: 'es',
      outcome: 'plan',
      pii: ['987 654 321', '987654321', 'juan.perez@example.com'],
    },
  ),
  c(
    'p13_circular_request',
    'Marketing drafts the campaign after sales reviews it, and sales reviews it after marketing drafts it.',
    { language: 'en', outcome: 'plan', departments: ['marketing', 'sales'] },
  ),
  c(
    'p14_english_plan',
    "Analyze last month's sales and prepare a plan to win back inactive customers.",
    { language: 'en', outcome: 'plan' },
  ),
  c(
    'p15_unknown_department',
    'Que el departamento legal revise el contrato del proveedor y después ventas se lo envíe al cliente.',
    { language: 'es', outcome: 'no_invention' },
  ),
  c(
    'p16_write_tool_with_review',
    'Agenda un seguimiento con cada cliente que pidió precios esta semana, pero antes muéstrame la lista para aprobarla.',
    { language: 'es', outcome: 'no_invention', approval: true },
  ),
]);

/** The model request of one case: the planner's own messages, with the synthetic office. */
export const plannerEvalMessages = (c: PlannerEvalCase) =>
  plannerMessages(PLANNER_EVAL_CANDIDATES, c.request);

// ---------------------------------------------------------------------------------------------
// The validator over the synthetic office

const ORG = 'eval_office';
const departmentOf = (type: string) => `eval_${type}` as DepartmentId;

function specialistOf(candidate: PlanningCandidate): Specialist {
  return {
    identity: { id: candidate.specialistId, displayName: candidate.departmentType },
    organizationId: ORG,
    version: 1,
    configuration: {
      departmentId: departmentOf(candidate.departmentType),
      mainRoleId: candidate.roleId,
      tools: candidate.tools,
    },
  } as unknown as Specialist;
}

const BY_ID = new Map(PLANNER_EVAL_CANDIDATES.map((s) => [s.specialistId, s]));

/** The real plan validator, over the synthetic office, as the Harness's plans are validated. */
const VALIDATOR = createPlanValidator({
  specialists: {
    async get(_tenant: unknown, id: string) {
      const found = BY_ID.get(id);
      if (found === undefined) {
        throw new SpecialistError('specialist_not_found');
      }
      return specialistOf(found);
    },
    async eligibility(_tenant: unknown, input: { specialistId: string }) {
      return BY_ID.has(input.specialistId)
        ? { eligible: true, assignment: { specialistVersion: 1 } }
        : { eligible: false, reason: 'specialist_not_found' };
    },
    async getVersion(_tenant: unknown, id: string) {
      const found = BY_ID.get(id);
      return {
        specialistId: id,
        version: 1,
        configuration: specialistOf(found as PlanningCandidate).configuration,
      };
    },
  } as never,
  departments: {
    async find(_org: unknown, id: string) {
      const type = id.replace(/^eval_/, '');
      return { id, origin: { kind: 'catalog', typeId: type } };
    },
  } as never,
  tools: defaultToolRegistry(),
  authorization: { permissionsOf: () => new Set<string>(ROLES.owner) } as never,
  environment: 'dev',
  riskPolicy: HARNESS_RISK_POLICY,
});

const TENANT = { actor: 'user', organizationId: ORG, userId: 'eval-user' } as never;

// ---------------------------------------------------------------------------------------------
// Scoring

/** The checks of a planner case, in the order they are scored. */
export type PlannerCheckId =
  | 'plan_shape'
  | 'runnable_kinds'
  | 'valid_roles'
  | 'tools_assigned'
  | 'valid_inputs'
  | 'valid_input_refs'
  | 'valid_dependencies'
  | 'no_cycles'
  | 'valid_plan'
  | 'departments'
  | 'uses_tool'
  | 'order'
  | 'approval'
  | 'no_invented_tools'
  | 'asks_back'
  | 'no_personal_data'
  | 'language';

/** What the model answered, as JSON, or undefined. */
function answerOf(output: AIOutput | undefined): unknown {
  if (output === undefined) return undefined;
  if (output.structured !== undefined) return output.structured;
  if (output.text === undefined) return undefined;
  const text = output.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A question back: a `question` the model added, or a summary that asks and no steps. */
function asksBack(answer: unknown): boolean {
  if (!isRecord(answer)) return false;
  if (typeof answer.question === 'string' && answer.question.trim() !== '') return true;
  const steps = Array.isArray(answer.steps) ? answer.steps : [];
  return steps.length === 0 && typeof answer.summary === 'string' && answer.summary.includes('?');
}

const ES = ['de', 'la', 'el', 'y', 'que', 'los', 'las', 'para', 'con', 'del', 'una', 'por', 'sus'];
const EN = ['the', 'and', 'of', 'to', 'for', 'with', 'our', 'from', 'on', 'their', 'by', 'its'];

/** Which language the plan's own words are in, by their commonest words. */
export function languageOf(text: string): 'es' | 'en' | undefined {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const es = words.filter((w) => ES.includes(w)).length;
  const en = words.filter((w) => EN.includes(w)).length;
  return es === en ? undefined : es > en ? 'es' : 'en';
}

const STRUCTURE: Readonly<Record<string, PlannerCheckId>> = {
  plan_cycle: 'no_cycles',
  self_dependency: 'no_cycles',
  invalid_input_ref: 'valid_input_refs',
  invalid_proposal: 'plan_shape',
};
const VALIDATION: Readonly<Record<string, PlannerCheckId>> = {
  specialist_not_eligible: 'valid_roles',
  department_mismatch: 'valid_roles',
  tool_not_assigned: 'tools_assigned',
  invalid_tool_input: 'valid_inputs',
  invalid_tool_input_ref: 'valid_input_refs',
  tool_input_from_model: 'valid_input_refs',
  input_ref_needs_fixed_input: 'valid_input_refs',
  step_not_runnable: 'runnable_kinds',
};

/** Every step a step waits for, directly or through others. */
function ancestors(steps: readonly ProposalStep[], id: string): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    byId.get(k)?.dependsOn.forEach(visit);
  };
  byId.get(id)?.dependsOn.forEach(visit);
  return seen;
}

/** Scores one planner answer (ADR-0169): fixed rules, no model, the plan pipeline's own. */
export async function scorePlannerAnswer(
  c: PlannerEvalCase,
  output: AIOutput | undefined,
): Promise<EvalScore> {
  const answer = answerOf(output);
  const checks: { check: PlannerCheckId; passed: boolean }[] = [];
  const add = (check: PlannerCheckId, passed: boolean) => checks.push({ check, passed });
  const done = (): EvalScore =>
    Object.freeze({
      passed: checks.every((k) => k.passed),
      checks: Object.freeze(checks as unknown as EvalCheck[]),
    });
  const said = JSON.stringify(answer ?? output?.text ?? '');

  // Too vague: a question back. Impossible: a question back is as good as a plan of what can be done.
  if (c.expect.outcome === 'ask' || (c.expect.outcome === 'no_invention' && asksBack(answer))) {
    add('asks_back', asksBack(answer));
    add('no_invented_tools', !inventsTools(answer));
    return done();
  }

  const checked = checkProposal(answer);
  add('plan_shape', checked.ok);
  if (!checked.ok) {
    // Nothing more can be read of it; a question back is not a plan either.
    if (c.expect.pii !== undefined) add('no_personal_data', !leaks(said, c.expect.pii));
    return done();
  }
  const { steps } = checked.proposal;
  const kinds = steps.every(
    (s) =>
      s.kind === 'tool' || unrunnableStepOf({ steps: [s] } as unknown as PlanVersion) === undefined,
  );
  add('runnable_kinds', kinds);
  add(
    'valid_roles',
    steps.every((s) => s.kind !== 'specialist' || BY_ID.has(s.specialistId ?? '')),
  );
  const performer = new Map(steps.map((s) => [s.id, BY_ID.get(s.specialistId ?? '')]));
  add(
    'tools_assigned',
    steps.every((s) => {
      if (s.kind !== 'tool') return true;
      const who = performer.get(s.performedBy ?? '');
      return who?.tools.some((t) => t.id === s.tool?.id && t.version === s.tool?.version) === true;
    }),
  );
  add('no_invented_tools', !inventsTools(answer));

  const structure = checkStepStructure(steps);
  const failedStructure = structure.ok
    ? undefined
    : (STRUCTURE[structure.reason] ?? 'valid_dependencies');
  const validation = await VALIDATOR.validate(TENANT, answer);
  const failedValidation = validation.ok ? undefined : VALIDATION[validation.reason];
  const passes = (id: PlannerCheckId) => failedStructure !== id && failedValidation !== id;
  add('valid_inputs', passes('valid_inputs'));
  add('valid_input_refs', passes('valid_input_refs'));
  add('valid_dependencies', passes('valid_dependencies'));
  add('no_cycles', passes('no_cycles'));
  // Whatever plan is given must be one the validator accepts, including a part of an impossible ask.
  add('valid_plan', validation.ok);

  const typeOf = (s: ProposalStep) =>
    s.kind === 'specialist' ? BY_ID.get(s.specialistId ?? '')?.departmentType : undefined;
  const { expect } = c;
  if (expect.departments !== undefined) {
    const used = new Set(steps.map(typeOf));
    add(
      'departments',
      expect.departments.every((d) => used.has(d)),
    );
  }
  if (expect.usesTool !== undefined) {
    add(
      'uses_tool',
      steps.some((s) => s.kind === 'tool' && s.tool?.id === expect.usesTool),
    );
  }
  if (expect.after !== undefined) {
    add(
      'order',
      expect.after.every(([later, earlier]) =>
        steps.some((s) => {
          if (typeOf(s) !== later) return false;
          const before = ancestors(steps, s.id);
          return steps.some((e) => before.has(e.id) && typeOf(e) === earlier);
        }),
      ),
    );
  }
  if (expect.approval === true) {
    add(
      'approval',
      steps.some((s) => s.approvalRequired === true),
    );
  }
  if (expect.pii !== undefined) add('no_personal_data', !leaks(said, expect.pii));
  const words = [checked.proposal.summary, ...steps.map((s) => s.label)].join(' ');
  add('language', languageOf(words) === expect.language);
  return done();
}

/** A tool no candidate has, anywhere in the answer's steps. */
function inventsTools(answer: unknown): boolean {
  if (!isRecord(answer) || !Array.isArray(answer.steps)) return false;
  const known = new Set<string>(PLANNER_EVAL_CANDIDATES.flatMap((s) => s.tools.map((t) => t.id)));
  return answer.steps.some((s) => {
    if (!isRecord(s) || s.tool === undefined) return false;
    return !isRecord(s.tool) || !known.has(String(s.tool.id));
  });
}

const digits = (s: string) => s.replace(/\D/g, '');
function leaks(said: string, pii: readonly string[]): boolean {
  const lower = said.toLowerCase();
  const allDigits = digits(said);
  return pii.some((p) =>
    /\d/.test(p) && !p.includes('@')
      ? allDigits.includes(digits(p))
      : lower.includes(p.toLowerCase()),
  );
}

/** A plan's steps as the run file keeps them: kind, who, tool and dependencies, never text. */
export function keptPlan(output: AIOutput | undefined): string | undefined {
  const answer = answerOf(output);
  if (!isRecord(answer)) {
    return output?.text === undefined ? undefined : redactSecretText(output.text).slice(0, 1500);
  }
  const steps = Array.isArray(answer.steps) ? answer.steps : [];
  const summary = steps.map((s) => {
    if (!isRecord(s)) return '?';
    const who = BY_ID.get(String(s.specialistId))?.departmentType ?? s.specialistId ?? '';
    const tool = isRecord(s.tool) ? `${String(s.tool.id)}@${String(s.tool.version)}` : '';
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn.join(',') : '';
    return `${String(s.id)}:${String(s.kind)}${who === '' ? '' : `/${String(who)}`}${tool === '' ? '' : `/${tool}`}${s.approvalRequired === true ? '/approval' : ''}${deps === '' ? '' : `<-${deps}`}`;
  });
  const text = `${typeof answer.summary === 'string' ? answer.summary : ''} | ${summary.join(' ; ')}${typeof answer.question === 'string' ? ` | question: ${answer.question}` : ''}`;
  return redactSecretText(text).slice(0, 1500);
}

/**
 * The planner as an eval task (ADR-0169): its own prompt version and messages, no answer schema
 * (the planner asks for JSON without one), its output limit, and the scoring above.
 */
export const PLANNER_EVAL: EvalTask<PlannerEvalCase> = Object.freeze({
  prompt: promptLabel(PLANNER_PROMPT),
  messagesOf: plannerEvalMessages,
  maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
  score: scorePlannerAnswer,
  keep: (_c: PlannerEvalCase, output: AIOutput) => keptPlan(output),
  digest: (cases: readonly PlannerEvalCase[]) =>
    createHash('sha256')
      .update(
        JSON.stringify([PLANNER_EVAL_CANDIDATES, cases.map((x) => [x.id, x.request, x.expect])]),
      )
      .digest('hex')
      .slice(0, 16),
});
