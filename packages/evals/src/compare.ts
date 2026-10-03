import type { EvalCheckId } from './score.js';
import type { EvalRun } from './run.js';

/**
 * Baseline against a change (ADR-0134). A change is accepted only when no case that passed
 * before fails now and the pass rate does not drop; otherwise the verdict is to revert it. Cost
 * and latency are reported, never decided on here: a cheaper model that answers worse is still
 * reverted, and a better one that costs more is a decision for a person (G-5).
 */
export interface EvalComparison {
  readonly baseline: { readonly prompt: string; readonly startedAt: string };
  readonly current: { readonly prompt: string; readonly startedAt: string };
  readonly verdict: 'accept' | 'revert';
  /** Passed in the baseline, failed (or not scored) now, with the checks that failed. */
  readonly regressions: readonly { readonly id: string; readonly failed: readonly EvalCheckId[] }[];
  /** Failed in the baseline, passed now. */
  readonly improvements: readonly string[];
  /** In one run only: never counted either way. */
  readonly unmatched: readonly string[];
  readonly passRate: { readonly baseline: number; readonly current: number };
  readonly costMicroUsd: { readonly baseline: number; readonly current: number };
  readonly latencyMsP50: { readonly baseline?: number; readonly current?: number };
}

export function compareRuns(baseline: EvalRun, current: EvalRun): EvalComparison {
  const before = new Map(baseline.cases.map((c) => [c.id, c]));
  const after = new Map(current.cases.map((c) => [c.id, c]));
  const regressions: { id: string; failed: EvalCheckId[] }[] = [];
  const improvements: string[] = [];
  const unmatched: string[] = [];
  for (const [id, was] of before) {
    const now = after.get(id);
    if (now === undefined) {
      unmatched.push(id);
      continue;
    }
    const passedBefore = was.score?.passed === true;
    const passedNow = now.score?.passed === true;
    if (passedBefore && !passedNow) {
      regressions.push({
        id,
        failed: (now.score?.checks ?? []).filter((k) => !k.passed).map((k) => k.check),
      });
    } else if (!passedBefore && passedNow) {
      improvements.push(id);
    }
  }
  for (const id of after.keys()) if (!before.has(id)) unmatched.push(id);
  const verdict =
    regressions.length === 0 && current.totals.passRate >= baseline.totals.passRate
      ? 'accept'
      : 'revert';
  const p50 = (run: EvalRun) => run.totals.latencyMsP50;
  return Object.freeze({
    baseline: { prompt: baseline.prompt, startedAt: baseline.startedAt },
    current: { prompt: current.prompt, startedAt: current.startedAt },
    verdict,
    regressions,
    improvements,
    unmatched,
    passRate: { baseline: baseline.totals.passRate, current: current.totals.passRate },
    costMicroUsd: {
      baseline: baseline.totals.costMicroUsd,
      current: current.totals.costMicroUsd,
    },
    latencyMsP50: {
      ...(p50(baseline) === undefined ? {} : { baseline: p50(baseline) }),
      ...(p50(current) === undefined ? {} : { current: p50(current) }),
    },
  });
}
