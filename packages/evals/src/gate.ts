import { AGENT_TASK_PROMPT } from '@melonoffice/agents';
import { promptLabel } from '@melonoffice/ai-gateway';
import type {
  AIModelDefinition,
  AIProviderDefinition,
  DeploymentEnvironment,
} from '@melonoffice/domain';
import { EVAL_CASES } from './cases.js';
import { datasetDigest, type EvalRun } from './run.js';

/**
 * The model gate (G-5, ADR-0135): no model may serve agents outside DEV without a current eval
 * report that passes. A CI test applies it to every provider catalogue, so a change that lets a
 * model run in staging or production fails until its report is committed next to it.
 */

/** The share of cases a model must pass. A technical default (ADR-0135), changed by a person. */
export const MODEL_GATE_MIN_PASS_RATE = 0.9;

/** What is kept of a run of one model: committed in `docs/evals/reports/`. */
export interface ModelEvalReport {
  readonly format: 1;
  /** `provider/model@version`. */
  readonly model: string;
  readonly prompt: string;
  readonly policy: string;
  readonly dataset: string;
  readonly ranAt: string;
  readonly cases: number;
  readonly scored: number;
  readonly passed: number;
  readonly passRate: number;
  readonly costMicroUsd: number;
  readonly latencyMsP50?: number;
  readonly consistency?: number;
}

/** The report of a run held to one model (`--model`), or why it cannot be one. */
export function reportOf(run: EvalRun): ModelEvalReport | { readonly error: string } {
  if (run.pinned === undefined) return { error: 'not_pinned' };
  const answered = new Set(
    run.cases.flatMap((c) => (c.status === 'scored' && c.model !== undefined ? [c.model] : [])),
  );
  const [model] = [...answered];
  if (answered.size !== 1 || model === undefined) return { error: 'not_one_model' };
  const t = run.totals;
  return Object.freeze({
    format: 1,
    model,
    prompt: run.prompt,
    policy: run.policy,
    dataset: run.dataset,
    ranAt: run.startedAt,
    cases: t.cases,
    scored: t.scored,
    passed: t.passed,
    passRate: t.passRate,
    costMicroUsd: t.costMicroUsd,
    ...(t.latencyMsP50 === undefined ? {} : { latencyMsP50: t.latencyMsP50 }),
    ...(t.consistency === undefined ? {} : { consistency: t.consistency }),
  });
}

/** The file name of a model's report: `provider__model@version.json`. */
export const reportFileOf = (model: string): string => `${model.replace('/', '__')}.json`;

const OUTSIDE_DEV: readonly DeploymentEnvironment[] = ['staging', 'prod'];

/** The models, `provider/model@version`, that may run outside DEV: model and provider both allow it. */
export function modelsOutsideDev(
  providers: readonly AIProviderDefinition[],
  models: readonly AIModelDefinition[],
): readonly string[] {
  return models
    .filter((m) => {
      const provider = providers.find((p) => p.id === m.providerId);
      return OUTSIDE_DEV.some(
        (env) => m.environments.includes(env) && provider?.environments.includes(env) === true,
      );
    })
    .map((m) => `${m.providerId}/${m.modelId}@${m.version}`);
}

export type GateProblem =
  | 'no_report'
  /** Run with another version of the agent task prompt. */
  | 'stale_prompt'
  /** Run with other cases. */
  | 'stale_dataset'
  /** Not every case was answered by the model. */
  | 'incomplete'
  | 'below_threshold';

/** Each model that may run outside DEV and what keeps it from passing the gate; empty: it passes. */
export function modelGate(input: {
  readonly providers: readonly AIProviderDefinition[];
  readonly models: readonly AIModelDefinition[];
  readonly reports: readonly ModelEvalReport[];
}): readonly { readonly model: string; readonly problem: GateProblem }[] {
  const prompt = promptLabel(AGENT_TASK_PROMPT);
  const dataset = datasetDigest(EVAL_CASES);
  return modelsOutsideDev(input.providers, input.models).flatMap((model) => {
    const report = input.reports.find((r) => r.model === model);
    const problem: GateProblem | undefined =
      report === undefined
        ? 'no_report'
        : report.prompt !== prompt
          ? 'stale_prompt'
          : report.dataset !== dataset
            ? 'stale_dataset'
            : report.scored < EVAL_CASES.length
              ? 'incomplete'
              : report.passRate < MODEL_GATE_MIN_PASS_RATE
                ? 'below_threshold'
                : undefined;
    return problem === undefined ? [] : [{ model, problem }];
  });
}
