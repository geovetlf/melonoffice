#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { EVAL_CASES, EVAL_SUITES, type EvalSuiteId } from './cases.js';
import { compareRuns } from './compare.js';
import { devVertexRegistry, EVAL_MAX_BUDGET_CREDITS, evalTaskPolicy } from './dev.js';
import { runEvals, type EvalRun } from './run.js';

/**
 * The eval command (ADR-0134), run by a person in Cloud Shell against DEV:
 *
 *   EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     pnpm --filter @melonoffice/evals eval:dev -- --out baseline.json
 *   pnpm --filter @melonoffice/evals eval:compare -- baseline.json current.json
 *
 * `run` options: `--out <file>` (required), `--budget <credits>` (default and most: 70),
 * `--suite <id>` (repeatable; default every suite).
 */

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

function flags(args: readonly string[]) {
  const out: { out?: string; budget?: number; suites: EvalSuiteId[]; rest: string[] } = {
    suites: [],
    rest: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => args[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--out') out.out = value();
    else if (arg === '--budget') out.budget = Number(value());
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
  const cases =
    given.suites.length === 0
      ? EVAL_CASES
      : EVAL_CASES.filter((c) => given.suites.includes(c.suite));
  const result = await runEvals({
    cases,
    registry: devVertexRegistry(token as string),
    policy: evalTaskPolicy(),
    environment: 'dev',
    budgetCredits: budget,
    onCase: (c) =>
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
  });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const t = result.totals;
  process.stdout.write(
    `${result.prompt} · ${t.passed}/${t.scored} passed (${Math.round(t.passRate * 100)}%) · ` +
      `${t.credits} credits (US$${(t.costMicroUsd / 1_000_000).toFixed(4)}) · ` +
      `p50 ${t.latencyMsP50 ?? '-'}ms · ${Object.keys(t.models).join(', ')} → ${out}\n`,
  );
}

function compare(args: readonly string[]): void {
  const [baseline, current] = flags(args).rest;
  if (baseline === undefined || current === undefined)
    fail('compare <baseline.json> <current.json>');
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as EvalRun;
  const result = compareRuns(read(baseline as string), read(current as string));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verdict === 'accept' ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') await run(rest);
else if (command === 'compare') compare(rest);
else fail('usage: cli.js run --out <file> [--budget <credits>] [--suite <id>] | compare <a> <b>');
