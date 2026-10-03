import { createHash } from 'node:crypto';
import {
  AGENT_ANSWER_SCHEMA,
  AGENT_TASK_MAX_OUTPUT_TOKENS,
  AGENT_TASK_PROMPT,
  agentTaskMessages,
  parseAgentAnswer,
} from '@melonoffice/agents';
import {
  allowsFallback,
  checkProviderSuccess,
  costMicroUsd,
  creditsFor,
  CREDIT_RATE,
  estimateInputTokens,
  promptLabel,
  REDACTED,
  redactSecretText,
  routeModel,
  type ProviderCall,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import type {
  AIDataPolicy,
  DepartmentId,
  DeploymentEnvironment,
  ModelPolicy,
  RoleId,
  SpecialistConfiguration,
} from '@melonoffice/domain';
import { findAgentTemplate } from '@melonoffice/specialists';
import { contextTextOf, type EvalCase, type EvalSuiteId } from './cases.js';
import { scoreAnswer, type EvalScore } from './score.js';

/**
 * Runs the eval cases against real models (ADR-0134): each case is the agent task's own prompt
 * (`agentTaskMessages`, the version in `AGENT_TASK_PROMPT`) and answer shape, routed by the AI
 * Gateway's own router under the policy the worker uses, called through the provider's own
 * adapter, and scored by `scoreAnswer`. No organization, credits wallet or execution is involved:
 * the run spends from its own budget, stops before going over it, and records what each case cost.
 */

/** What the run records of one case. */
export interface EvalCaseResult {
  readonly id: string;
  readonly suite: EvalSuiteId;
  /** Which repetition of the case, from 1, when the run repeats cases. */
  readonly attempt?: number;
  /**
   * `scored`: the model answered and the answer was scored. `no_route`: no model fits the policy.
   * `provider_error`: every candidate failed. `budget_reached`: not run, it could go over budget.
   */
  readonly status: 'scored' | 'no_route' | 'provider_error' | 'budget_reached';
  /** `provider/model@version` that answered, or the last one tried. */
  readonly model?: string;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicroUsd?: number;
  /** Why it was not scored: the router's refusal or the provider's error kind. */
  readonly reason?: string;
  readonly score?: EvalScore;
  /**
   * The answer, to find why a case failed (G-7). The case's secret and anything that looks like
   * a credential are cut out first, so a run file never carries one.
   */
  readonly answer?: string;
  /**
   * Whether the AI Gateway would pass this answer on (`checkProviderSuccess`): false when it
   * would discard it, for instance for a credential under its name. The score is the model's
   * answer as given, so a leak the gateway would stop still fails its case.
   */
  readonly delivered?: boolean;
}

/** The longest answer a run file keeps. */
export const EVAL_ANSWER_KEPT_CHARS = 1500;

/** An answer as a run file keeps it: no secret of the case, nothing that looks like one. */
export function keptAnswer(
  c: Pick<EvalCase, 'expect'>,
  output: { readonly structured?: unknown; readonly text?: string },
): string | undefined {
  const parsed = parseAgentAnswer(output);
  let text = parsed === undefined ? output.text : [parsed.answer, ...parsed.missing].join('\n');
  if (text === undefined) return undefined;
  const secret = c.expect.secret;
  if (secret !== undefined && secret !== '') {
    text = text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), REDACTED);
  }
  const clean = redactSecretText(text);
  return [...clean].length > EVAL_ANSWER_KEPT_CHARS
    ? `${[...clean].slice(0, EVAL_ANSWER_KEPT_CHARS - 1).join('')}…`
    : clean;
}

export interface EvalRun {
  readonly format: 1;
  /** The prompt version every case ran with, `id@version`. */
  readonly prompt: string;
  /** The model policy, `id@version`. */
  readonly policy: string;
  readonly environment: DeploymentEnvironment;
  readonly startedAt: string;
  readonly budgetCredits: number;
  /** The cases' digest: two runs measured the same thing only when it matches. */
  readonly dataset: string;
  /** The one model the run was held to (`provider/model`), when it was: a variant. */
  readonly pinned?: string;
  /** How many times each case ran. */
  readonly repeat: number;
  readonly cases: readonly EvalCaseResult[];
  readonly totals: EvalTotals;
}

export interface EvalTotals {
  readonly cases: number;
  readonly scored: number;
  readonly passed: number;
  /** Passed over scored, 0..1; 0 when nothing was scored. */
  readonly passRate: number;
  readonly costMicroUsd: number;
  /** At the credit rate (D-12): provider cost, rounded up. */
  readonly credits: number;
  readonly latencyMsP50?: number;
  readonly latencyMsMax?: number;
  /** Which model answered how many cases. */
  readonly models: Readonly<Record<string, number>>;
  /** Reliability: cases every candidate failed, and cases not run (no model fits, or budget). */
  readonly providerErrors: number;
  readonly notRun: number;
  /**
   * With repetitions: the share of cases, 0..1, whose every scored repetition had the same
   * outcome. Absent when each case ran once.
   */
  readonly consistency?: number;
}

