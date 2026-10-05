#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_CASES, EVAL_SUITES, type EvalSuiteId } from './cases.js';
import { compareRuns, comparisonText } from './compare.js';
import { devVertexRegistry, EVAL_MAX_BUDGET_CREDITS, evalTaskPolicy } from './dev.js';
import { reportFileOf, reportOf } from './gate.js';
import {
  PLANNER_EVAL,
  PLANNER_EVAL_CASES,
  PLANNER_V1_EVAL,
  PLANNER_V2_EVAL,
  PLANNER_V3_EVAL,
  plannerComparisonText,
} from './planner.js';
import { MAX_EVAL_REPEAT, runEvals, type EvalCaseResult, type EvalRun } from './run.js';

/**
 * The eval command (ADR-0134), run by a person in Cloud Shell against DEV:
 *
 *   EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     pnpm --filter @melonoffice/evals eval:dev -- --out baseline.json
 *   pnpm --filter @melonoffice/evals eval:compare -- baseline.json current.json
 *   node dist/cli.js report run.json   (a run held to one model → docs/evals/reports/, G-5)
 *
 * `run` options: `--out <file>` (required), `--budget <credits>` (default and most: 70),
 * `--set planner` (the planner's cases, ADR-0169, instead of the agents'), `--prompt 1|2|3` with it
 * (an earlier `plan_proposal` again, to compare with @4 under the same scoring, ADR-0171, ADR-0172),
 * `--suite <id>` (repeatable; default every suite), `--model <provider/model>` (a variant held
 * to one model), `--repeat <n>` (1 to 5, for consistency).
 */

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

function flags(args: readonly string[]) {
  const out: {
    out?: string;
    budget?: number;
    model?: string;
    repeat?: number;
    dir?: string;
    set?: string;
    prompt?: string;
    suites: EvalSuiteId[];
    rest: string[];
  } = {
    suites: [],
    rest: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => args[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--out') out.out = value();
    else if (arg === '--budget') out.budget = Number(value());
    else if (arg === '--model') out.model = value();
    else if (arg === '--repeat') out.repeat = Number(value());
    else if (arg === '--dir') out.dir = value();
    else if (arg === '--set') out.set = value();
    else if (arg === '--prompt') out.prompt = value();
    else if (arg === '--suite') {
      const suite = value();
      if (!EVAL_SUITES.includes(suite as EvalSuiteId)) fail(`unknown suite ${suite}`);
      out.suites.push(suite as EvalSuiteId);
    } else if (arg !== undefined && arg !== '--') out.rest.push(arg);
  }
  return out;
}

async function run(args: readonly string[]): Promise<void> {
  const given = flags(args);
  const token = process.env.EVAL_ACCESS_TOKEN?.trim();
  if (token === undefined || token === '') {
    fail('EVAL_ACCESS_TOKEN is not set: EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token)');
  }
  const out = given.out ?? fail('--out <file> is required');
  const budget = given.budget ?? EVAL_MAX_BUDGET_CREDITS;
  if (!Number.isFinite(budget) || budget <= 0 || budget > EVAL_MAX_BUDGET_CREDITS) {
    fail(`--budget must be more than 0 and at most ${EVAL_MAX_BUDGET_CREDITS} credits`);
  }
  if (
    given.repeat !== undefined &&
    (!Number.isInteger(given.repeat) || given.repeat < 1 || given.repeat > MAX_EVAL_REPEAT)
  ) {
    fail(`--repeat must be 1 to ${MAX_EVAL_REPEAT}`);
  }
  if (given.set !== undefined && given.set !== 'agents' && given.set !== 'planner') {
    fail('--set must be agents (the default) or planner');
  }
  if (
    given.prompt !== undefined &&
    (given.set !== 'planner' || !['1', '2', '3', '4'].includes(given.prompt))
  ) {
    fail('--prompt is 1, 2, 3 or 4 (the default), with --set planner');
  }
  const cases =
    given.suites.length === 0
      ? EVAL_CASES
      : EVAL_CASES.filter((c) => given.suites.includes(c.suite));
  const common = {
    registry: devVertexRegistry(token as string),
    // The planner's call runs under the agent's own policy (agent_task@2), as the agent tasks do.
    policy: evalTaskPolicy(),
    environment: 'dev' as const,
    budgetCredits: budget,
    ...(given.model === undefined ? {} : { pin: given.model }),
    ...(given.repeat === undefined ? {} : { repeat: given.repeat }),
    onCase: (c: EvalCaseResult) =>
      process.stderr.write(
        `${c.score?.passed === true ? 'PASS' : c.status === 'scored' ? 'FAIL' : c.status.toUpperCase()} ${c.id}` +
          `${c.model === undefined ? '' : ` ${c.model}`}${c.latencyMs === undefined ? '' : ` ${c.latencyMs}ms`}` +
          `${
            c.score === undefined
              ? ''
              : ` ${c.score.checks
                  .filter((k) => !k.passed)
                  .map((k) => k.check)
                  .join(',')}`
          }\n`,
      ),
  };
  const result =
    given.set === 'planner'
      ? await runEvals(
          { ...common, cases: PLANNER_EVAL_CASES },
          given.prompt === '1'
            ? PLANNER_V1_EVAL
            : given.prompt === '2'
              ? PLANNER_V2_EVAL
              : given.prompt === '3'
                ? PLANNER_V3_EVAL
                : PLANNER_EVAL,
        )
      : await runEvals({ ...common, cases });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const t = result.totals;
  process.stdout.write(
    `${result.prompt} · ${t.passed}/${t.scored} passed (${Math.round(t.passRate * 100)}%) · ` +
      `${t.credits} credits (US$${(t.costMicroUsd / 1_000_000).toFixed(4)}) · ` +
      `p50 ${t.latencyMsP50 ?? '-'}ms · ${Object.keys(t.models).join(', ')} → ${out}\n`,
  );
}

function compare(args: readonly string[]): void {
  const given = flags(args);
  const [baseline, current] = given.rest;
  if (baseline === undefined || current === undefined)
    fail('compare <baseline.json> <current.json> [--out <comparison.json>]');
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as EvalRun;
  const result = compareRuns(read(baseline as string), read(current as string));
  if (given.out !== undefined) writeFileSync(given.out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(comparisonText(result));
  // Two planner runs (ADR-0171): each check, outcome and language side by side, and each case.
  const [before, after] = [read(baseline as string), read(current as string)];
  if (before.prompt.startsWith('plan_proposal@') && after.prompt.startsWith('plan_proposal@')) {
    process.stdout.write(`\n${plannerComparisonText(before, after)}`);
  }
  process.exitCode = result.verdict === 'accept' ? 0 : 1;
}

function report(args: readonly string[]): void {
  const given = flags(args);
  const [file] = given.rest;
  if (file === undefined) fail('report <run.json> [--dir <reports directory>]');
  const result = reportOf(JSON.parse(readFileSync(file as string, 'utf8')) as EvalRun);
  if ('error' in result) fail(`not a report: ${result.error} (run with --model <provider/model>)`);
  const dir = given.dir ?? 'docs/evals/reports';
  mkdirSync(dir, { recursive: true });
  const ok = result as Exclude<typeof result, { error: string }>;
  const path = join(dir, reportFileOf(ok.model));
  writeFileSync(path, `${JSON.stringify(ok, null, 2)}\n`);
  process.stdout.write(`${ok.model} · ${Math.round(ok.passRate * 100)}% → ${path}\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') await run(rest);
else if (command === 'compare') compare(rest);
else if (command === 'report') report(rest);
else fail('usage: cli.js run --out <file> [options] | compare <a> <b> | report <run.json>');
