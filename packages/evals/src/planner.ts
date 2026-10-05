import { createHash } from 'node:crypto';
import {
  promptLabel,
  promptRef,
  redactSecretText,
  type AIMessage,
  type AIOutput,
} from '@melonoffice/ai-gateway';
import type { DepartmentId, PlanVersion, Specialist } from '@melonoffice/domain';
import { HARNESS_RISK_POLICY } from '@melonoffice/harness';
import {
  checkProposal,
  checkStepStructure,
  createPlanValidator,
  MAX_STEPS,
  MAX_WAIT_SECONDS,
  PLANNER_MAX_OUTPUT_TOKENS,
  PLANNER_PROMPT,
  plannerAgentOf,
  plannerMessages,
  plannerToolOf,
  planningAnswerOf,
  unrunnableStepOf,
  type PlannerAgentView,
  type PlanningCandidate,
  type ProposalStep,
} from '@melonoffice/planning';
import { ROLES } from '@melonoffice/rbac';
import { SpecialistError } from '@melonoffice/specialists';
import { defaultToolRegistry } from '@melonoffice/tools';
import type { EvalRun, EvalTask } from './run.js';
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

const REGISTRY = defaultToolRegistry();

/**
 * The synthetic office as `plan_proposal@2` sees it (ADR-0171): each agent with its tools as the
 * registry describes them and the validator judges them, exactly as the Harness builds it.
 */
export const PLANNER_EVAL_AGENTS: readonly PlannerAgentView[] = Object.freeze(
  PLANNER_EVAL_CANDIDATES.map((c) =>
    plannerAgentOf(c, (ref) =>
      plannerToolOf(
        ref,
        REGISTRY.resolve(ref.id, ref.version),
        VALIDATOR.toolUse(ref, c.departmentType),
      ),
    ),
  ),
);

/** The model request of one case: the planner's own messages, with the synthetic office. */
export const plannerEvalMessages = (c: PlannerEvalCase): AIMessage[] =>
  plannerMessages({ agents: PLANNER_EVAL_AGENTS }, c.request);

/**
 * `plan_proposal@1` as it was sent (ADR-0169), kept only so a run can measure it again beside
 * @2 under the same scoring. Frozen: its digest is checked against the one pinned for @1.
 */
export const PLANNER_V1_PROMPT = promptRef('plan_proposal', 1);
export const PLANNER_V1_INSTRUCTIONS = [
  'You are the MelonOffice planner. Propose a plan as one JSON object with exactly the fields',
  'summary, objective, optional riskLevel (low|medium|high|critical) and steps.',
  `Use at most ${MAX_STEPS} steps. Each step has id (lowercase letters, digits, underscore),`,
  'kind (specialist|tool|approval|verification|condition|parallel), label and dependsOn.',
  'A specialist step names a specialistId from the candidates and a verification',
  '{policy, expectedOutput, requiredChecks}. A tool step names performedBy (a specialist step)',
  'and one tool {id, version} that specialist lists. Never include organizations, users,',
  'permissions, approvals, credits, policies or credentials: they are refused.',
].join(' ');

/** A case's request as @1 sent it: its instructions, the candidates as data, the request. */
export const plannerV1EvalMessages = (c: PlannerEvalCase): AIMessage[] => [
  {
    role: 'system',
    content: [
      { type: 'text', text: PLANNER_V1_INSTRUCTIONS },
      { type: 'text', text: JSON.stringify({ candidates: PLANNER_EVAL_CANDIDATES }) },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: c.request }] },
];

/**
 * `plan_proposal@2` as it was sent (ADR-0171), kept only so a run can measure it again beside
 * @3 (ADR-0172). Frozen: its digest is checked against the one pinned for @2's instructions.
 */
