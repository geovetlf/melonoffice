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

```sh
node packages/evals/dist/cli.js compare ~/evals/baseline.json ~/evals/current.json
```

The verdict is `accept` (exit code 0) only when no case that passed before fails now and the pass rate did not drop. Otherwise it is `revert` (exit code 1). Cost and latency are reported next to it.

## Model reports and the model gate

A model may serve agents outside DEV only with a passing report in [reports/](reports/README.md). CI enforces this.
