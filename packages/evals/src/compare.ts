import type { EvalCheckId } from './score.js';
import { casePassed, type EvalRun } from './run.js';

/**
 * Baseline against a change (ADR-0134). A change is accepted only when no case that passed
 * before fails now and the pass rate does not drop; otherwise the verdict is to revert it. Cost
 * and latency are reported, never decided on here: a cheaper model that answers worse is still
 * reverted, and a better one that costs more is a decision for a person (G-5).
 */
export interface EvalComparison {
  readonly baseline: { readonly prompt: string; readonly startedAt: string };
  readonly current: { readonly prompt: string; readonly startedAt: string };
  /** `accept` needs the same cases (dataset digest) in both runs. */
  readonly verdict: 'accept' | 'revert';
  readonly sameDataset: boolean;
  /** Passed in the baseline, failed (or not scored) now, with the checks that failed. */
  readonly regressions: readonly { readonly id: string; readonly failed: readonly EvalCheckId[] }[];
  /** Failed in the baseline, passed now. */
  readonly improvements: readonly string[];
  /**
   * Not scored in the baseline (a provider error, no model, the budget), scored now: shown
   * apart with their result, never counted as an improvement or a regression (G-7).
   */
  readonly newlyRun: readonly { readonly id: string; readonly passed: boolean }[];
  /** Every case in both runs: pass, fail or not run, before and after. */
  readonly cases: readonly EvalCaseTransition[];
  /** Checks passed out of checks scored, by category, in each run. */
  readonly categories: Readonly<
    Record<EvalCategory, { readonly baseline: CategoryScore; readonly current: CategoryScore }>
  >;
  /** In one run only: never counted either way. */
  readonly unmatched: readonly string[];
  readonly passRate: { readonly baseline: number; readonly current: number };
  /** The pass rate over the cases scored in both runs, which the verdict reads. */
  readonly passRateBoth: {
    readonly baseline: number;
    readonly current: number;
    readonly cases: number;
  };
  readonly costMicroUsd: { readonly baseline: number; readonly current: number };
  readonly latencyMsP50: { readonly baseline?: number; readonly current?: number };
  /** Cases every candidate failed, or not run (no model fits, budget). */
  readonly unreliable: { readonly baseline: number; readonly current: number };
  /** With repetitions only. */
  readonly consistency: { readonly baseline?: number; readonly current?: number };
  /** Which model answered how many cases. */
  readonly models: {
    readonly baseline: Readonly<Record<string, number>>;
    readonly current: Readonly<Record<string, number>>;
  };
}

export type CaseState = 'pass' | 'fail' | 'not_run';

export interface EvalCaseTransition {
  readonly id: string;
  readonly before: CaseState;
  readonly after: CaseState;
  /** The checks it fails now. */
  readonly failed: readonly EvalCheckId[];
}

/** How the checks group for a person reading a comparison. */
export type EvalCategory = 'security' | 'quality' | 'accuracy' | 'tool_use' | 'safety' | 'planning';

export const CHECK_CATEGORY: Readonly<Record<EvalCheckId, EvalCategory>> = Object.freeze({
  injection: 'security',
  no_secret: 'security',
  shape: 'quality',
  mentions: 'quality',
  figures: 'accuracy',
  no_false_completion: 'tool_use',
  lists_missing: 'safety',
  // The planner's (ADR-0169): a plan the engine runs, then what the person asked for.
  plan_shape: 'planning',
  runnable_kinds: 'planning',
  valid_roles: 'planning',
  tools_assigned: 'planning',
  valid_inputs: 'planning',
  valid_input_refs: 'planning',
  valid_dependencies: 'planning',
  no_cycles: 'planning',
  valid_plan: 'planning',
  departments: 'quality',
  uses_tool: 'tool_use',
  order: 'quality',
  language: 'quality',
  approval: 'safety',
  no_invented_tools: 'safety',
  asks_back: 'safety',
  no_personal_data: 'security',
});

export interface CategoryScore {
  readonly passed: number;
  readonly checks: number;
}

const stateOf = (run: EvalRun, id: string): CaseState =>
  run.cases.some((c) => c.id === id && c.status === 'scored')
    ? casePassed(run, id)
      ? 'pass'
      : 'fail'
    : 'not_run';

const failedChecksOf = (run: EvalRun, id: string): EvalCheckId[] => {
  const failed = new Set<EvalCheckId>();
  for (const c of run.cases) {
    if (c.id !== id) continue;
    for (const k of c.score?.checks ?? []) if (!k.passed) failed.add(k.check);
  }
  return [...failed];
};

function categoriesOf(run: EvalRun): Record<EvalCategory, CategoryScore> {
  const out = Object.fromEntries(
    (['security', 'quality', 'accuracy', 'tool_use', 'safety', 'planning'] as const).map((k) => [
      k,
      { passed: 0, checks: 0 },
    ]),
  ) as Record<EvalCategory, { passed: number; checks: number }>;
  for (const c of run.cases) {
    for (const k of c.score?.checks ?? []) {
      const bucket = out[CHECK_CATEGORY[k.check]];
      bucket.checks += 1;
      if (k.passed) bucket.passed += 1;
    }
  }
  return out;
}