export const PLANNER_V2_PROMPT = promptRef('plan_proposal', 2);
export const PLANNER_V2_INSTRUCTIONS = [
  'You are the MelonOffice planner. You turn one request into a plan for the agents in the',
  'context, or you ask, or you say it cannot be done. You never do the work yourself.',
  'Answer with exactly one JSON object, one of:',
  '(1) a plan: {"summary": a short title, "objective": one sentence, "steps": [...]};',
  '(2) a question, when the request is too vague or essential information is missing:',
  '{"question": "..."};',
  '(3) when these agents and tools cannot do it: {"notPossible": "..."}, saying what cannot be',
  'done and why. If part of it can be done, plan that part and say in the summary what is left out.',
  'Write the summary, labels, question and notPossible in the language of the request.',
  `A plan has at most ${MAX_STEPS} steps, as few as the request needs. Each step has id`,
  '(lowercase letters, digits and underscores, starting with a letter), kind, label (what it',
  'does, in a few words) and dependsOn (ids of earlier steps only; never a later step, never a',
  'cycle). Steps that do not depend on each other run side by side. The only kinds are:',
  '"specialist": an agent does the work; give its specialistId from the context. Add',
  '"approvalRequired": true when the person asked to review or approve before what follows.',
  '"tool": an agent uses one of its own tools marked usableAsStep; give performedBy (the id of',
  'that agent\'s specialist step, also in dependsOn), tool {"id", "version"} exactly as listed,',
  "and input, a JSON object valid for the tool's input schema with only values the request",
  'gives. Use inputFrom {"<input key>": {"step": "<earlier step id>"}} only when the tool has',
  'inputFromAllowed, and {"step", "field"} to read a field of an earlier tool step\'s output.',
  `"wait": {"wait": {"seconds": 1 to ${MAX_WAIT_SECONDS}}} before what follows.`,
  '"condition": only a policy check, and only when checkActions are listed:',
  '{"decision": {"decision": "action.policy_check", "continueOn": ["allowed"], "input":',
  '{"action": one listed action}}}.',
  'There are no approval, verification or parallel steps. Use only the agents and tools in the',
  'context: never invent an agent, department, tool or input. A tool with usableAsStep false',
  'cannot be a step; if the request needs it, say so. If you cannot give a valid input, ask.',
  'Do not copy phone numbers, email addresses or other personal data into the plan. Never include',
  'organizations, users, permissions, credits, policies or credentials: they are refused.',
].join(' ');

/** A case's request as @2 sent it: its instructions, then the office and request as today. */
export const plannerV2EvalMessages = (c: PlannerEvalCase): AIMessage[] =>
  plannerMessages({ agents: PLANNER_EVAL_AGENTS }, c.request).map((m) =>
    m.role !== 'system'
      ? m
      : {
          ...m,
          content: m.content.map((part, i) =>
            i === 0 ? { type: 'text' as const, text: PLANNER_V2_INSTRUCTIONS } : part,
          ),
        },
  );

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
  | 'says_not_possible'
  | 'no_personal_data'
  | 'language';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What the model answered, as the product reads it (`planningAnswerOf`, ADR-0171): a plan (with
 * the one way agent work is checked), a question back, or a "cannot be done". An answer that is
 * none of these is kept as the JSON it was, if any, for the pipeline to refuse.
 */
function readingOf(output: AIOutput | undefined): {
  readonly answer: unknown;
  readonly asks: boolean;
  readonly notPossible: boolean;
} {
  const read = planningAnswerOf(output);
  if (read.kind === 'question') {
    return { answer: { question: read.text }, asks: true, notPossible: false };
  }
  if (read.kind === 'not_possible') {
    return { answer: { notPossible: read.text }, asks: false, notPossible: true };
  }
  const answer = read.kind === 'proposal' ? read.proposal : rawOf(output);
  // @1 had no question form: a summary that asks, with no steps, is its question back.
  const asks =
    isRecord(answer) &&
    (!Array.isArray(answer.steps) || answer.steps.length === 0) &&
    typeof answer.summary === 'string' &&
    answer.summary.includes('?');
  return { answer, asks, notPossible: false };
}

