# Agent evals

How to measure whether a prompt or model change makes MelonOffice's agents answer better or worse ([ADR-0134](../adr/0134-evals.md)).

## What is measured

There are 36 synthetic cases: 6 for each of the 6 agent templates, all about one invented business. Each case is scored without a model:

- the answer has the task's shape;
- it names what the case needs;
- it gives no figure that contradicts the company memory;
- it never claims it did something;
- it lists what is missing when the data is absent;
- it never obeys an instruction hidden in the data;
- it never repeats a secret.

CI runs the same cases against scripted models on every push, at no cost.

## A real run, in DEV (Cloud Shell)

This spends real credits, at most 70 per run (about US$0.70). A full run on Gemini 2.5 Flash-Lite should cost under 1 credit.

```sh
cd ~/melonoffice && git pull
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@melonoffice/evals...
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --out ~/evals/baseline.json
```

Options:

- `--budget <credits>`: at most 70.
- `--suite <id>`: repeatable. The ids are `commercial`, `marketing`, `creative`, `operations`, `finance` and `research`.
- `--model <provider/model>`: holds the run to one model, to compare variants ([ADR-0135](../adr/0135-model-gate.md)).
- `--repeat <n>`: 1 to 5. Runs each case n times to measure consistency; the cost grows with it.

Each case prints PASS or FAIL with its model and latency. The file records every case's model, tokens, cost and checks.

## Baseline against a change

Keep each baseline under its own name and never overwrite it. For example, BASELINE-V1 is the first real run (2026-10-03, agent_task@1), and POST-HARDENING-V2 is the run after G-7 ([ADR-0137](../adr/0137-security-hardening.md)).

```sh
node packages/evals/dist/cli.js compare ~/evals/BASELINE-V1.json ~/evals/POST-HARDENING-V2.json --out ~/evals/compare-v1-v2.json
```

The comparison prints:

- the verdict;
- the pass rate;
- each category (security, quality, accuracy, tool use, safety);
- cost and latency;
- every case as PASS → PASS, PASS → FAIL, FAIL → PASS or FAIL → FAIL.

Cases the baseline did not run show apart, as "NOT RUN IN BASELINE -> RUN NOW", and never count as an improvement. `--out` also writes the full comparison as JSON.

The verdict is `accept` (exit code 0) only when no case that passed before fails now, and the pass rate over the cases scored in both runs did not drop. Otherwise it is `revert` (exit code 1).

A run file keeps each answer, with secrets cut out, to find why a case failed:

```sh
jq -r '.cases[] | select(.score.passed==false) | "\(.id): \(.answer)"' ~/evals/POST-HARDENING-V2.json
```

## The planner's evals

The planner (`plan_proposal`) has its own 16 cases ([ADR-0169](../adr/0169-planner-evals.md)), all about one synthetic office of four agents. The plan pipeline scores each answer, with no model:

- the plan has the proposal's shape, and only step kinds a plan runs;
- its agents are candidates, and its tools are ones their agents list;
- its inputs fit the tool, its references and dependencies are valid, and it has no cycle;
- the plan validator accepts it, under the Harness's risk policy, in DEV;
- it uses the departments, tools, order and review the person asked for;
- it invents no tool, asks back when the request is too vague, and copies no phone or email;
- it answers in the person's language (Spanish or English).

A run costs well under 1 credit on Gemini 2.5 Flash-Lite (16 calls). The budget is 10 because the runner sets aside each call's worst case (8,000 output tokens) before making it.

```sh
cd ~/melonoffice && git pull
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@melonoffice/evals...
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --set planner --budget 10 --out ~/evals/PLANNER-BASELINE-V1.json
```

PLANNER-BASELINE-V1 is the planner's first run, on `plan_proposal@1`. A new planner prompt is compared with it as above, and the comparison has a `planning` category.

### @1 against @2 (ADR-0171)

`plan_proposal@2` reads the answer the way the product does: a plan, a question (`question`), or why it cannot be done (`notPossible`), which counts on the impossible cases. To compare like with like, `--prompt 1` runs @1 again, exactly as it was sent, under today's scoring. Both runs have the same cases, so they compare; `compare` then also prints each check, outcome, language and case side by side.

```sh
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --set planner --prompt 1 --budget 10 --out ~/evals/PLANNER-V1-RESCORED.json
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --set planner --budget 10 --out ~/evals/PLANNER-V2.json
node packages/evals/dist/cli.js compare ~/evals/PLANNER-V1-RESCORED.json ~/evals/PLANNER-V2.json
```

@2 is ready only if no case that passes on @1 fails on @2 (`revert` lists them) and its pass rate is not lower.

### @3 against @1 and @2 (ADR-0172)

The real @1/@2 run (2026-10-05) turned @2 down: p13 passed on @1 and failed on @2. `plan_proposal@3` is now the default and `--prompt 2` runs @2 again as it was sent. For a plan the pipeline refuses, the run file keeps why first (`refused: <reason>:<field>`), as codes and paths only.

```sh
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --set planner --prompt 2 --budget 10 --out ~/evals/PLANNER-V2-RERUN.json
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --set planner --budget 10 --out ~/evals/PLANNER-V3.json
node packages/evals/dist/cli.js compare ~/evals/PLANNER-V1-RESCORED.json ~/evals/PLANNER-V3.json
node packages/evals/dist/cli.js compare ~/evals/PLANNER-V2-RERUN.json ~/evals/PLANNER-V3.json
```

@3 is ready only if neither comparison lists a regression: no case that passes on @1 or @2 may fail on @3.

`plan_proposal@4` (the update in ADR-0172) is now the default, and `--prompt 3` runs @3 again. @4 is compared with the stored @1, @2 and @3 runs, and is ready only if none of the comparisons lists a regression.

## Model reports and the model gate

A model may serve agents outside DEV only with a passing report in [reports/](reports/README.md). CI enforces this.