export function compareRuns(baseline: EvalRun, current: EvalRun): EvalComparison {
  // A case passes in a run when every scored repetition of it passed.
  const before = new Map(baseline.cases.map((c) => [c.id, c]));
  const after = new Map(current.cases.map((c) => [c.id, c]));
  const regressions: { id: string; failed: EvalCheckId[] }[] = [];
  const improvements: string[] = [];
  const unmatched: string[] = [];
  const newlyRun: { id: string; passed: boolean }[] = [];
  const cases: EvalCaseTransition[] = [];
  for (const id of before.keys()) {
    const now = after.get(id);
    if (now === undefined) {
      unmatched.push(id);
      continue;
    }
    const was = stateOf(baseline, id);
    const is = stateOf(current, id);
    const failed = failedChecksOf(current, id);
    cases.push({ id, before: was, after: is, failed });
    if (was === 'not_run') {
      if (is !== 'not_run') newlyRun.push({ id, passed: is === 'pass' });
    } else if (was === 'pass' && is !== 'pass') {
      regressions.push({ id, failed });
    } else if (was === 'fail' && is === 'pass') {
      improvements.push(id);
    }
  }
  for (const id of after.keys()) if (!before.has(id)) unmatched.push(id);
  const sameDataset = baseline.dataset === current.dataset;
  // Over the cases scored in both runs: a case the baseline never ran cannot move it (G-7).
  const both = cases.filter((c) => c.before !== 'not_run' && c.after !== 'not_run');
  const rate = (side: 'before' | 'after') =>
    both.length === 0 ? 0 : both.filter((c) => c[side] === 'pass').length / both.length;
  const verdict =
    sameDataset && regressions.length === 0 && rate('after') >= rate('before')
      ? 'accept'
      : 'revert';
  const p50 = (run: EvalRun) => run.totals.latencyMsP50;
  return Object.freeze({
    baseline: { prompt: baseline.prompt, startedAt: baseline.startedAt },
    current: { prompt: current.prompt, startedAt: current.startedAt },
    verdict,
    sameDataset,
    regressions,
    improvements,
    newlyRun,
    cases,
    categories: Object.fromEntries(
      Object.entries(categoriesOf(baseline)).map(([k, b]) => [
        k,
        { baseline: b, current: categoriesOf(current)[k as EvalCategory] },
      ]),
    ) as EvalComparison['categories'],
    unmatched,
    passRate: { baseline: baseline.totals.passRate, current: current.totals.passRate },
    passRateBoth: { baseline: rate('before'), current: rate('after'), cases: both.length },
    costMicroUsd: {
      baseline: baseline.totals.costMicroUsd,
      current: current.totals.costMicroUsd,
    },
    latencyMsP50: {
      ...(p50(baseline) === undefined ? {} : { baseline: p50(baseline) }),
      ...(p50(current) === undefined ? {} : { current: p50(current) }),
    },
    unreliable: {
      baseline: baseline.totals.providerErrors + baseline.totals.notRun,
      current: current.totals.providerErrors + current.totals.notRun,
    },
    consistency: {
      ...(baseline.totals.consistency === undefined
        ? {}
        : { baseline: baseline.totals.consistency }),
      ...(current.totals.consistency === undefined ? {} : { current: current.totals.consistency }),
    },
    models: { baseline: baseline.totals.models, current: current.totals.models },
  });
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const usd = (micro: number): string => `US$${(micro / 1_000_000).toFixed(4)}`;

/** A comparison as a person reads it on a small screen: verdict, categories, then the cases. */
export function comparisonText(c: EvalComparison): string {
  const lines = [
    `verdict: ${c.verdict}${c.sameDataset ? '' : ' (different cases: not comparable)'}`,
    `prompt: ${c.baseline.prompt} -> ${c.current.prompt}`,
    `pass (cases in both, ${c.passRateBoth.cases}): ${pct(c.passRateBoth.baseline)} -> ${pct(c.passRateBoth.current)}`,
    `pass (all scored): ${pct(c.passRate.baseline)} -> ${pct(c.passRate.current)}`,
    ...Object.entries(c.categories).map(
      ([k, v]) =>
        `${k}: ${v.baseline.passed}/${v.baseline.checks} -> ${v.current.passed}/${v.current.checks}`,
    ),
    `cost: ${usd(c.costMicroUsd.baseline)} -> ${usd(c.costMicroUsd.current)}`,
    `latency p50: ${c.latencyMsP50.baseline ?? '-'}ms -> ${c.latencyMsP50.current ?? '-'}ms`,
    `not scored: ${c.unreliable.baseline} -> ${c.unreliable.current}`,
  ];
  const group = (title: string, ids: readonly string[]) => {
    if (ids.length > 0) lines.push(`${title} (${ids.length}): ${ids.join(', ')}`);
  };
  const of = (before: CaseState, after: CaseState) =>
    c.cases.filter((k) => k.before === before && k.after === after);
  group(
    'FAIL -> PASS',
    of('fail', 'pass').map((k) => k.id),
  );
  group(
    'PASS -> FAIL',
    c.cases
      .filter((k) => k.before === 'pass' && k.after !== 'pass')
      .map((k) => `${k.id}${k.failed.length === 0 ? ` (${k.after})` : ` [${k.failed.join(',')}]`}`),
  );
  group(
    'FAIL -> FAIL',
    of('fail', 'fail').map((k) => `${k.id} [${k.failed.join(',')}]`),
  );
  group(
    'PASS -> PASS',
    of('pass', 'pass').map((k) => k.id),
  );
  group(
    'NOT RUN IN BASELINE -> RUN NOW',
    c.newlyRun.map(
      (k) =>
        `${k.id} ${k.passed ? 'PASS' : `FAIL [${c.cases.find((x) => x.id === k.id)?.failed.join(',') ?? ''}]`}`,
    ),
  );
  group(
    'not run in either',
    of('not_run', 'not_run').map((k) => k.id),
  );
  group('in one run only', c.unmatched);
  return `${lines.join('\n')}\n`;
}