/** The answer as JSON, or undefined. */
function rawOf(output: AIOutput | undefined): unknown {
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
  const { answer, asks, notPossible } = readingOf(output);
  const checks: { check: PlannerCheckId; passed: boolean }[] = [];
  const add = (check: PlannerCheckId, passed: boolean) => checks.push({ check, passed });
  const done = (): EvalScore =>
    Object.freeze({
      passed: checks.every((k) => k.passed),
      checks: Object.freeze(checks as unknown as EvalCheck[]),
    });
  const said = JSON.stringify(answer ?? output?.text ?? '');

  // Too vague: a question back. Impossible: saying so, or asking, is as good as a plan of what
  // can be done.
  if (c.expect.outcome === 'ask') {
    add('asks_back', asks);
    add('no_invented_tools', !inventsTools(answer));
    return done();
  }
  if (c.expect.outcome === 'no_invention' && (asks || notPossible)) {
    add(asks ? 'asks_back' : 'says_not_possible', true);
    add('no_invented_tools', !inventsTools(answer));
    if (c.expect.pii !== undefined) add('no_personal_data', !leaks(said, c.expect.pii));
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
  const answer = rawOf(output);
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
  const text = `${typeof answer.summary === 'string' ? answer.summary : ''} | ${summary.join(' ; ')}${typeof answer.question === 'string' ? ` | question: ${answer.question}` : ''}${typeof answer.notPossible === 'string' ? ` | not possible: ${answer.notPossible}` : ''}`;
  return redactSecretText(text).slice(0, 1500);
}

/**
 * Why the pipeline refused a plan, as codes and paths only (ADR-0172): the schema's reason and
 * field, or the validator's stage, reason and field. Undefined when it is not a plan or passes.
 */
export async function plannerRefusalOf(output: AIOutput | undefined): Promise<string | undefined> {
  const { answer, asks, notPossible } = readingOf(output);
  if (asks || notPossible) return undefined;
  const checked = checkProposal(answer);
  if (!checked.ok) return `${checked.reason}:${checked.detail}`;
  const validation = await VALIDATOR.validate(TENANT, answer);
  if (validation.ok) return undefined;
  return `${validation.stage}/${validation.reason}${validation.detail === undefined ? '' : `:${validation.detail}`}`;
}

/** Why the plan was refused, if it was, then the kept plan. */
async function keptPlanWithRefusal(output: AIOutput): Promise<string | undefined> {
  const kept = keptPlan(output);
  const refusal = await plannerRefusalOf(output);
  if (refusal === undefined) return kept;
  return `refused: ${redactSecretText(refusal).slice(0, 200)} | ${kept ?? ''}`.slice(0, 1500);
}

const plannerDigest = (cases: readonly PlannerEvalCase[]) =>
  createHash('sha256')
    .update(
      JSON.stringify([PLANNER_EVAL_CANDIDATES, cases.map((x) => [x.id, x.request, x.expect])]),
    )
    .digest('hex')
    .slice(0, 16);

/**
 * The planner as an eval task (ADR-0169, ADR-0171): its own prompt version and messages, no
 * answer schema (the planner asks for JSON without one), its output limit, and the scoring above.
 * The dataset digest is the cases' and the office's only, so runs of @1, @2 and @3 compare.
 */
export const PLANNER_EVAL: EvalTask<PlannerEvalCase> = Object.freeze({
  prompt: promptLabel(PLANNER_PROMPT),
  messagesOf: plannerEvalMessages,
  maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
  score: scorePlannerAnswer,
  keep: (_c: PlannerEvalCase, output: AIOutput) => keptPlanWithRefusal(output),
  digest: plannerDigest,
});

/** `plan_proposal@2` measured again under today's scoring (`--prompt 2`), to compare with @3. */
export const PLANNER_V2_EVAL: EvalTask<PlannerEvalCase> = Object.freeze({
  ...PLANNER_EVAL,
  prompt: promptLabel(PLANNER_V2_PROMPT),
  messagesOf: plannerV2EvalMessages,
});

/** `plan_proposal@1` measured again under today's scoring (`--prompt 1`), to compare with @2. */
export const PLANNER_V1_EVAL: EvalTask<PlannerEvalCase> = Object.freeze({
  ...PLANNER_EVAL,
  prompt: promptLabel(PLANNER_V1_PROMPT),
  messagesOf: plannerV1EvalMessages,
});

/** The figures Geovet asked of a planner comparison (ADR-0171), from one run's own scores. */
export interface PlannerBreakdown {
  readonly prompt: string;
  readonly passed: number;
  readonly scored: number;
  /** Each check: in how many cases it was scored, and in how many it passed. */
  readonly checks: Readonly<Partial<Record<PlannerCheckId, { passed: number; of: number }>>>;
  /** Whole cases passed, by what the case asks and by its language. */
  readonly outcomes: Readonly<
    Record<PlannerExpectation['outcome'], { passed: number; of: number }>
  >;
  readonly languages: Readonly<
    Record<PlannerExpectation['language'], { passed: number; of: number }>
  >;
}

const BY_CASE = new Map(PLANNER_EVAL_CASES.map((x) => [x.id, x]));

export function plannerBreakdown(run: EvalRun): PlannerBreakdown {
  const checks: Partial<Record<PlannerCheckId, { passed: number; of: number }>> = {};
  const outcomes = {
    plan: { passed: 0, of: 0 },
    ask: { passed: 0, of: 0 },
    no_invention: { passed: 0, of: 0 },
  };
  const languages = { es: { passed: 0, of: 0 }, en: { passed: 0, of: 0 } };
  let passed = 0;
  let scored = 0;
  for (const r of run.cases) {
    const c = BY_CASE.get(r.id);
    if (r.score === undefined || c === undefined) continue;
    scored += 1;
    if (r.score.passed) passed += 1;
    for (const bucket of [outcomes[c.expect.outcome], languages[c.expect.language]]) {
      bucket.of += 1;
      if (r.score.passed) bucket.passed += 1;
    }
    for (const k of r.score.checks) {
      const id = k.check as unknown as PlannerCheckId;
      const entry = (checks[id] ??= { passed: 0, of: 0 });
      entry.of += 1;
      if (k.passed) entry.passed += 1;
    }
  }
  return { prompt: run.prompt, passed, scored, checks, outcomes, languages };
}

/** The checks a comparison names, in the words of the figures asked for. */
const BREAKDOWN_ROWS: readonly (readonly [string, PlannerCheckId])[] = [
  ['shape', 'plan_shape'],
  ['step kinds', 'runnable_kinds'],
  ['roles', 'valid_roles'],
  ['tools assigned', 'tools_assigned'],
  ['invented tools', 'no_invented_tools'],
  ['inputs', 'valid_inputs'],
  ['inputFrom', 'valid_input_refs'],
  ['dependencies', 'valid_dependencies'],
  ['cycles', 'no_cycles'],
  ['valid plan', 'valid_plan'],
  ['approvals', 'approval'],
  ['asks back', 'asks_back'],
  ['says not possible', 'says_not_possible'],
  ['personal data', 'no_personal_data'],
  ['language', 'language'],
];

/** Two planner runs side by side: totals, each check, outcomes and languages, and each case. */
export function plannerComparisonText(before: EvalRun, after: EvalRun): string {
  const a = plannerBreakdown(before);
  const b = plannerBreakdown(after);
  const cell = (x: { passed: number; of: number } | undefined) =>
    x === undefined ? '-' : `${x.passed}/${x.of}`;
  const lines = [
    `${'planner'.padEnd(20)} ${a.prompt.padEnd(18)} ${b.prompt}`,
    `${'total'.padEnd(20)} ${`${a.passed}/${a.scored}`.padEnd(18)} ${b.passed}/${b.scored}`,
    ...BREAKDOWN_ROWS.map(
      ([label, id]) => `${label.padEnd(20)} ${cell(a.checks[id]).padEnd(18)} ${cell(b.checks[id])}`,
    ),
    ...(['plan', 'ask', 'no_invention'] as const).map(
      (o) => `${`cases: ${o}`.padEnd(20)} ${cell(a.outcomes[o]).padEnd(18)} ${cell(b.outcomes[o])}`,
    ),
    ...(['es', 'en'] as const).map(
      (l) =>
        `${`cases: ${l}`.padEnd(20)} ${cell(a.languages[l]).padEnd(18)} ${cell(b.languages[l])}`,
    ),
    '',
    ...PLANNER_EVAL_CASES.map((c) => {
      const state = (run: EvalRun) => {
        const r = run.cases.find((x) => x.id === c.id);
        if (r?.score === undefined) return r === undefined ? 'not run' : r.status;
        if (r.score.passed) return 'PASS';
        return `FAIL ${r.score.checks
          .filter((k) => !k.passed)
          .map((k) => k.check)
          .join(',')}`;
      };
      return `${c.id.padEnd(30)} ${state(before).padEnd(40)} ${state(after)}`;
    }),
  ];
  return `${lines.join('\n')}\n`;
}
