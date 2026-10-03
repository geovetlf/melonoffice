import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TASK_PROMPT } from '@melonoffice/agents';
import { promptLabel } from '@melonoffice/ai-gateway';
import { DEEPSEEK_MODELS, DEEPSEEK_PROVIDER } from '@melonoffice/ai-deepseek';
import { NVIDIA_MODELS, NVIDIA_PROVIDER } from '@melonoffice/ai-nvidia';
import { VERTEX_AI_MODELS, VERTEX_AI_PROVIDER } from '@melonoffice/ai-vertex';
import { describe, expect, it } from 'vitest';
import { EVAL_CASES } from './cases.js';
import {
  modelGate,
  modelsOutsideDev,
  reportFileOf,
  reportOf,
  type ModelEvalReport,
} from './gate.js';
import { datasetDigest, totalsOf, type EvalCaseResult, type EvalRun } from './run.js';

/** The agent task prompt as it reads now: a report on another version is stale. */
const CURRENT_PROMPT = promptLabel(AGENT_TASK_PROMPT);

/**
 * The model gate (G-5, ADR-0135): every model a provider catalogue lets run outside DEV needs a
 * current, passing eval report in `docs/evals/reports/`.
 */

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/evals/reports');

const committed = (): ModelEvalReport[] =>
  readdirSync(REPORTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(REPORTS, f), 'utf8')) as ModelEvalReport);

const PROVIDERS = [VERTEX_AI_PROVIDER, DEEPSEEK_PROVIDER, NVIDIA_PROVIDER];
const MODELS = [...VERTEX_AI_MODELS, ...DEEPSEEK_MODELS, ...NVIDIA_MODELS];

describe('the model gate over the real catalogues', () => {
  it('lets no model serve agents outside DEV without a current, passing eval report', () => {
    expect(modelGate({ providers: PROVIDERS, models: MODELS, reports: committed() })).toEqual([]);
  });

  it('keeps each committed report under its model’s file name', () => {
    for (const f of readdirSync(REPORTS).filter((n) => n.endsWith('.json'))) {
      const report = JSON.parse(readFileSync(join(REPORTS, f), 'utf8')) as ModelEvalReport;
      expect(reportFileOf(report.model)).toBe(f);
    }
  });
});

// ---------------------------------------------------------------------------------------------

const gemini = VERTEX_AI_MODELS[0];
if (gemini === undefined) throw new Error('no Vertex AI model');
const key = `${gemini.providerId}/${gemini.modelId}@${gemini.version}`;
const inProd = { ...gemini, environments: ['dev', 'prod'] as const };
const providerInProd = { ...VERTEX_AI_PROVIDER, environments: ['dev', 'prod'] as const };

const runOf = (passed: number, extra: Partial<EvalRun> = {}): EvalRun => {
  const cases: EvalCaseResult[] = EVAL_CASES.map((c, i) => ({
    id: c.id,
    suite: c.suite,
    status: 'scored',
    model: key,
    latencyMs: 300,
    costMicroUsd: 200,
    score: { passed: i < passed, checks: [{ check: 'shape', passed: true }] },
  }));
  return {
    format: 1,
    prompt: CURRENT_PROMPT,
    policy: 'agent_task@2',
    environment: 'dev',
    startedAt: '2026-10-03T21:00:00.000Z',
    budgetCredits: 70,
    dataset: datasetDigest(EVAL_CASES),
    pinned: `${gemini.providerId}/${gemini.modelId}`,
    repeat: 1,
    cases,
    totals: totalsOf(cases),
    ...extra,
  };
};

const reportFrom = (run: EvalRun): ModelEvalReport => {
  const r = reportOf(run);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('the model gate', () => {
  it('counts a model outside DEV only when both it and its provider may run there', () => {
    expect(modelsOutsideDev(PROVIDERS, MODELS)).toEqual([]);
    expect(modelsOutsideDev([VERTEX_AI_PROVIDER], [inProd])).toEqual([]);
    expect(modelsOutsideDev([providerInProd], [inProd])).toEqual([key]);
  });

  it('fails a model allowed in production with no report', () => {
    expect(modelGate({ providers: [providerInProd], models: [inProd], reports: [] })).toEqual([
      { model: key, problem: 'no_report' },
    ]);
  });

  it('passes it with a current report of at least 90%, and says why one does not count', () => {
    const gate = (report: ModelEvalReport) =>
      modelGate({ providers: [providerInProd], models: [inProd], reports: [report] });
    const all = EVAL_CASES.length;
    expect(gate(reportFrom(runOf(all)))).toEqual([]);
    expect(gate(reportFrom(runOf(Math.ceil(all * 0.9))))).toEqual([]);
    expect(gate(reportFrom(runOf(Math.floor(all * 0.9) - 1)))).toEqual([
      { model: key, problem: 'below_threshold' },
    ]);
    expect(gate({ ...reportFrom(runOf(all)), prompt: 'agent_task@0' })).toEqual([
      { model: key, problem: 'stale_prompt' },
    ]);
    expect(gate({ ...reportFrom(runOf(all)), dataset: 'other' })).toEqual([
      { model: key, problem: 'stale_dataset' },
    ]);
    expect(gate({ ...reportFrom(runOf(all)), scored: all - 1 })).toEqual([
      { model: key, problem: 'incomplete' },
    ]);
  });

  it('makes a report only from a run held to one model', () => {
    const free: EvalRun = { ...runOf(1) };
    delete (free as { pinned?: string }).pinned;
    expect(reportOf(free)).toEqual({ error: 'not_pinned' });
    expect(reportFrom(runOf(EVAL_CASES.length))).toMatchObject({
      model: key,
      prompt: CURRENT_PROMPT,
      passRate: 1,
      cases: EVAL_CASES.length,
      costMicroUsd: 200 * EVAL_CASES.length,
    });
    expect(reportFileOf(key)).toBe(`google-vertex-ai__${gemini.modelId}@${gemini.version}.json`);
  });
});