export interface EvalRunOptions {
  readonly cases: readonly EvalCase[];
  readonly registry: ProviderRegistry;
  readonly policy: ModelPolicy;
  readonly environment: DeploymentEnvironment;
  readonly dataPolicy?: AIDataPolicy;
  /** The most the whole run may spend, in credits. A case that could go over it is not run. */
  readonly budgetCredits: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** A monotonic clock in milliseconds, for latency. */
  readonly clock?: () => number;
  /**
   * A variant (G-5): hold the run to one model, `provider/model`. The policy still applies: a
   * model it leaves out is never called, and every case is `no_route`.
   */
  readonly pin?: string;
  /** Runs each case this many times (1 to 5), to measure consistency. Default 1. */
  readonly repeat?: number;
  /** After each case, e.g. to print progress. */
  readonly onCase?: (result: EvalCaseResult) => void;
}

export const MAX_EVAL_REPEAT = 5;

/** The digest of a set of cases: their ids, requests, facts and expectations. */
export const datasetDigest = (cases: readonly EvalCase[]): string =>
  createHash('sha256')
    .update(JSON.stringify(cases.map((c) => [c.id, c.request, c.facts, c.expect])))
    .digest('hex')
    .slice(0, 16);

/** Whether a case passed in a run: scored at least once, and every scored repetition passed. */
export function casePassed(run: Pick<EvalRun, 'cases'>, id: string): boolean {
  const scored = run.cases.filter((c) => c.id === id && c.status === 'scored');
  return scored.length > 0 && scored.every((c) => c.score?.passed === true);
}

/** The registry seen through one model only. */
function pinned(registry: ProviderRegistry, pin: string): ProviderRegistry {
  const only = registry.models().filter((r) => `${r.provider.id}/${r.model.modelId}` === pin);
  return Object.freeze({
    providers: () => registry.providers(),
    provider: (id: string) => registry.provider(id),
    models: () => only,
    model: (providerId: string, modelId: string) =>
      `${providerId}/${modelId}` === pin ? registry.model(providerId, modelId) : undefined,
  });
}

/** The names the agents of each template carry in the eval: fixed, never a customer's. */
const AGENT_NAMES: Readonly<Record<EvalSuiteId, string>> = Object.freeze({
  commercial: 'Agente Comercial',
  marketing: 'Agente de Marketing',
  creative: 'Agente Creativo',
  operations: 'Agente de Operaciones',
  finance: 'Agente de Finanzas',
  research: 'Agente de Investigación',
});

/** The agent of a suite: its template's role, purpose (Spanish) and skills, as created. */
export function evalAgent(suite: EvalSuiteId): {
  readonly name: string;
  readonly configuration: SpecialistConfiguration;
} {
  const template = findAgentTemplate(suite);
  if (template === undefined) throw new Error(`unknown agent template ${suite}`);
  return {
    name: AGENT_NAMES[suite],
    configuration: {
      departmentId: `eval_${template.departmentTypeId}` as DepartmentId,
      mainRoleId: template.mainRoleId as RoleId,
      roleVersion: template.roleVersion,
      purpose: template.purpose.es,
      capabilities: [],
      skills: template.skills,
      tools: [],
      permissions: ['knowledge.read'],
      policies: template.policies,
    },
  };
}

/** The model request of one case, as the agent task builds it (no proposals offered). */
export function evalMessages(c: EvalCase) {
  const agent = evalAgent(c.suite);
  const skills = agent.configuration.skills.map((s) => ({
    id: s.id as string,
    description: (s.id as string).replace(/_/g, ' '),
  }));
  return agentTaskMessages(
    agent,
    skills,
    [{ name: 'company_context', text: contextTextOf(c.facts) }],
    c.request,
  );
}

const percentile = (sorted: readonly number[], p: number): number | undefined =>
  sorted.length === 0
    ? undefined
    : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

export function totalsOf(cases: readonly EvalCaseResult[]): EvalTotals {
  const scored = cases.filter((c) => c.status === 'scored');
  const passed = scored.filter((c) => c.score?.passed === true).length;
  const cost = cases.reduce((sum, c) => sum + (c.costMicroUsd ?? 0), 0);
  const latencies = scored
    .map((c) => c.latencyMs)
    .filter((l): l is number => l !== undefined)
    .sort((a, b) => a - b);
  const models: Record<string, number> = {};
  for (const c of scored) if (c.model !== undefined) models[c.model] = (models[c.model] ?? 0) + 1;
  const p50 = percentile(latencies, 0.5);
  const max = latencies.at(-1);
  const repeated = cases.some((c) => (c.attempt ?? 1) > 1);
  const outcomes = new Map<string, Set<boolean>>();
  for (const c of scored) {
    const seen = outcomes.get(c.id) ?? new Set<boolean>();
    seen.add(c.score?.passed === true);
    outcomes.set(c.id, seen);
  }
  const steady = [...outcomes.values()].filter((o) => o.size === 1).length;
  return Object.freeze({
    cases: cases.length,
    scored: scored.length,
    passed,
    passRate: scored.length === 0 ? 0 : passed / scored.length,
    costMicroUsd: cost,
    credits: creditsFor(cost, CREDIT_RATE),
    ...(p50 === undefined ? {} : { latencyMsP50: p50 }),
    ...(max === undefined ? {} : { latencyMsMax: max }),
    models: Object.freeze(models),
    providerErrors: cases.filter((c) => c.status === 'provider_error').length,
    notRun: cases.filter((c) => c.status === 'no_route' || c.status === 'budget_reached').length,
    ...(repeated ? { consistency: outcomes.size === 0 ? 0 : steady / outcomes.size } : {}),
  });
}

export async function runEvals(options: EvalRunOptions): Promise<EvalRun> {
  const { policy, environment, dataPolicy } = options;
  const registry =
    options.pin === undefined ? options.registry : pinned(options.registry, options.pin);
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_EVAL_REPEAT) {
    throw new Error(`repeat must be 1 to ${MAX_EVAL_REPEAT}`);
  }
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? 60_000;
  const budget = options.budgetCredits * CREDIT_RATE.microUsdPerCredit;
  const startedAt = now().toISOString();
  const results: EvalCaseResult[] = [];
  let spent = 0;

  for (const c of options.cases)
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const messages = evalMessages(c);
      const route = routeModel(
        registry,
        policy,
        environment,
        {
          capability: 'text_generation',
          inputModalities: ['text'],
          outputModality: 'text',
          sensitivity: 'confidential',
          estimatedInputTokens: estimateInputTokens({ messages }),
          maxOutputTokens: AGENT_TASK_MAX_OUTPUT_TOKENS,
          structuredOutput: true,
        },
        undefined,
        undefined,
        dataPolicy,
      );
      const base = { id: c.id, suite: c.suite, ...(repeat > 1 ? { attempt } : {}) };
      let result: EvalCaseResult;
      if (route.status === 'none') {
        result = { ...base, status: 'no_route', reason: route.reason };
      } else {
        const calls = Math.min(route.candidates.length, policy.maxCalls ?? route.candidates.length);
        result = { ...base, status: 'provider_error' };
        for (const candidate of route.candidates.slice(0, Math.max(1, calls))) {
          const model = `${candidate.provider.id}/${candidate.model.modelId}@${candidate.model.version}`;
          // Its worst case must fit what is left: the run never spends past its budget.
          if (spent + (candidate.estimatedCostMicroUsd ?? Infinity) > budget) {
            result = { ...base, status: 'budget_reached', model };
            break;
          }
          const call: ProviderCall = {
            requestId: `eval-${c.id}`,
            idempotencyKey: `eval-${startedAt}-${c.id}-${attempt}`,
            model: { id: candidate.model.modelId, version: candidate.model.version },
            capability: 'text_generation',
            messages,
            outputModality: 'text',
            maxOutputTokens: AGENT_TASK_MAX_OUTPUT_TOKENS,
            structuredOutput: true,
            outputSchema: AGENT_ANSWER_SCHEMA,
            credential: candidate.provider.credential,
            deadline: new Date(now().getTime() + timeoutMs),
          };
          const started = clock();
          const outcome = await candidate.adapter.generate(call).catch(() => undefined);
          const latencyMs = Math.round(clock() - started);
          if (outcome === undefined || outcome.status === 'error') {
            const kind = outcome?.kind ?? 'invalid_response';
            result = { ...base, status: 'provider_error', model, latencyMs, reason: kind };
            if (outcome !== undefined && allowsFallback(kind)) continue;
            break;
          }
          const cost = costMicroUsd(candidate.model.pricing, outcome.usage) ?? 0;
          spent += cost;
          result = {
            ...base,
            status: 'scored',
            model,
            latencyMs,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
            costMicroUsd: cost,
            score: scoreAnswer(c, outcome.output),
            delivered: checkProviderSuccess(outcome, undefined),
          };
          const kept = keptAnswer(c, outcome.output);
          if (kept !== undefined) result = { ...result, answer: kept };
          break;
        }
      }
      results.push(Object.freeze(result));
      options.onCase?.(result);
    }

  return Object.freeze({
    format: 1,
    prompt: promptLabel(AGENT_TASK_PROMPT),
    policy: `${policy.id}@${policy.version}`,
    environment,
    startedAt,
    budgetCredits: options.budgetCredits,
    dataset: datasetDigest(options.cases),
    ...(options.pin === undefined ? {} : { pinned: options.pin }),
    repeat,
    cases: Object.freeze(results),
    totals: totalsOf(results),
  });
}
